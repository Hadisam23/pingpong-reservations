const express = require('express');
const path = require('path');
const { openDb } = require('./db');
const { createService, ApiError, safeEqual } = require('./service');
const { createAuth } = require('./auth');
const { createMailer } = require('./mailer');
const QRCode = require('qrcode');
const { createPricing } = require('./pricing');
const { createPayments } = require('./payments');
const { createCheckIn } = require('./checkin');
const { createNotifier } = require('./notify');
const { createReservations } = require('./reservations');
const { createLessons } = require('./lessons');
const { createMemberships } = require('./memberships');
const { createAdmin } = require('./admin');
const { toIcs } = require('./ics');

// Origins the Capacitor app runs on (iOS: capacitor://localhost, Android: http(s)://localhost).
const APP_ORIGINS = ['capacitor://localhost', 'ionic://localhost', 'http://localhost', 'https://localhost'];

const SESSION_COOKIE = 'rc_session';

function createApp({
  dbFile = ':memory:', adminPassword = null, baseUrl = null, corsOrigins = [], now, mailer = createMailer({ log: false }),
  stripeKey = null, stripeWebhookSecret = null, fetchImpl,
} = {}) {
  const db = openDb(dbFile);
  const service = createService(db, { now });
  const auth = createAuth(db, { mailer, now });
  const pricing = createPricing(db, service);
  const payments = createPayments(db, { stripeKey, webhookSecret: stripeWebhookSecret, fetchImpl, currency: () => service.getSettings().currency, now });
  const checkIn = createCheckIn(db);
  // Links in emails: BASE_URL, or the address the server was last reached on
  let seenUrl = null;
  const notifier = createNotifier(db, { mailer, now, baseUrl: () => baseUrl || seenUrl, centerName: () => service.getSettings().centerName });
  const reservations = createReservations(db, { service, pricing, payments, checkIn, notifier, now });
  const lessons = createLessons(db, { service, reservations, payments, notifier, now });
  const memberships = createMemberships(db, { payments, notifier, service, now });
  const staff = createAdmin(db, { service, reservations, lessons, notifier, now });
  const app = express();
  // Async route handlers: send rejections to the error handler
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.disable('x-powered-by');
  // Behind a local/private proxy (Railway, ngrok) trust X-Forwarded-* for req.ip and req.secure
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  // Stripe signs the raw body, so this route reads it before the JSON parser does
  app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
    res.json(await payments.handleWebhook(req.body.toString('utf8'), req.get('stripe-signature')));
  }));
  app.use(express.json({ limit: '50kb' }));

  const allowedOrigins = new Set([...APP_ORIGINS, ...corsOrigins]);
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowedOrigins.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'content-type, authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });

  const publicUrl = req => baseUrl || `${req.protocol}://${req.get('host')}`;
  app.use((req, res, next) => {
    if (!baseUrl && req.get('host')) seenUrl = `${req.protocol}://${req.get('host')}`;
    next();
  });
  const manageUrl = (req, code, token) => `${publicUrl(req)}/manage?code=${code}&t=${encodeURIComponent(token)}`;

  // ---------- public API ----------

  const api = express.Router();

  api.get('/config', (req, res) => {
    const s = service.getSettings();
    res.json({
      centerName: s.centerName,
      timezone: s.timezone,
      currency: s.currency,
      slotMinutes: s.slotMinutes,
      durations: s.durations,
      maxAdvanceDays: s.maxAdvanceDays,
      cancelCutoffMinutes: s.cancelCutoffMinutes,
      maxPlayersPerTable: s.maxPlayersPerTable,
      hours: s.hours,
      pricing: s.pricing,
      bookingTypes: s.bookingTypes,
      today: service.today().date,
      payments: { provider: payments.provider, testCard: payments.provider === 'demo' ? payments.TEST_CARD : null },
    });
  });

  api.get('/availability', (req, res) => {
    res.json(service.getAvailability(req.query.date));
  });

  api.post('/bookings', (req, res) => {
    const { booking, manageToken } = service.createBooking(req.body);
    res.status(201).json({ booking, manageToken, manageUrl: manageUrl(req, booking.code, manageToken) });
  });

  api.get('/bookings/:code', (req, res) => {
    res.json(service.getBookingForCustomer(req.params.code, { token: req.query.token, phone: req.query.phone }));
  });

  api.post('/bookings/:code/cancel', (req, res) => {
    res.json(service.cancelByCustomer(req.params.code, { token: req.body.token, phone: req.body.phone }));
  });

  // ---------- accounts ----------
  // The website uses an HttpOnly cookie. The iOS app runs on another origin and can't share
  // that cookie, so it keeps the token from the response and sends it as a Bearer header.

  const readCookie = (req, name) => {
    const match = (req.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
  };
  const sessionToken = req => {
    const bearer = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    return bearer ? bearer[1] : readCookie(req, SESSION_COOKIE);
  };
  const setSessionCookie = (req, res, { token, expiresAt }) => {
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', expires: new Date(expiresAt) });
  };
  const requireUser = (req, res, next) => {
    req.user = auth.userForToken(sessionToken(req));
    if (!req.user) throw new ApiError(401, 'not_signed_in', 'Please log in to continue.');
    next();
  };
  const signedIn = (req, res, result, status = 200) => {
    setSessionCookie(req, res, result);
    res.status(status).json({ user: result.user, token: result.token });
  };

  const optionalUser = (req, res, next) => {
    req.user = auth.userForToken(sessionToken(req));
    next();
  };
  // A guest proves a booking is theirs with its manage token (query, body or header)
  const who = req => ({ user: req.user, token: req.query.token || (req.body && req.body.token) || req.get('x-booking-token') || null });

  // ---------- table booking (Phase 4) ----------

  api.get('/areas', (req, res) => res.json(reservations.areas()));
  api.get('/tables/availability', optionalUser, (req, res) => {
    res.json(reservations.availability({ ...req.query, user: req.user }));
  });
  api.get('/tables/free-today', optionalUser, (req, res) => res.json(reservations.freeToday({ user: req.user })));
  api.post('/holds', optionalUser, (req, res) => res.status(201).json(reservations.hold(req.body, { user: req.user })));
  api.get('/holds/:code', optionalUser, (req, res) => res.json(reservations.holdView(req.params.code, who(req))));
  api.post('/holds/:code/quote', optionalUser, (req, res) => res.json(reservations.quote(req.params.code, req.body, who(req))));
  api.post('/holds/:code/checkout', optionalUser, wrap(async (req, res) => {
    res.json(await reservations.checkout(req.params.code, req.body, { ...who(req), baseUrl: publicUrl(req) }));
  }));
  api.delete('/holds/:code', optionalUser, (req, res) => {
    reservations.release(req.params.code, who(req));
    res.status(204).end();
  });

  api.get('/notifications', requireUser, (req, res) => res.json(notifier.list(req.user.id)));
  api.get('/notifications/unread', requireUser, (req, res) => res.json({ count: notifier.unread(req.user.id) }));
  api.get('/notifications/settings', requireUser, (req, res) => res.json(notifier.prefs(req.user.id)));
  api.put('/notifications/settings', requireUser, (req, res) => res.json(notifier.setPrefs(req.user.id, req.body)));
  api.post('/notifications/read', requireUser, (req, res) => {
    notifier.readAll(req.user.id);
    res.status(204).end();
  });
  // ---------- lessons & classes (Phase 5) ----------

  api.get('/coaches', (req, res) => res.json(lessons.coaches({ level: req.query.level })));
  api.get('/coaches/:id', (req, res) => res.json(lessons.coachDetail(req.params.id)));
  api.get('/coaches/:id/slots', (req, res) => res.json(lessons.coachSlots(req.params.id, req.query)));
  api.post('/lessons/holds', requireUser, (req, res) => res.status(201).json(lessons.holdLesson(req.body, { user: req.user })));
  api.get('/classes', optionalUser, (req, res) => res.json(lessons.classes({ level: req.query.level, user: req.user })));
  api.post('/classes/:id/join', requireUser, (req, res) => res.status(201).json(lessons.join(req.params.id, { user: req.user })));
  api.post('/classes/:id/waitlist', requireUser, (req, res) => res.status(201).json(lessons.joinWaitlist(req.params.id, { user: req.user })));
  api.delete('/classes/:id/waitlist', requireUser, (req, res) => {
    lessons.leaveWaitlist(req.params.id, { user: req.user });
    res.status(204).end();
  });
  api.get('/lesson-packs', requireUser, (req, res) => res.json(lessons.packsView(req.user)));
  api.post('/lesson-packs', requireUser, wrap(async (req, res) => {
    res.json(await lessons.buyPack(req.body, { user: req.user, baseUrl: publicUrl(req) }));
  }));

  // Find a booking by code + phone/email (rate limited per address: it's a guessable pair)
  const findTries = new Map();
  api.post('/reservations/find', (req, res) => {
    const t = Date.now();
    const recent = (findTries.get(req.ip) || []).filter(at => t - at < 15 * 60000);
    if (recent.length >= 20) throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Wait 15 minutes and try again.');
    findTries.set(req.ip, [...recent, t]);
    res.json(reservations.find(req.body));
  });
  api.get('/my/bookings', requireUser, (req, res) => res.json(reservations.mine(req.user)));
  api.get('/reservations/:code', optionalUser, wrap(async (req, res) => {
    const booking = reservations.get(req.params.code, who(req));
    const qrSvg = booking.checkIn ? await QRCode.toString(booking.checkIn, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }) : null;
    res.json({ ...booking, qrSvg });
  }));
  api.post('/reservations/:code/cancel', optionalUser, wrap(async (req, res) => {
    res.json(await reservations.cancel(req.params.code, who(req)));
  }));
  api.post('/reservations/:code/reschedule', optionalUser, (req, res) => {
    res.json(reservations.reschedule(req.params.code, req.body, who(req)));
  });
  api.get('/reservations/:code/calendar.ics', optionalUser, (req, res) => {
    const b = reservations.get(req.params.code, who(req));
    const s = service.getSettings();
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="rally-club-${b.code}.ics"` });
    res.send(toIcs({
      uid: `${b.code}@rallyclub`, start: b.startsAt, end: b.endsAt, now: new Date().toISOString(),
      title: `${b.title} · ${s.centerName}`, location: `${s.centerName} · ${b.where}`,
      description: `Booking #RC-${b.code}. Show your QR code at the door to check in.`,
    }));
  });
  api.get('/shares/:token', (req, res) => res.json(reservations.shareView(req.params.token)));
  api.post('/shares/:token/pay', wrap(async (req, res) => {
    res.json(await reservations.payShare(req.params.token, { baseUrl: publicUrl(req) }));
  }));

  api.get('/plans', (req, res) => {
    const { currency } = service.getSettings();
    res.json(auth.plans().map(plan => ({ ...plan, currency })));
  });
  api.post('/auth/signup', (req, res) => signedIn(req, res, auth.signup(req.body), 201));
  api.post('/auth/login', (req, res) => signedIn(req, res, auth.login(req.body, { ip: req.ip })));
  api.post('/auth/logout', (req, res) => {
    auth.logout(sessionToken(req));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });
  api.post('/auth/forgot', (req, res) => {
    auth.requestPasswordReset(req.body.email, { baseUrl: publicUrl(req) });
    res.json({ ok: true });
  });
  api.post('/auth/reset', (req, res) => signedIn(req, res, auth.resetPassword(req.body)));

  // "Who am I, if anyone?" — no error for guests (pages that need an account use /me)
  api.get('/session', (req, res) => res.json({ user: auth.userForToken(sessionToken(req)) }));
  api.get('/me', requireUser, (req, res) => res.json(req.user));
  api.patch('/me', requireUser, (req, res) => res.json(auth.updateProfile(req.user.id, req.body)));
  // Memberships (Phase 6): paid plans are charged (demo) or go through Stripe Checkout (redirect)
  api.get('/me/membership', requireUser, (req, res) => res.json(memberships.view(req.user.id)));
  api.put('/me/plan', requireUser, wrap(async (req, res) => {
    const membership = await memberships.change(req.user, req.body.plan, { baseUrl: publicUrl(req) });
    res.json({ user: auth.userForToken(sessionToken(req)), membership, redirect: membership.redirect });
  }));
  api.post('/me/membership/cancel', requireUser, wrap(async (req, res) => res.json(await memberships.cancel(req.user))));
  api.post('/me/membership/resume', requireUser, wrap(async (req, res) => res.json(await memberships.resume(req.user))));
  api.post('/me/payment-methods', requireUser, wrap(async (req, res) => res.json(await memberships.portal(req.user, { baseUrl: publicUrl(req) }))));

  // ---------- admin API ----------

  const admin = express.Router();

  // Staff sign in with their account (role ADMIN). ADMIN_PASSWORD as a Bearer token still
  // works for scripts and the old front desk.
  admin.use((req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (adminPassword && m && safeEqual(m[1], adminPassword)) { req.staff = { name: 'Front desk', via: 'password' }; return next(); }
    const user = auth.userForToken(sessionToken(req));
    if (user && user.role === 'ADMIN') { req.staff = { name: user.name, email: user.email, via: 'account' }; return next(); }
    if (user) throw new ApiError(403, 'forbidden', 'Your account is not a staff account.');
    throw new ApiError(401, 'unauthorized', 'Log in with a staff account.');
  });
  admin.get('/me', (req, res) => res.json(req.staff));

  admin.get('/day', (req, res) => res.json(service.getDay(req.query.date || service.today().date)));

  admin.post('/bookings', (req, res) => {
    const { booking, manageToken } = service.createBooking(req.body, { admin: true });
    res.status(201).json({ booking, manageUrl: manageUrl(req, booking.code, manageToken) });
  });

  admin.patch('/bookings/:code', (req, res) => res.json(service.setBookingStatus(req.params.code, req.body.status)));

  admin.post('/blocks', (req, res) => res.status(201).json(service.addBlock(req.body)));

  admin.delete('/blocks/:id', (req, res) => {
    service.removeBlock(req.params.id);
    res.status(204).end();
  });

  admin.get('/settings', (req, res) => res.json(service.getSettings()));
  admin.put('/settings', (req, res) => res.json(service.updateSettings(req.body)));

  admin.get('/tables', (req, res) => res.json(service.listTables({ includeInactive: true })));
  admin.post('/tables', (req, res) => res.status(201).json(service.addTable(req.body.name)));
  admin.patch('/tables/:id', (req, res) => res.json(service.updateTable(req.params.id, req.body)));

  // ---------- admin panel (Phase 7) ----------
  admin.get('/calendar', (req, res) => res.json(staff.day(req.query.date)));
  admin.get('/bookings', (req, res) => res.json(staff.bookings(req.query)));
  admin.post('/bookings/:code/status', (req, res) => res.json(staff.setStatus(req.params.code, req.body.status)));
  admin.post('/bookings/:code/cancel', wrap(async (req, res) => {
    const refund = typeof req.body.refund === 'boolean' ? req.body.refund : undefined;
    await reservations.cancel(req.params.code, { admin: true }, { refund });
    res.json(reservations.adminView(reservations.byCode(req.params.code.toUpperCase())));
  }));
  admin.post('/checkin', (req, res) => res.json(reservations.checkInBooking(req.body)));
  admin.get('/coaches', (req, res) => res.json(staff.coachList()));
  admin.post('/coaches', (req, res) => res.status(201).json(staff.saveCoach(null, req.body)));
  admin.put('/coaches/:id', (req, res) => res.json(staff.saveCoach(req.params.id, req.body)));
  admin.post('/coaches/:id/time-off', (req, res) => res.status(201).json(staff.addTimeOff(req.params.id, req.body)));
  admin.delete('/coaches/:id/time-off/:offId', (req, res) => res.json(staff.removeTimeOff(req.params.id, req.params.offId)));
  admin.get('/classes', (req, res) => res.json(staff.classList(req.query)));
  admin.post('/classes', (req, res) => res.status(201).json(staff.createClass(req.body)));
  admin.patch('/classes/:id', (req, res) => res.json(staff.updateClass(req.params.id, req.body)));
  admin.delete('/classes/:id', wrap(async (req, res) => res.json(await staff.cancelClass(req.params.id))));
  admin.get('/pricing', (req, res) => res.json(staff.pricing()));
  admin.put('/pricing/rules', (req, res) => res.json(staff.saveRules(req.body.rules)));
  admin.put('/plans/:id', (req, res) => res.json(staff.savePlan(req.params.id, req.body)));
  admin.post('/lesson-types', (req, res) => res.status(201).json(staff.saveLessonType(null, req.body)));
  admin.put('/lesson-types/:id', (req, res) => res.json(staff.saveLessonType(req.params.id, req.body)));
  admin.put('/lesson-packs', (req, res) => res.json(staff.savePacks(req.body)));
  admin.post('/promos', (req, res) => res.status(201).json(staff.savePromo(req.body)));
  admin.delete('/promos/:code', (req, res) => res.json(staff.deletePromo(req.params.code)));
  admin.get('/members', (req, res) => res.json(staff.members(req.query)));
  admin.get('/members/:id', (req, res) => res.json(staff.member(req.params.id)));
  admin.post('/members/:id/credits', (req, res) => res.json(staff.adjustCredits(req.params.id, req.body)));
  admin.put('/members/:id/role', (req, res) => res.json(staff.setRole(req.params.id, req.body.role)));
  admin.get('/club', (req, res) => res.json(staff.clubSettings()));
  admin.put('/club', (req, res) => res.json(staff.saveClubSettings(req.body)));
  admin.post('/club/tables', (req, res) => res.status(201).json(staff.saveTable(null, req.body)));
  admin.put('/club/tables/:id', (req, res) => res.json(staff.saveTable(req.params.id, req.body)));
  admin.post('/club/areas', (req, res) => res.status(201).json(staff.saveArea(null, req.body)));
  admin.put('/club/areas/:id', (req, res) => res.json(staff.saveArea(req.params.id, req.body)));
  admin.post('/club/closures', (req, res) => res.status(201).json(staff.addClosure(req.body)));
  admin.delete('/club/closures/:date', (req, res) => res.json(staff.removeClosure(req.params.date)));
  admin.get('/reports', (req, res) => res.json(staff.reports(req.query)));

  api.use('/admin', admin);
  app.use('/api', api);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // ---------- pages ----------

  const pub = path.join(__dirname, '..', 'public');
  app.get('/manage', (req, res) => res.sendFile(path.join(pub, 'manage.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
  app.get('/styleguide', (req, res) => res.sendFile(path.join(pub, 'styleguide.html')));
  for (const [route, file] of [['/welcome', 'welcome'], ['/signup', 'signup'], ['/login', 'login'],
    ['/forgot-password', 'forgot'], ['/reset-password', 'reset'], ['/profile', 'profile'], ['/profile/edit', 'profile-edit']]) {
    app.get(route, (req, res) => res.sendFile(path.join(pub, `${file}.html`)));
  }
  // QR decoding for the check-in scanner on browsers without BarcodeDetector (Safari)
  app.get('/vendor/jsqr.js', (req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));
  app.use(express.static(pub));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint' } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details || {}) } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
  });

  const runJobs = async () => {
    await reservations.runJobs();
    lessons.runJobs();
    await memberships.runJobs();
  };
  return { app, service, auth, mailer, db, payments, reservations, lessons, memberships, checkIn, runJobs };
}

module.exports = { createApp };
