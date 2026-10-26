const express = require('express');
const path = require('path');
const { openDb } = require('./db');
const { createService, ApiError, safeEqual } = require('./service');
const { createAuth } = require('./auth');
const { createMailer } = require('./mailer');

// Origins the Capacitor app runs on (iOS: capacitor://localhost, Android: http(s)://localhost).
const APP_ORIGINS = ['capacitor://localhost', 'ionic://localhost', 'http://localhost', 'https://localhost'];

const SESSION_COOKIE = 'rc_session';

function createApp({ dbFile = ':memory:', adminPassword = null, baseUrl = null, corsOrigins = [], now, mailer = createMailer({ log: false }) } = {}) {
  const db = openDb(dbFile);
  const service = createService(db, { now });
  const auth = createAuth(db, { mailer, now });
  const app = express();

  app.disable('x-powered-by');
  // Behind a local/private proxy (Railway, ngrok) trust X-Forwarded-* for req.ip and req.secure
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
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
  api.put('/me/plan', requireUser, (req, res) => res.json(auth.choosePlan(req.user.id, req.body.plan)));

  // ---------- admin API ----------

  const admin = express.Router();

  admin.use((req, res, next) => {
    if (!adminPassword) throw new ApiError(503, 'admin_disabled', 'Set ADMIN_PASSWORD to enable the admin panel');
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m || !safeEqual(m[1], adminPassword)) throw new ApiError(401, 'unauthorized', 'Wrong admin password');
    next();
  });

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

  return { app, service, auth, mailer, db };
}

module.exports = { createApp };
