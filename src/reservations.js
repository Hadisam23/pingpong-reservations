// Table booking for players (Phase 4): availability per area, 10-minute holds, checkout
// (card, table credit, membership), confirmation with a signed check-in code, my bookings,
// cancel (refund until the free-cancellation cutoff) and reschedule.
// Guests can book too: they prove ownership with the booking's manage token.
const crypto = require('crypto');
const { ApiError, safeEqual } = require('./service');
const { findPlan } = require('./plans');
const { formatHHMM, parseHHMM, isValidDate, weekday, addDays, nowIn, minutesUntil, zonedToUtc } = require('./time');
const { round2 } = require('./pricing');
const { cleanName, cleanEmail, cleanPhone } = require('./auth');

const HOLD_MINUTES = 10;
const REDIRECT_HOLD_MINUTES = 35;   // a Stripe Checkout page stays open at least 30 min
const CREDIT_MAX_MINUTES = 60;      // one table credit covers a booking up to an hour
const SPLIT_DEADLINE_MINUTES = 120; // unpaid shares go to the organizer 2 h before
const NO_SHOW_MINUTES = 15;
const EARLY_CHECKIN_MINUTES = 15;
const STRIP_DAYS = 7;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function createReservations(db, { service, pricing, payments, checkIn, notifier, now = () => new Date() }) {
  const SELECT = `SELECT b.*, t.name AS tableName, t.number AS tableNumber, a.id AS areaId, a.name AS areaName,
      cu.name AS coachName, lt.name AS lessonName, lt.maxStudents AS lessonMax,
      cs.title AS classTitle, cs.level AS classLevel, cs.kind AS classKind
    FROM bookings b LEFT JOIN tables t ON t.id = b.tableId LEFT JOIN areas a ON a.id = t.areaId
      LEFT JOIN coaches c ON c.id = b.coachId LEFT JOIN users cu ON cu.id = c.userId
      LEFT JOIN lesson_types lt ON lt.id = b.lessonTypeId LEFT JOIN class_sessions cs ON cs.id = b.classSessionId`;
  const stmts = {
    areas: db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM tables t WHERE t.areaId = a.id AND t.active = 1) AS tableCount
      FROM areas a ORDER BY a.sortOrder, a.id`),
    area: db.prepare('SELECT * FROM areas WHERE id = ?'),
    tablesInArea: db.prepare('SELECT * FROM tables WHERE active = 1 AND areaId = ? ORDER BY number, id'),
    byCode: db.prepare(`${SELECT} WHERE b.code = ?`),
    byId: db.prepare(`${SELECT} WHERE b.id = ?`),
    mine: db.prepare(`${SELECT} WHERE b.userId = ? AND b.status NOT IN ('held', 'expired') ORDER BY b.date, b.startMin`),
    codeExists: db.prepare('SELECT 1 FROM bookings WHERE code = ?'),
    insertHold: db.prepare(`INSERT INTO bookings
      (code, manageToken, tableId, date, startMin, endMin, name, phone, email, players, price, basePrice, type, status, source,
       createdAt, updatedAt, userId, kind, coachId, lessonTypeId, classSessionId, holdExpiresAt)
      VALUES (@code, @manageToken, @tableId, @date, @startMin, @endMin, @name, @phone, @email, @players, @price, @basePrice,
       @type, 'held', 'online', @now, @now, @userId, @kind, @coachId, @lessonTypeId, @classSessionId, @holdExpiresAt)`),
    releaseUserHolds: db.prepare("UPDATE bookings SET status = 'expired', updatedAt = ? WHERE userId = ? AND status = 'held'"),
    packs: db.prepare('SELECT * FROM lesson_packs WHERE userId = ? AND expiresAt > ? AND lessonsUsed < lessonsTotal ORDER BY expiresAt, id'),
    packUse: db.prepare('UPDATE lesson_packs SET lessonsUsed = lessonsUsed + ? WHERE id = ?'),
    lastPackUsed: db.prepare('SELECT * FROM lesson_packs WHERE userId = ? AND lessonsUsed > 0 ORDER BY expiresAt DESC, id DESC LIMIT 1'),
    includedLessonsUsed: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE userId = ? AND kind = 'LESSON' AND paymentMethod = 'MEMBERSHIP'
      AND status IN ('confirmed', 'checked_in', 'no_show') AND date BETWEEN ? AND ?`),
    expireHolds: db.prepare("UPDATE bookings SET status = 'expired', updatedAt = @now WHERE status = 'held' AND holdExpiresAt <= @now"),
    expire: db.prepare("UPDATE bookings SET status = 'expired', updatedAt = ? WHERE id = ? AND status = 'held'"),
    extendHold: db.prepare('UPDATE bookings SET holdExpiresAt = ?, updatedAt = ? WHERE id = ?'),
    saveDetails: db.prepare(`UPDATE bookings SET name = @name, email = @email, phone = @phone, players = @players, price = @price,
      basePrice = @basePrice, paymentMethod = @paymentMethod, promoCode = @promoCode, splitCost = @splitCost, updatedAt = @now WHERE id = @id`),
    confirm: db.prepare(`UPDATE bookings SET status = 'confirmed', holdExpiresAt = NULL, checkInCode = @checkInCode, updatedAt = @now
      WHERE id = @id`),
    cancel: db.prepare("UPDATE bookings SET status = 'cancelled', cancelledAt = @now, refundedAt = @refundedAt, updatedAt = @now WHERE id = @id"),
    move: db.prepare(`UPDATE bookings SET date = @date, startMin = @startMin, endMin = @endMin, tableId = @tableId,
      checkInCode = @checkInCode, updatedAt = @now WHERE id = @id`),
    creditBalance: db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE userId = ? AND type = 'TABLE_CREDIT'"),
    pack: db.prepare(`SELECT COALESCE(SUM(lessonsTotal), 0) AS total, COALESCE(SUM(lessonsUsed), 0) AS used FROM lesson_packs
      WHERE userId = ? AND expiresAt > ?`),
    ledger: db.prepare('INSERT INTO credit_ledger (userId, type, delta, reason, bookingId, createdAt) VALUES (?, ?, ?, ?, ?, ?)'),
    participants: db.prepare('SELECT * FROM booking_participants WHERE bookingId = ? ORDER BY id'),
    clearParticipants: db.prepare('DELETE FROM booking_participants WHERE bookingId = ?'),
    insertParticipant: db.prepare(`INSERT INTO booking_participants (bookingId, name, inviteEmail, shareAmount, paid, payToken)
      VALUES (@bookingId, @name, @inviteEmail, @shareAmount, @paid, @payToken)`),
    participantByToken: db.prepare('SELECT * FROM booking_participants WHERE payToken = ?'),
    participant: db.prepare('SELECT * FROM booking_participants WHERE id = ?'),
    markShare: db.prepare('UPDATE booking_participants SET paid = 1, paidAt = ? WHERE id = ?'),
    coverShares: db.prepare('UPDATE booking_participants SET coveredByOrganizerAt = ? WHERE bookingId = ? AND paid = 0 AND coveredByOrganizerAt IS NULL'),
    upcomingForPhone: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE phone = ? AND status = 'confirmed'
      AND (date > ? OR (date = ? AND endMin > ?))`),
    dueNoShows: db.prepare(`SELECT id FROM bookings WHERE status = 'confirmed' AND (date < @date OR (date = @date AND startMin + ${NO_SHOW_MINUTES} <= @minutes))`),
    setStatus: db.prepare('UPDATE bookings SET status = ?, updatedAt = ? WHERE id = ?'),
    splitDue: db.prepare(`SELECT DISTINCT b.id FROM bookings b JOIN booking_participants p ON p.bookingId = b.id
      WHERE b.status = 'confirmed' AND b.splitCost = 1 AND p.paid = 0 AND p.coveredByOrganizerAt IS NULL`),
  };

  const settings = () => service.getSettings();
  const tz = () => settings().timezone;
  const today = () => nowIn(tz(), now());
  const iso = () => now().toISOString();

  // ---------- plans ----------

  // Member pricing and the longer booking window only apply while the membership is active.
  function planOf(user) {
    const dropin = findPlan(db, 'dropin');
    if (!user) return { plan: dropin, pricingPlan: null };
    const plan = findPlan(db, user.plan.id) || dropin;
    const active = user.plan.status === 'active';
    return { plan: active ? plan : dropin, pricingPlan: active && plan.id !== 'dropin' ? plan : null };
  }

  // ---------- helpers ----------

  function areaOrDefault(areaId) {
    const areas = stmts.areas.all();
    if (areaId === undefined || areaId === null || areaId === '') return areas[0];
    const area = areas.find(a => a.id === Number(areaId));
    if (!area) throw new ApiError(400, 'invalid_area', 'Pick a valid area', { field: 'area' });
    return area;
  }

  function requireDuration(duration) {
    const d = Number(duration);
    const allowed = pricing.durations();
    if (!allowed.includes(d)) throw new ApiError(400, 'invalid_duration', `Duration must be ${allowed.join(', ')} minutes`, { field: 'duration' });
    return d;
  }

  const startsAt = row => zonedToUtc(row.date, row.startMin, tz());
  const endsAt = row => zonedToUtc(row.date, row.endMin, tz());
  const minutesToStart = row => minutesUntil(row.date, row.startMin, today());

  // Checks a date against the plan window and opening hours; returns { hours, lastDate }
  function checkDate(date, plan, { allowPastWindow = false } = {}) {
    if (!isValidDate(date)) throw new ApiError(400, 'invalid_date', 'Date must be YYYY-MM-DD', { field: 'date' });
    const t = today();
    const lastDate = addDays(t.date, plan.bookingWindowDays);
    if (date < t.date) throw new ApiError(400, 'in_past', 'That date has already passed', { field: 'date' });
    if (date > lastDate && !allowPastWindow) {
      throw new ApiError(400, 'outside_window', `Your plan books up to ${plan.bookingWindowDays} days ahead. Members can book further ahead.`, { field: 'date' });
    }
    return { hours: service.hoursOn(date), lastDate };
  }

  const isFreeIn = (busy, tableId, start, end) => !(busy.get(tableId) || []).some(i => i.start < end && i.end > start);

  // Lowest-numbered table in the area that is free for the whole time
  function freeTable(area, date, start, end, opts) {
    const busy = service.occupancy.busyOn(date, opts);
    return stmts.tablesInArea.all(area.id).find(t => isFreeIn(busy, t.id, start, end)) || null;
  }

  function expireHolds() {
    stmts.expireHolds.run({ now: iso() });
  }

  // admin: front desk / staff act on any booking
  function owned(code, { user, token, admin = false } = {}) {
    const row = stmts.byCode.get(String(code ?? '').trim().toUpperCase());
    const mine = row && (admin || (user && row.userId === user.id) || (token && safeEqual(token, row.manageToken)));
    if (!mine) throw new ApiError(404, 'booking_not_found', 'Booking not found');
    return row;
  }

  // ---------- availability ----------

  function areasList() {
    return stmts.areas.all().map(a => ({ id: a.id, name: a.name, description: a.description, tables: a.tableCount }));
  }

  // The date strip: at least a week, as far as the plan's window reaches
  function days(plan) {
    const t = today();
    const count = Math.min(31, Math.max(STRIP_DAYS, plan.bookingWindowDays + 1));
    const lastDate = addDays(t.date, plan.bookingWindowDays);
    return Array.from({ length: count }, (_, i) => {
      const date = addDays(t.date, i);
      const d = new Date(`${date}T12:00:00Z`);
      return {
        date, dow: DOW[weekday(date)], num: d.getUTCDate(),
        closed: !service.hoursOn(date), bookable: date <= lastDate && !!service.hoursOn(date),
      };
    });
  }

  function availability({ date, duration, area: areaId, user, reschedule, token } = {}) {
    expireHolds();
    const { plan, pricingPlan } = planOf(user);
    const moving = reschedule ? owned(reschedule, { user, token }) : null;
    const dur = moving ? moving.endMin - moving.startMin : requireDuration(duration || 60);
    const area = areaOrDefault(areaId);
    const t = today();
    const day = date || t.date;
    const base = {
      date: day, duration: dur, area: { id: area.id, name: area.name, description: area.description },
      areas: areasList(), durations: pricing.durations(), days: days(plan),
      window: { days: plan.bookingWindowDays, lastDate: addDays(t.date, plan.bookingWindowDays), plan: plan.name },
      memberRate: !!pricingPlan, centerName: settings().centerName, currency: settings().currency,
    };
    let hours;
    try {
      ({ hours } = checkDate(day, plan));
    } catch (err) {
      if (err.code === 'outside_window') return { ...base, closed: false, outsideWindow: true, slots: [] };
      throw err;
    }
    if (!hours) return { ...base, closed: true, slots: [] };

    const open = parseHHMM(hours.open);
    const close = parseHHMM(hours.close);
    const earliest = day === t.date ? t.minutes + settings().minNoticeMinutes : -1;
    const busy = service.occupancy.busyOn(day, { excludeBookingId: moving ? moving.id : null });
    const tables = stmts.tablesInArea.all(area.id);
    const slots = [];
    for (let s = open; s + dur <= close; s += settings().slotMinutes) {
      if (s < earliest) continue;
      const free = tables.filter(tb => isFreeIn(busy, tb.id, s, s + dur)).length;
      const q = pricing.quote({ date: day, startMin: s, duration: dur, plan: pricingPlan });
      slots.push({ time: formatHHMM(s), start: s, end: formatHHMM(s + dur), peak: q.peak, free, full: free === 0, price: q.subtotal, base: q.base });
    }
    return { ...base, closed: false, open: hours.open, close: hours.close, slots };
  }

  // Free tables today across the club for an hour, for the Home screen
  function freeToday({ user, limit = 4 } = {}) {
    const t = today();
    const hours = service.hoursOn(t.date);
    if (!hours) return [];
    const busy = service.occupancy.busyOn(t.date);
    const tables = stmts.areas.all().flatMap(a => stmts.tablesInArea.all(a.id));
    const out = [];
    for (let s = parseHHMM(hours.open); s + 60 <= parseHHMM(hours.close) && out.length < limit; s += settings().slotMinutes) {
      if (s < t.minutes + settings().minNoticeMinutes) continue;
      const free = tables.filter(tb => isFreeIn(busy, tb.id, s, s + 60)).length;
      if (free > 0) out.push({ time: formatHHMM(s), free });
    }
    void user;
    return out;
  }

  // ---------- holds ----------

  function hold({ date, start, duration, area: areaId, players } = {}, { user } = {}) {
    expireHolds();
    const { plan, pricingPlan } = planOf(user);
    const dur = requireDuration(duration);
    const area = areaOrDefault(areaId);
    const { hours } = checkDate(date, plan);
    if (!hours) throw new ApiError(400, 'closed', 'The club is closed that day', { field: 'date' });
    const startMin = parseHHMM(start);
    const s = settings();
    if (startMin === null || startMin % s.slotMinutes !== 0) throw new ApiError(400, 'invalid_time', 'Pick a start time', { field: 'start' });
    if (startMin < parseHHMM(hours.open) || startMin + dur > parseHHMM(hours.close)) {
      throw new ApiError(400, 'outside_hours', `Open ${hours.open}–${hours.close} that day`, { field: 'start' });
    }
    const t = today();
    if (date === t.date && startMin < t.minutes + s.minNoticeMinutes) throw new ApiError(400, 'in_past', 'That time has already passed', { field: 'start' });

    const q = pricing.quote({ date, startMin, duration: dur, plan: pricingPlan });
    const count = Math.min(s.maxPlayersPerTable, Math.max(1, Number(players) || 2));
    const create = db.transaction(() => {
      if (user) stmts.releaseUserHolds.run(iso(), user.id);
      const table = freeTable(area, date, startMin, startMin + dur);
      if (!table) throw new ApiError(409, 'slot_taken', 'That time was just taken. Pick another time.');
      return insertHoldRow({
        user, kind: 'TABLE', tableId: table.id, date, startMin, endMin: startMin + dur, players: count, price: q.subtotal, basePrice: q.base,
      });
    });
    return create.immediate();
  }

  // Inserts a hold row (any kind). Call inside an IMMEDIATE transaction that has checked the slot.
  function insertHoldRow({ user, kind, tableId = null, date, startMin, endMin, players = 1, price, basePrice, coachId = null, lessonTypeId = null, classSessionId = null, minutes = HOLD_MINUTES }) {
    if (user) stmts.releaseUserHolds.run(iso(), user.id);   // one hold at a time
    let code;
    do { code = newCode(); } while (stmts.codeExists.get(code));
    const manageToken = newToken();
    const holdExpiresAt = new Date(now().getTime() + minutes * 60000).toISOString();
    stmts.insertHold.run({
      code, manageToken, tableId, date, startMin, endMin,
      name: user ? user.name : 'Guest', phone: user ? user.phone : null, email: user ? user.email : null,
      players, price, basePrice, userId: user ? user.id : null, holdExpiresAt, now: iso(),
      kind, type: kind === 'LESSON' ? 'coaching' : 'casual', coachId, lessonTypeId, classSessionId,
    });
    return { code, token: manageToken, expiresAt: holdExpiresAt };
  }

  function release(code, who) {
    const row = owned(code, who);
    if (row.status === 'held') stmts.expire.run(iso(), row.id);
  }

  // ---------- checkout ----------

  const monthOf = date => [`${date.slice(0, 7)}-01`, `${date.slice(0, 7)}-31`];
  const packLeft = userId => stmts.packs.all(userId, iso()).reduce((n, p) => n + p.lessonsTotal - p.lessonsUsed, 0);

  // What a hold costs before payment-method choices: { base, memberDiscount, memberLabel, free, peak, label, freeTitle, freeSub }
  function basis(row, user) {
    const { plan, pricingPlan } = planOf(user);
    const dur = row.endMin - row.startMin;
    if (row.kind === 'LESSON') {
      const used = user ? stmts.includedLessonsUsed.get(user.id, ...monthOf(row.date)).n : 0;
      const free = !!pricingPlan && pricingPlan.includedLessonsPerMonth > used;
      return {
        base: row.basePrice, memberDiscount: 0, memberLabel: null, free, peak: false, label: `${row.lessonName}, ${dur} min`,
        freeTitle: `Included in ${plan.name}`, freeSub: `${pricingPlan ? pricingPlan.includedLessonsPerMonth : 0} private lesson a month on your plan`,
      };
    }
    if (row.kind === 'CLASS') {
      // Open play is part of Club and Pro
      const free = !!pricingPlan && row.classKind === 'OPEN_PLAY';
      return {
        base: row.basePrice, memberDiscount: free ? row.basePrice : 0, memberLabel: free ? `${plan.name}: open play included` : null,
        free, peak: false, label: row.classTitle, freeTitle: `Included in ${plan.name}`, freeSub: 'Open play is part of your plan',
      };
    }
    const q = pricing.quote({ date: row.date, startMin: row.startMin, duration: dur, plan: pricingPlan });
    return { ...q, label: `Table, ${dur} min`, freeTitle: `Included in ${plan.name}`, freeSub: 'Off-peak tables are free on your plan' };
  }

  function methodsFor(row, user) {
    const dur = row.endMin - row.startMin;
    const q = basis(row, user);
    const methods = [];
    if (q.free) methods.push({ id: 'MEMBERSHIP', title: q.freeTitle, sub: q.freeSub });
    if (row.kind === 'LESSON' && user) {
      const left = packLeft(user.id);
      if (left) methods.push({ id: 'PACK', title: 'Use a lesson pack credit', sub: `${left} lesson${left === 1 ? '' : 's'} left in your pack` });
    }
    methods.push({ id: 'CARD', ...payments.card });
    if (user && row.kind === 'TABLE') {
      const credits = stmts.creditBalance.get(user.id).n;
      let sub = `${credits} credit${credits === 1 ? '' : 's'} left this month`;
      if (!credits) sub = 'No table credits left';
      else if (dur > CREDIT_MAX_MINUTES) sub = `Credits cover bookings up to ${CREDIT_MAX_MINUTES} min`;
      methods.push({ id: 'CREDIT', title: 'Use a table credit', sub, disabled: !credits || dur > CREDIT_MAX_MINUTES, credits });
    }
    return methods;
  }

  // The price breakdown for a hold with the chosen options. Throws on an invalid promo.
  function quoteFor(row, user, { paymentMethod, promo, players, split } = {}) {
    const methods = methodsFor(row, user);
    const method = methods.find(m => m.id === paymentMethod && !m.disabled) || methods.find(m => !m.disabled);
    const q = basis(row, user);
    const lines = [{ label: q.label, amount: q.base }];
    if (q.memberDiscount) lines.push({ label: q.memberLabel, amount: -q.memberDiscount, discount: true });
    let total = round2(q.base - q.memberDiscount);
    const covered = { CREDIT: 'Table credit', PACK: 'Lesson pack credit', MEMBERSHIP: q.freeTitle };
    if (covered[method.id] && total > 0) {
      lines.push({ label: covered[method.id], amount: -total, discount: true });
      total = 0;
    }
    let promoInfo = null;
    if (promo && total > 0) {
      promoInfo = pricing.promo(promo, total, now());
      lines.push({ label: `Promo ${promoInfo.code}`, amount: -promoInfo.discount, discount: true });
      total = round2(total - promoInfo.discount);
    }
    const count = Math.min(maxPlayers(row), Math.max(1, Number(players) || row.players || 1));
    const splitOn = !!split && !!user && count > 1 && total > 0 && method.id === 'CARD';
    const otherShare = splitOn ? Math.floor(total * 100 / count) / 100 : 0;
    const yourShare = splitOn ? round2(total - otherShare * (count - 1)) : total;
    return {
      lines, base: q.base, total, yourShare, otherShare, players: count, split: splitOn, peak: q.peak,
      method: method.id, methods, promo: promoInfo, currency: settings().currency,
    };
  }

  const maxPlayers = row => (row.kind === 'CLASS' ? 1 : row.kind === 'LESSON' ? row.lessonMax || 1 : settings().maxPlayersPerTable);

  function cancellationInfo(row) {
    const cutoff = settings().cancelCutoffMinutes;
    const until = new Date(new Date(startsAt(row)).getTime() - cutoff * 60000);
    const local = nowIn(tz(), until);
    return { hours: Math.round(cutoff / 60 * 10) / 10, freeUntil: until.toISOString(), freeUntilDate: local.date, freeUntilTime: formatHHMM(local.minutes) };
  }

  function holdView(code, { user, token } = {}) {
    expireHolds();
    const row = owned(code, { user, token });
    const q = row.status === 'held' ? quoteFor(row, user, { players: row.players }) : null;
    return {
      ...summary(row),
      status: row.status,
      expiresAt: row.holdExpiresAt,
      guest: !row.userId,
      maxPlayers: maxPlayers(row),
      quote: q,
      cancellation: cancellationInfo(row),
      payments: { provider: payments.provider },
    };
  }

  function quote(code, body = {}, { user, token } = {}) {
    const row = owned(code, { user, token });
    if (row.status !== 'held') throw new ApiError(409, 'hold_expired', 'Your hold has expired. Pick the time again.');
    return quoteFor(row, user, body);
  }

  // The slot is still ours if the hold is live, or nobody took the table since it lapsed.
  function stillOurs(row) {
    if (row.status === 'held' && row.holdExpiresAt > iso()) return true;
    if (!['held', 'expired'].includes(row.status)) return false;
    return !service.occupancy.conflict(row.tableId, row.date, row.startMin, row.endMin, { excludeBookingId: row.id });
  }

  async function checkout(code, body = {}, { user, token, baseUrl } = {}) {
    let row = owned(code, { user, token });
    if (['confirmed', 'checked_in'].includes(row.status)) return { booking: view(row, { owner: true }) };
    if (!stillOurs(row)) throw new ApiError(409, 'hold_expired', 'Your hold has expired and the time was taken. Pick another time.');

    let contact = { name: row.name, email: row.email, phone: row.phone };
    if (!row.userId) {
      contact = { name: cleanName(body.name), email: cleanEmail(body.email), phone: cleanPhone(body.phone) };
      const t = today();
      if (stmts.upcomingForPhone.get(contact.phone, t.date, t.date, t.minutes).n >= settings().maxActiveBookingsPerPhone) {
        throw new ApiError(409, 'booking_limit', `You already have ${settings().maxActiveBookingsPerPhone} upcoming bookings. Cancel one to book another.`);
      }
    }
    const q = quoteFor(row, user, body);
    if (body.paymentMethod && body.paymentMethod !== q.method) {
      throw new ApiError(400, 'invalid_payment_method', 'That payment method is not available for this booking', { field: 'paymentMethod' });
    }
    const invites = Array.isArray(body.invites) ? body.invites.slice(0, q.players - 1) : [];

    db.transaction(() => {
      stmts.saveDetails.run({
        id: row.id, ...contact, players: q.players, price: q.total, basePrice: q.base,
        paymentMethod: q.method, promoCode: q.promo ? q.promo.code : null, splitCost: q.split ? 1 : 0, now: iso(),
      });
      stmts.clearParticipants.run(row.id);
      for (let i = 0; i < q.players - 1; i++) {
        const invite = invites[i] || {};
        stmts.insertParticipant.run({
          bookingId: row.id,
          name: invite.name ? String(invite.name).trim().slice(0, 60) : null,
          inviteEmail: invite.email ? String(invite.email).trim().toLowerCase().slice(0, 254) : null,
          shareAmount: q.split ? q.otherShare : 0,
          paid: q.split ? 0 : 1,
          payToken: q.split ? newToken() : null,
        });
      }
    })();

    if (q.method === 'CARD' && q.yourShare > 0) {
      const back = `code=${row.code}&token=${encodeURIComponent(row.manageToken)}`;
      const result = await payments.charge({
        kind: 'BOOKING', amount: q.yourShare, userId: row.userId, bookingId: row.id,
        description: `Table · ${row.date} ${formatHHMM(row.startMin)}–${formatHHMM(row.endMin)}`,
        email: contact.email, saveCard: !!row.userId,
        successUrl: `${baseUrl}/confirmed.html?${back}&paid=1`, cancelUrl: `${baseUrl}/checkout.html?${back}`,
      });
      if (result.status === 'redirect') {
        stmts.extendHold.run(new Date(now().getTime() + REDIRECT_HOLD_MINUTES * 60000).toISOString(), iso(), row.id);
        return { redirect: result.url, code: row.code, token: row.manageToken };
      }
    }
    row = finalize(row.id);
    return { booking: view(row, { owner: true }), token: row.manageToken };
  }

  // Turns a paid (or free) hold into a confirmed booking. Safe to call twice.
  function finalize(bookingId) {
    const run = db.transaction(() => {
      const row = stmts.byId.get(bookingId);
      if (['confirmed', 'checked_in'].includes(row.status)) return { row, fresh: false };
      if (!stillOurs(row)) throw new ApiError(409, 'hold_expired', 'Your hold has expired and the time was taken.');
      if (row.paymentMethod === 'CREDIT') {
        if (stmts.creditBalance.get(row.userId).n < 1) throw new ApiError(409, 'no_credits', 'You have no table credits left.');
        stmts.ledger.run(row.userId, 'TABLE_CREDIT', -1, `Table booking ${row.code}`, row.id, iso());
      }
      if (row.paymentMethod === 'PACK') {
        const pack = stmts.packs.all(row.userId, iso())[0];
        if (!pack) throw new ApiError(409, 'no_pack', 'Your lesson pack is used up.');
        stmts.packUse.run(1, pack.id);
        stmts.ledger.run(row.userId, 'LESSON_PACK', -1, `Lesson ${row.code}`, row.id, iso());
      }
      if (row.kind === 'CLASS' && hooks.claimSeat) hooks.claimSeat(row);
      if (row.promoCode) pricing.usePromo(row.promoCode);
      stmts.confirm.run({ id: row.id, checkInCode: checkIn.sign({ bookingId: row.id, userId: row.userId, expiresAt: endsAt(row) }), now: iso() });
      return { row: stmts.byId.get(row.id), fresh: true };
    });
    const { row, fresh } = run.immediate();
    if (fresh) {
      const v = view(row);
      notifier.notify({
        userId: row.userId, email: row.email, type: 'booking_confirmed', title: row.kind === 'TABLE' ? 'Table booked' : `${v.title} booked`,
        body: `${prettyDay(row.date)} · ${v.start}–${v.end} · ${v.where}`,
        emailSubject: `You're booked: ${prettyDay(row.date)} ${v.start}`,
        emailText: `Hi ${row.name.split(' ')[0]},\n\nYou're booked: ${v.title}${row.coachName ? ` with ${row.coachName}` : ''}.\n\n${prettyDay(row.date)}, ${v.start}–${v.end}\n${v.where}\nBooking #RC-${row.code}\n\nFree cancellation until ${v.cancellation.freeUntilDate} ${v.cancellation.freeUntilTime}.\nShow the QR code in the app at the door to check in.\n\nSee you at ${settings().centerName}!`,
      });
    }
    return row;
  }

  // A Stripe payment for a booking came back paid (webhook)
  payments.onPaid('BOOKING', payment => {
    try {
      finalize(payment.bookingId);
    } catch (err) {
      // The slot was lost while the player was on the payment page: give the money back.
      if (err.code === 'hold_expired') payments.refund(payment).catch(() => {});
      else throw err;
    }
  });
  payments.onPaid('SHARE', payment => stmts.markShare.run(iso(), payment.participantId));

  // Lessons & classes plug in here: claimSeat when a class seat is confirmed, seatFreed when one is cancelled
  const hooks = {};

  // ---------- views ----------

  const prettyDay = date => {
    const d = new Date(`${date}T12:00:00Z`);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  };

  const LEVEL_LABEL = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', kids: 'Kids', all: 'All levels' };

  function summary(row) {
    const where = row.kind === 'CLASS' ? 'Main hall'
      : row.areaName === 'Main hall' || !row.tableName ? (row.areaName || 'Club') : `${row.areaName} · ${row.tableName}`;
    const title = row.kind === 'LESSON' ? row.lessonName : row.kind === 'CLASS' ? row.classTitle : 'Table';
    return {
      title, coach: row.coachName || null, level: row.classLevel ? LEVEL_LABEL[row.classLevel] || row.classLevel : null,
      classSessionId: row.classSessionId, classKind: row.classKind || null,
      coachId: row.coachId || null, lessonTypeId: row.lessonTypeId || null,
      code: row.code, kind: row.kind, date: row.date, start: formatHHMM(row.startMin), end: formatHHMM(row.endMin),
      duration: row.endMin - row.startMin, area: row.areaName, areaId: row.areaId, table: row.tableName, where,
      players: row.players, startsAt: startsAt(row), endsAt: endsAt(row),
    };
  }

  function view(row, { owner = false } = {}) {
    const until = minutesToStart(row);
    const cutoff = settings().cancelCutoffMinutes;
    const active = row.status === 'confirmed';
    const shares = stmts.participants.all(row.id).map(p => ({
      name: p.name, amount: p.shareAmount, paid: !!p.paid, coveredByOrganizer: !!p.coveredByOrganizerAt, payToken: owner ? p.payToken : undefined,
    }));
    return {
      ...summary(row),
      status: row.status,
      price: row.price,
      basePrice: row.basePrice,
      currency: settings().currency,
      paymentMethod: row.paymentMethod,
      promoCode: row.promoCode,
      split: !!row.splitCost,
      shares,
      upcoming: ['confirmed', 'checked_in'].includes(row.status) && minutesUntil(row.date, row.endMin, today()) > 0,
      canCancel: active && until > 0,
      refundable: active && until >= cutoff,
      canReschedule: active && row.kind === 'TABLE' && until >= cutoff,
      cancellation: cancellationInfo(row),
      checkIn: owner && ['confirmed', 'checked_in'].includes(row.status) ? row.checkInCode : null,
      manageToken: owner ? row.manageToken : undefined,
      cancelledAt: row.cancelledAt,
      refunded: !!row.refundedAt,
    };
  }

  function get(code, who) {
    return view(owned(code, who), { owner: true });
  }

  function mine(user) {
    const rows = stmts.mine.all(user.id).map(r => view(r, { owner: true }));
    const upcoming = rows.filter(b => b.upcoming);
    const past = rows.filter(b => !b.upcoming).reverse();
    const pack = stmts.pack.get(user.id, iso());
    return {
      upcoming, past,
      credits: { table: stmts.creditBalance.get(user.id).n, pack: { left: pack.total - pack.used, total: pack.total } },
    };
  }

  // ---------- cancel & reschedule ----------

  // opts.refund (staff only) overrides the 24-hour rule either way
  async function cancel(code, who, opts = {}) {
    const row = owned(code, who);
    const staff = !!who.admin;
    const cancellable = row.status === 'confirmed' || (staff && ['held', 'no_show'].includes(row.status));
    if (!cancellable) throw new ApiError(409, 'not_cancellable', `This booking is already ${row.status.replace('_', ' ')}`);
    if (!staff && minutesToStart(row) <= 0) throw new ApiError(409, 'already_started', 'This booking has already started.');
    const refundable = staff && typeof opts.refund === 'boolean' ? opts.refund : minutesToStart(row) >= settings().cancelCutoffMinutes;
    if (refundable) await payments.refundBooking(row.id);
    db.transaction(() => {
      if (refundable && row.paymentMethod === 'CREDIT' && row.status !== 'held') {
        stmts.ledger.run(row.userId, 'TABLE_CREDIT', 1, `Refund: cancelled ${row.code}`, row.id, iso());
      }
      if (refundable && row.paymentMethod === 'PACK' && row.status !== 'held') {
        const pack = stmts.lastPackUsed.get(row.userId);
        if (pack) stmts.packUse.run(-1, pack.id);
        stmts.ledger.run(row.userId, 'LESSON_PACK', 1, `Refund: cancelled ${row.code}`, row.id, iso());
      }
      stmts.cancel.run({ id: row.id, refundedAt: refundable ? iso() : null, now: iso() });
    })();
    if (row.kind === 'CLASS' && hooks.seatFreed) hooks.seatFreed(row.classSessionId);
    const v = view(stmts.byId.get(row.id), { owner: true });
    notifier.notify({
      userId: row.userId, email: row.email, type: 'booking_cancelled', title: 'Booking cancelled',
      body: `${prettyDay(row.date)} · ${v.start}–${v.end}${refundable ? ' · refunded' : ''}`,
      emailSubject: `Cancelled: ${prettyDay(row.date)} ${v.start}`,
      emailText: `Your booking #RC-${row.code} on ${prettyDay(row.date)} at ${v.start} is cancelled.${refundable ? ' You get a full refund to the original payment method.' : ' It was inside the free-cancellation window, so it is not refunded.'}`,
    });
    return v;
  }

  function reschedule(code, { date, start, area: areaId } = {}, who = {}) {
    const row = owned(code, who);
    if (row.status !== 'confirmed' || row.kind !== 'TABLE') throw new ApiError(409, 'not_reschedulable', "This booking can't be moved.");
    if (minutesToStart(row) < settings().cancelCutoffMinutes) {
      throw new ApiError(409, 'too_late_to_reschedule', `Bookings can be moved up to ${Math.round(settings().cancelCutoffMinutes / 60)} h before the start.`);
    }
    const user = who.user || null;
    const { plan } = planOf(user);
    const { hours } = checkDate(date, plan);
    const dur = row.endMin - row.startMin;
    const startMin = parseHHMM(start);
    if (!hours) throw new ApiError(400, 'closed', 'The club is closed that day', { field: 'date' });
    if (startMin === null || startMin < parseHHMM(hours.open) || startMin + dur > parseHHMM(hours.close)) {
      throw new ApiError(400, 'outside_hours', `Open ${hours.open}–${hours.close} that day`, { field: 'start' });
    }
    const t = today();
    if (date === t.date && startMin < t.minutes + settings().minNoticeMinutes) throw new ApiError(400, 'in_past', 'That time has already passed');
    const area = areaOrDefault(areaId === undefined ? row.areaId : areaId);
    // Cancel + rebook in one transaction: the old slot is only given up if the new one is free.
    const run = db.transaction(() => {
      const table = freeTable(area, date, startMin, startMin + dur, { excludeBookingId: row.id });
      if (!table) throw new ApiError(409, 'slot_taken', 'That time was just taken. Pick another time.');
      const moved = { ...row, date, startMin, endMin: startMin + dur };
      stmts.move.run({
        id: row.id, date, startMin, endMin: startMin + dur, tableId: table.id,
        checkInCode: checkIn.sign({ bookingId: row.id, userId: row.userId, expiresAt: endsAt(moved) }), now: iso(),
      });
    });
    run.immediate();
    const v = view(stmts.byId.get(row.id), { owner: true });
    notifier.notify({
      userId: row.userId, email: row.email, type: 'booking_moved', title: 'Booking moved',
      body: `Now ${prettyDay(date)} · ${v.start}–${v.end} · ${v.where}`,
      emailSubject: `Moved: now ${prettyDay(date)} ${v.start}`,
      emailText: `Your booking #RC-${row.code} is now on ${prettyDay(date)}, ${v.start}–${v.end} (${v.where}). Your QR code has been updated.`,
    });
    return v;
  }

  // ---------- check-in (front desk) ----------

  // token: the QR content; code: typed at the desk. QR codes work from 15 min before the start
  // until the end; a typed code works any time that day.
  function checkInBooking({ token, code } = {}) {
    let row;
    if (token) {
      const payload = checkIn.verify(token);
      if (!payload) throw new ApiError(400, 'invalid_code', "This QR code isn't a Rally Club check-in code.");
      row = stmts.byId.get(payload.bookingId);
      if (!row || row.checkInCode !== String(token).trim()) {
        throw new ApiError(409, 'stale_code', 'This code is out of date: the booking was moved or cancelled. Search by name instead.');
      }
      const toStart = minutesToStart(row);
      if (toStart > EARLY_CHECKIN_MINUTES) throw new ApiError(409, 'too_early', `Too early: check-in opens ${EARLY_CHECKIN_MINUTES} min before ${formatHHMM(row.startMin)} on ${row.date}.`);
      if (minutesUntil(row.date, row.endMin, today()) <= 0) throw new ApiError(409, 'expired', 'This booking has already ended.');
    } else {
      row = stmts.byCode.get(String(code ?? '').trim().toUpperCase().replace(/^#?RC-/, ''));
      if (!row) throw new ApiError(404, 'booking_not_found', 'No booking with that code.');
    }
    if (row.status === 'checked_in') return { already: true, booking: adminView(row) };
    if (!['confirmed', 'no_show'].includes(row.status)) throw new ApiError(409, 'not_active', `This booking is ${row.status.replace('_', ' ')}.`);
    stmts.setStatus.run('checked_in', iso(), row.id);
    return { already: false, booking: adminView(stmts.byId.get(row.id)) };
  }

  // Everything staff need, contact details included
  function adminView(row) {
    return {
      ...view(row),
      id: row.id, name: row.name, phone: row.phone, email: row.email, userId: row.userId, source: row.source,
      type: row.type, holdExpiresAt: row.holdExpiresAt, createdAt: row.createdAt,
    };
  }

  // ---------- split the cost ----------

  function share(payToken) {
    const p = payToken && stmts.participantByToken.get(String(payToken));
    if (!p) throw new ApiError(404, 'share_not_found', 'This payment link is not valid.');
    const row = stmts.byId.get(p.bookingId);
    return { participant: p, row };
  }

  function shareView(payToken) {
    const { participant, row } = share(payToken);
    return {
      ...summary(row), organizer: row.name.split(' ')[0], amount: participant.shareAmount, currency: settings().currency,
      paid: !!participant.paid, covered: !!participant.coveredByOrganizerAt, status: row.status,
    };
  }

  async function payShare(payToken, { baseUrl } = {}) {
    const { participant, row } = share(payToken);
    if (participant.paid || participant.coveredByOrganizerAt) return { paid: true };
    if (row.status !== 'confirmed') throw new ApiError(409, 'not_payable', 'This booking is no longer active.');
    const result = await payments.charge({
      kind: 'SHARE', amount: participant.shareAmount, bookingId: row.id, participantId: participant.id,
      description: `Your share · table ${row.date} ${formatHHMM(row.startMin)}`,
      successUrl: `${baseUrl}/pay.html?t=${encodeURIComponent(payToken)}&paid=1`, cancelUrl: `${baseUrl}/pay.html?t=${encodeURIComponent(payToken)}`,
    });
    if (result.status === 'redirect') return { redirect: result.url };
    stmts.markShare.run(iso(), participant.id);
    return { paid: true };
  }

  // ---------- jobs ----------

  async function runJobs() {
    expireHolds();
    const t = today();
    // No-show: not checked in 15 min after the start
    for (const { id } of stmts.dueNoShows.all({ date: t.date, minutes: t.minutes })) stmts.setStatus.run('no_show', iso(), id);
    // Split the cost: 2 h before, the organizer covers what's still unpaid
    for (const { id } of stmts.splitDue.all()) {
      const row = stmts.byId.get(id);
      if (minutesToStart(row) > SPLIT_DEADLINE_MINUTES) continue;
      const unpaid = stmts.participants.all(id).filter(p => !p.paid && !p.coveredByOrganizerAt);
      const amount = round2(unpaid.reduce((s, p) => s + p.shareAmount, 0));
      stmts.coverShares.run(iso(), id);
      if (!amount || !row.userId) continue;
      const result = await payments.chargeSaved({ kind: 'REMAINDER', amount, userId: row.userId, bookingId: id, description: `Unpaid shares · table ${row.code}` });
      const money = `${amount} ${settings().currency}`;
      notifier.notify({
        userId: row.userId, type: 'split_remainder',
        title: result.status === 'succeeded' ? 'We charged the unpaid shares' : 'Unpaid shares due at the desk',
        body: result.status === 'succeeded'
          ? `${unpaid.length} player${unpaid.length === 1 ? '' : 's'} didn't pay, so ${money} went on your card.`
          : `${unpaid.length} player${unpaid.length === 1 ? '' : 's'} didn't pay. Please pay ${money} at the desk.`,
      });
    }
  }

  return {
    availability, freeToday, areas: areasList, hold, release, holdView, quote, checkout, finalize,
    get, mine, cancel, reschedule, shareView, payShare, runJobs, expireHolds, view, planOf,
    byCode: code => stmts.byCode.get(code),
    insertHoldRow, hooks, packLeft, LEVEL_LABEL, checkInBooking, adminView, byId: id => stmts.byId.get(id), SELECT,
  };
}

module.exports = { createReservations, HOLD_MINUTES, CREDIT_MAX_MINUTES, SPLIT_DEADLINE_MINUTES };
