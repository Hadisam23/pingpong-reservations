// Admin / staff panel (Phase 7): the day calendar, bookings, check-in, coaches, classes,
// pricing & plans, members, club settings and reports. Every function here assumes the
// caller is staff; app.js checks that before routing.
const { ApiError } = require('./service');
const { OCCUPYING } = require('./occupancy');
const { listPlans } = require('./plans');
const { hashPassword } = require('./auth');
const crypto = require('crypto');
const { formatHHMM, parseHHMM, isValidDate, weekday, addDays, nowIn, zonedToUtc, dayDiff } = require('./time');

const ROLES = ['PLAYER', 'COACH', 'ADMIN'];
const LEVELS = ['beginner', 'intermediate', 'advanced', 'kids', 'all'];
const bad = (field, message) => new ApiError(400, 'invalid_input', message, { field });
const round2 = n => Math.round(n * 100) / 100;

function createAdmin(db, { service, reservations, lessons, notifier, now = () => new Date() }) {
  const settings = () => service.getSettings();
  const tz = () => settings().timezone;
  const today = () => nowIn(tz(), now());
  const iso = () => now().toISOString();
  const local = isoString => nowIn(tz(), new Date(isoString));
  const requireDate = (date, field = 'date') => { if (!isValidDate(date)) throw bad(field, 'Date must be YYYY-MM-DD'); return date; };
  const requireTime = (t, field) => { const m = parseHHMM(t); if (m === null) throw bad(field, 'Time must be HH:MM'); return m; };
  const text = (v, field, max = 120, { required = true } = {}) => {
    const s = String(v ?? '').trim();
    if (required && !s) throw bad(field, 'Required');
    if (s.length > max) throw bad(field, `Up to ${max} characters`);
    return s || null;
  };
  const num = (v, field, { min = 0, max = 1e6, int = false } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw bad(field, `Enter a number from ${min} to ${max}`);
    return n;
  };

  // ======================= calendar =======================

  const stmts = {
    tables: db.prepare(`SELECT t.*, a.name AS areaName FROM tables t LEFT JOIN areas a ON a.id = t.areaId
      ORDER BY COALESCE(a.sortOrder, 99), t.number, t.id`),
    dayBookings: db.prepare(`${reservations.SELECT} WHERE b.date = ? AND b.status NOT IN ('expired') ORDER BY b.startMin`),
    blocks: db.prepare('SELECT * FROM blocks WHERE date = ? ORDER BY startMin'),
    classesBetween: db.prepare(`SELECT cs.*, u.name AS coachName,
        (SELECT COUNT(*) FROM bookings b WHERE b.classSessionId = cs.id AND ${OCCUPYING}) AS taken
      FROM class_sessions cs LEFT JOIN coaches c ON c.id = cs.coachId LEFT JOIN users u ON u.id = c.userId
      WHERE cs.startsAt < @to AND cs.endsAt > @from ORDER BY cs.startsAt`),
    closures: db.prepare('SELECT * FROM closures WHERE date >= ? ORDER BY date'),
  };

  function day(date = today().date) {
    requireDate(date);
    const s = settings();
    const closure = service.closure(date);
    const tables = stmts.tables.all().filter(t => t.active).map(t => ({ id: t.id, name: t.name, area: t.areaName }));
    const items = [];
    for (const b of stmts.dayBookings.all(date)) {
      if (b.kind === 'CLASS') continue;   // shown once, as the class block
      const v = reservations.adminView(b);
      items.push({
        type: b.kind === 'LESSON' ? 'lesson' : 'booking', code: b.code, tableIds: b.tableId ? [b.tableId] : [],
        start: b.startMin, end: b.endMin, status: b.status,
        title: b.kind === 'LESSON' ? `${b.lessonName} · ${b.name}` : b.name,
        sub: b.kind === 'LESSON' ? `with ${b.coachName}` : `${b.players} player${b.players === 1 ? '' : 's'}${b.status === 'held' ? ' · on hold' : ''}`,
        booking: v,
      });
    }
    const from = zonedToUtc(date, 0, tz());
    const to = zonedToUtc(addDays(date, 1), 0, tz());
    for (const c of stmts.classesBetween.all({ from, to, now: iso() })) {
      const st = local(c.startsAt);
      const en = local(c.endsAt);
      items.push({
        type: 'class', classId: c.id, tableIds: JSON.parse(c.tableIds), start: st.date < date ? 0 : st.minutes, end: en.date > date ? 1440 : en.minutes,
        status: 'confirmed', title: c.title, sub: `${Math.min(c.taken, c.capacity)}/${c.capacity} · ${c.coachName || 'open play'}`,
      });
    }
    for (const b of stmts.blocks.all(date)) {
      items.push({
        type: 'block', blockId: b.id, tableIds: b.tableId ? [b.tableId] : tables.map(t => t.id), start: b.startMin, end: b.endMin,
        status: 'blocked', title: b.reason || 'Blocked', sub: 'Maintenance',
      });
    }
    const hours = service.hoursOn(date);
    return {
      date, today: today().date, closed: !hours, closure: closure ? closure.reason || 'Closed' : null,
      open: hours ? hours.open : null, close: hours ? hours.close : null, slotMinutes: s.slotMinutes, tables, items,
      currency: s.currency,
    };
  }

  // ======================= bookings =======================

  function bookings({ q = '', from, to, status = '', kind = '', limit = 100 } = {}) {
    const where = ["b.status != 'expired'"];
    const params = {};
    if (q) {
      where.push('(b.code LIKE @q OR b.name LIKE @q OR b.phone LIKE @qd OR b.email LIKE @q)');
      params.q = `%${String(q).trim().replace(/^#?RC-/i, '')}%`;
      params.qd = `%${String(q).replace(/\D/g, '') || '~'}%`;
    }
    if (from) { where.push('b.date >= @from'); params.from = requireDate(from, 'from'); }
    if (to) { where.push('b.date <= @to'); params.to = requireDate(to, 'to'); }
    if (status) { where.push('b.status = @status'); params.status = status; }
    if (kind) { where.push('b.kind = @kind'); params.kind = kind; }
    const rows = db.prepare(`${reservations.SELECT} WHERE ${where.join(' AND ')} ORDER BY b.date DESC, b.startMin DESC LIMIT ${Math.min(500, Number(limit) || 100)}`).all(params);
    return rows.map(r => reservations.adminView(r));
  }

  function setStatus(code, status) {
    const row = reservations.byCode(String(code).toUpperCase());
    if (!row) throw new ApiError(404, 'booking_not_found', 'Booking not found');
    if (!['confirmed', 'checked_in', 'no_show'].includes(status)) throw bad('status', 'Status must be confirmed, checked_in or no_show');
    if (!['confirmed', 'checked_in', 'no_show'].includes(row.status)) throw new ApiError(409, 'not_active', `This booking is ${row.status}.`);
    db.prepare('UPDATE bookings SET status = ?, updatedAt = ? WHERE id = ?').run(status, iso(), row.id);
    return reservations.adminView(reservations.byId(row.id));
  }

  // ======================= coaches =======================

  const coachStmts = {
    list: db.prepare('SELECT c.*, u.name, u.email, u.phone FROM coaches c JOIN users u ON u.id = c.userId ORDER BY c.active DESC, u.name'),
    get: db.prepare('SELECT c.*, u.name, u.email, u.phone FROM coaches c JOIN users u ON u.id = c.userId WHERE c.id = ?'),
    hours: db.prepare('SELECT dayOfWeek, startTime, endTime FROM coach_availability WHERE coachId = ? ORDER BY dayOfWeek, startTime'),
    timeOff: db.prepare('SELECT * FROM coach_time_off WHERE coachId = ? AND endDate >= ? ORDER BY startDate'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  };

  function coachView(c) {
    return {
      id: c.id, userId: c.userId, name: c.name, email: c.email, phone: c.phone, bio: c.bio, certification: c.certification,
      yearsCoaching: c.yearsCoaching, specialties: JSON.parse(c.specialties), levels: JSON.parse(c.levels), active: !!c.active,
      hours: coachStmts.hours.all(c.id), timeOff: coachStmts.timeOff.all(c.id, today().date),
    };
  }
  const coachList = () => coachStmts.list.all().map(coachView);

  function cleanCoach(input) {
    const levels = Array.isArray(input.levels) ? input.levels.filter(l => LEVELS.includes(l)) : [];
    const specialties = (Array.isArray(input.specialties) ? input.specialties : String(input.specialties || '').split(','))
      .map(x => String(x).trim()).filter(Boolean).slice(0, 8);
    const hours = (input.hours || []).map((h, i) => {
      const day = num(h.dayOfWeek, `hours.${i}`, { min: 0, max: 6, int: true });
      const a = requireTime(h.startTime, `hours.${i}`);
      const b = requireTime(h.endTime, `hours.${i}`);
      if (a >= b) throw bad(`hours.${i}`, 'Start must be before end');
      return { dayOfWeek: day, startTime: formatHHMM(a), endTime: formatHHMM(b) };
    });
    return {
      name: text(input.name, 'name', 60), email: text(input.email, 'email', 254).toLowerCase(),
      bio: text(input.bio, 'bio', 400, { required: false }), certification: text(input.certification, 'certification', 80, { required: false }),
      yearsCoaching: input.yearsCoaching === '' || input.yearsCoaching == null ? null : num(input.yearsCoaching, 'yearsCoaching', { max: 70, int: true }),
      specialties, levels, hours, active: input.active === undefined ? true : !!input.active,
    };
  }

  function saveCoach(id, input = {}) {
    const c = cleanCoach(input);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)) throw bad('email', 'Enter a valid email address');
    const run = db.transaction(() => {
      let coachId = id ? Number(id) : null;
      if (coachId) {
        const existing = coachStmts.get.get(coachId);
        if (!existing) throw new ApiError(404, 'coach_not_found', 'Coach not found');
        const other = coachStmts.userByEmail.get(c.email);
        if (other && other.id !== existing.userId) throw bad('email', 'Another account uses this email');
        db.prepare('UPDATE users SET name = ?, email = ?, updatedAt = ? WHERE id = ?').run(c.name, c.email, iso(), existing.userId);
        db.prepare('UPDATE coaches SET bio = ?, certification = ?, yearsCoaching = ?, specialties = ?, levels = ?, active = ? WHERE id = ?')
          .run(c.bio, c.certification, c.yearsCoaching, JSON.stringify(c.specialties), JSON.stringify(c.levels), c.active ? 1 : 0, coachId);
      } else {
        // A coach is an account with the COACH role; reuse the account if the email exists
        let user = coachStmts.userByEmail.get(c.email);
        if (!user) {
          const r = db.prepare("INSERT INTO users (name, email, passwordHash, role, skillLevel, createdAt, updatedAt) VALUES (?, ?, ?, 'COACH', 'advanced', ?, ?)")
            .run(c.name, c.email, hashPassword(crypto.randomBytes(18).toString('base64url')), iso(), iso());
          db.prepare("INSERT INTO memberships (userId, planId, status, createdAt, updatedAt) VALUES (?, 'dropin', 'ACTIVE', ?, ?)").run(r.lastInsertRowid, iso(), iso());
          user = { id: r.lastInsertRowid };
        } else if (user.role === 'PLAYER') {
          db.prepare("UPDATE users SET role = 'COACH' WHERE id = ?").run(user.id);
        }
        if (db.prepare('SELECT 1 FROM coaches WHERE userId = ?').get(user.id)) throw bad('email', 'This person is already a coach');
        coachId = db.prepare('INSERT INTO coaches (userId, bio, certification, yearsCoaching, specialties, levels, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(user.id, c.bio, c.certification, c.yearsCoaching, JSON.stringify(c.specialties), JSON.stringify(c.levels), c.active ? 1 : 0).lastInsertRowid;
      }
      db.prepare('DELETE FROM coach_availability WHERE coachId = ?').run(coachId);
      const ins = db.prepare('INSERT INTO coach_availability (coachId, dayOfWeek, startTime, endTime) VALUES (?, ?, ?, ?)');
      for (const h of c.hours) ins.run(coachId, h.dayOfWeek, h.startTime, h.endTime);
      return coachId;
    });
    return coachView(coachStmts.get.get(run()));
  }

  function addTimeOff(coachId, { startDate, endDate, reason } = {}) {
    if (!coachStmts.get.get(Number(coachId))) throw new ApiError(404, 'coach_not_found', 'Coach not found');
    requireDate(startDate, 'startDate');
    requireDate(endDate, 'endDate');
    if (endDate < startDate) throw bad('endDate', 'End must be on or after the start');
    db.prepare('INSERT INTO coach_time_off (coachId, startDate, endDate, reason) VALUES (?, ?, ?, ?)')
      .run(Number(coachId), startDate, endDate, text(reason, 'reason', 80, { required: false }));
    return coachView(coachStmts.get.get(Number(coachId)));
  }
  function removeTimeOff(coachId, id) {
    db.prepare('DELETE FROM coach_time_off WHERE id = ? AND coachId = ?').run(Number(id), Number(coachId));
    return coachView(coachStmts.get.get(Number(coachId)));
  }

  // ======================= classes =======================

  function classList({ from = today().date, days = 28 } = {}) {
    const a = zonedToUtc(requireDate(from), 0, tz());
    const b = zonedToUtc(addDays(from, Number(days) || 28), 0, tz());
    return stmts.classesBetween.all({ from: a, to: b, now: iso() }).filter(c => c.startsAt >= a).map(c => {
      const st = local(c.startsAt);
      return {
        id: c.id, title: c.title, kind: c.kind, level: c.level, coachId: c.coachId, coach: c.coachName, tableIds: JSON.parse(c.tableIds),
        date: st.date, start: formatHHMM(st.minutes), duration: Math.round((new Date(c.endsAt) - new Date(c.startsAt)) / 60000),
        capacity: c.capacity, taken: c.taken, price: c.price, recurring: !!c.recurrenceRule,
      };
    });
  }

  function cleanClass(input) {
    const kind = input.kind === 'OPEN_PLAY' ? 'OPEN_PLAY' : 'CLASS';
    const level = LEVELS.includes(input.level) ? input.level : null;
    if (!level) throw bad('level', 'Pick a level');
    const coachId = input.coachId ? Number(input.coachId) : null;
    if (kind === 'CLASS' && !coachId) throw bad('coachId', 'Pick a coach');
    if (coachId && !coachStmts.get.get(coachId)) throw bad('coachId', 'Pick a coach');
    const active = new Set(stmts.tables.all().filter(t => t.active).map(t => t.id));
    const tableIds = (input.tableIds || []).map(Number).filter(id => active.has(id));
    if (!tableIds.length) throw bad('tableIds', 'Pick at least one table');
    return {
      title: text(input.title, 'title', 60), kind, level, coachId, tableIds,
      capacity: num(input.capacity, 'capacity', { min: 1, max: 100, int: true }), price: num(input.price, 'price', { max: 10000 }),
      duration: num(input.duration, 'duration', { min: 15, max: 480, int: true }),
    };
  }

  // Creates one session, or `weeks` weekly sessions. Refuses if a table is already taken.
  function createClass(input = {}) {
    const c = cleanClass(input);
    const date = requireDate(input.date);
    const start = requireTime(input.start, 'start');
    const weeks = input.weeks ? num(input.weeks, 'weeks', { min: 1, max: 26, int: true }) : 1;
    const ids = db.transaction(() => {
      const out = [];
      for (let w = 0; w < weeks; w++) {
        const d = addDays(date, 7 * w);
        const busy = service.occupancy.busyOn(d);
        for (const t of c.tableIds) {
          if ((busy.get(t) || []).some(i => i.start < start + c.duration && i.end > start)) {
            const name = stmts.tables.all().find(x => x.id === t).name;
            throw new ApiError(409, 'table_busy', `${name} is already booked on ${d} at that time. Pick other tables or another time.`);
          }
        }
        out.push(db.prepare(`INSERT INTO class_sessions (title, kind, level, coachId, tableIds, startsAt, endsAt, capacity, price, recurrenceRule, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.title, c.kind, c.level, c.coachId, JSON.stringify(c.tableIds),
          zonedToUtc(d, start, tz()), zonedToUtc(d, start + c.duration, tz()), c.capacity, c.price, weeks > 1 ? 'FREQ=WEEKLY' : null, iso()).lastInsertRowid);
      }
      return out;
    }).immediate();
    return { created: ids.length, ids };
  }

  function updateClass(id, input = {}) {
    const cls = db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(Number(id));
    if (!cls) throw new ApiError(404, 'class_not_found', 'Class not found');
    const title = input.title === undefined ? cls.title : text(input.title, 'title', 60);
    const capacity = input.capacity === undefined ? cls.capacity : num(input.capacity, 'capacity', { min: 1, max: 100, int: true });
    const price = input.price === undefined ? cls.price : num(input.price, 'price', { max: 10000 });
    db.prepare('UPDATE class_sessions SET title = ?, capacity = ?, price = ? WHERE id = ?').run(title, capacity, price, cls.id);
    if (capacity > cls.capacity) lessons.offerNext(cls.id);
    return classList({ from: local(cls.startsAt).date, days: 1 }).find(c => c.id === cls.id);
  }

  // Cancelling a session refunds every seat and tells the players
  async function cancelClass(id) {
    const cls = db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(Number(id));
    if (!cls) throw new ApiError(404, 'class_not_found', 'Class not found');
    const seats = db.prepare("SELECT code FROM bookings WHERE classSessionId = ? AND status IN ('confirmed', 'held')").all(cls.id);
    for (const s of seats) await reservations.cancel(s.code, { admin: true }, { refund: true });
    for (const w of db.prepare('SELECT userId FROM waitlist WHERE classSessionId = ?').all(cls.id)) {
      notifier.notify({ userId: w.userId, type: 'class_cancelled', title: `${cls.title} is cancelled`, body: 'The club cancelled this session. You were on the waitlist.' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM waitlist WHERE classSessionId = ?').run(cls.id);
      db.prepare('UPDATE bookings SET classSessionId = NULL WHERE classSessionId = ?').run(cls.id);
      db.prepare('DELETE FROM class_sessions WHERE id = ?').run(cls.id);
    })();
    return { refunded: seats.length };
  }

  // ======================= pricing & plans =======================

  function pricing() {
    return {
      currency: settings().currency,
      rules: db.prepare('SELECT * FROM price_rules ORDER BY durationMin, id').all().map(r => ({ ...r, daysOfWeek: JSON.parse(r.daysOfWeek) })),
      plans: listPlans(db),
      lessonTypes: db.prepare('SELECT * FROM lesson_types ORDER BY sortOrder, id').all().map(t => ({ ...t, active: !!t.active })),
      lessonPacks: settings().lessonPacks, memberPackDiscountPct: settings().memberPackDiscountPct,
      promos: db.prepare('SELECT * FROM promo_codes ORDER BY validTo DESC').all(),
    };
  }

  function saveRules(rules = []) {
    if (!Array.isArray(rules) || !rules.length) throw bad('rules', 'Add at least one price rule');
    const clean = rules.map((r, i) => {
      const days = (r.daysOfWeek || []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
      if (!days.length) throw bad(`rules.${i}`, 'Pick at least one day');
      const peakStart = r.peakStart ? formatHHMM(requireTime(r.peakStart, `rules.${i}`)) : null;
      const peakEnd = r.peakEnd ? formatHHMM(requireTime(r.peakEnd, `rules.${i}`)) : null;
      return {
        durationMin: num(r.durationMin, `rules.${i}`, { min: 15, max: 480, int: true }), basePrice: num(r.basePrice, `rules.${i}`),
        peakPrice: num(r.peakPrice, `rules.${i}`), peakStart, peakEnd, daysOfWeek: JSON.stringify([...new Set(days)].sort()),
      };
    });
    db.transaction(() => {
      db.prepare('DELETE FROM price_rules').run();
      const ins = db.prepare('INSERT INTO price_rules (durationMin, basePrice, peakPrice, peakStart, peakEnd, daysOfWeek) VALUES (@durationMin, @basePrice, @peakPrice, @peakStart, @peakEnd, @daysOfWeek)');
      for (const r of clean) ins.run(r);
    })();
    return pricing();
  }

  function savePlan(id, p = {}) {
    const row = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'plan_not_found', 'Plan not found');
    db.prepare(`UPDATE membership_plans SET name = ?, priceMonthly = ?, tableDiscountPct = ?, bookingWindowDays = ?, monthlyTableCredits = ?,
      includedLessonsPerMonth = ?, offPeakTablesFree = ?, summary = ?, perks = ? WHERE id = ?`).run(
      text(p.name, 'name', 30), id === 'dropin' ? 0 : num(p.price, 'price', { max: 10000 }), num(p.tableDiscountPct, 'tableDiscountPct', { max: 100 }),
      num(p.bookingWindowDays, 'bookingWindowDays', { min: 0, max: 90, int: true }), num(p.monthlyTableCredits, 'monthlyTableCredits', { max: 100, int: true }),
      num(p.includedLessonsPerMonth, 'includedLessonsPerMonth', { max: 30, int: true }), p.offPeakTablesFree ? 1 : 0,
      text(p.summary, 'summary', 160), JSON.stringify((p.perks || []).map(x => String(x).trim()).filter(Boolean).slice(0, 6)), id);
    return pricing();
  }

  function saveLessonType(id, t = {}) {
    const vals = [
      text(t.name, 'name', 40), num(t.durationMin, 'durationMin', { min: 15, max: 240, int: true }), num(t.maxStudents, 'maxStudents', { min: 1, max: 8, int: true }),
      num(t.price, 'price', { max: 10000 }), text(t.description, 'description', 120, { required: false }), t.active === false ? 0 : 1,
    ];
    if (id) db.prepare('UPDATE lesson_types SET name = ?, durationMin = ?, maxStudents = ?, price = ?, description = ?, active = ? WHERE id = ?').run(...vals, Number(id));
    else db.prepare('INSERT INTO lesson_types (name, durationMin, maxStudents, price, description, active, sortOrder) VALUES (?, ?, ?, ?, ?, ?, 99)').run(...vals);
    return pricing();
  }

  function savePacks({ lessonPacks, memberPackDiscountPct } = {}) {
    service.updateSettings({ lessonPacks: (lessonPacks || []).map(p => ({ size: Number(p.size), discountPct: Number(p.discountPct) })), memberPackDiscountPct: Number(memberPackDiscountPct) });
    return pricing();
  }

  function savePromo(p = {}) {
    const code = text(p.code, 'code', 20).toUpperCase();
    if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw bad('code', 'Use 3-20 letters and numbers');
    const percentOff = p.percentOff ? num(p.percentOff, 'percentOff', { min: 1, max: 100 }) : null;
    const amountOff = p.amountOff ? num(p.amountOff, 'amountOff', { min: 1, max: 10000 }) : null;
    if (!percentOff === !amountOff) throw bad('percentOff', 'Set a percentage or an amount');
    const validFrom = zonedToUtc(requireDate(p.validFrom, 'validFrom'), 0, tz());
    const validTo = zonedToUtc(addDays(requireDate(p.validTo, 'validTo'), 1), 0, tz());
    if (validTo <= validFrom) throw bad('validTo', 'End must be after the start');
    const maxUses = p.maxUses ? num(p.maxUses, 'maxUses', { min: 1, max: 100000, int: true }) : null;
    db.prepare(`INSERT INTO promo_codes (code, percentOff, amountOff, validFrom, validTo, maxUses) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET percentOff = excluded.percentOff, amountOff = excluded.amountOff, validFrom = excluded.validFrom,
      validTo = excluded.validTo, maxUses = excluded.maxUses`).run(code, percentOff, amountOff, validFrom, validTo, maxUses);
    return pricing();
  }
  const deletePromo = code => { db.prepare('DELETE FROM promo_codes WHERE code = ?').run(String(code).toUpperCase()); return pricing(); };

  // ======================= members =======================

  function members({ q = '', plan = '' } = {}) {
    const where = ['1 = 1'];
    const params = { now: iso() };
    if (q) { where.push('(u.name LIKE @q OR u.email LIKE @q OR u.phone LIKE @q)'); params.q = `%${String(q).trim()}%`; }
    if (plan) { where.push('COALESCE(m.planId, \'dropin\') = @plan'); params.plan = plan; }
    return db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.role, u.createdAt, COALESCE(m.planId, 'dropin') AS planId,
        COALESCE(m.status, 'ACTIVE') AS status, m.currentPeriodEnd, m.cancelAtPeriodEnd,
        (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger l WHERE l.userId = u.id AND l.type = 'TABLE_CREDIT') AS credits,
        (SELECT COALESCE(SUM(lessonsTotal - lessonsUsed), 0) FROM lesson_packs p WHERE p.userId = u.id AND p.expiresAt > @now) AS packLeft,
        (SELECT COUNT(*) FROM bookings b WHERE b.userId = u.id AND b.status IN ('confirmed', 'checked_in', 'no_show')) AS bookings,
        (SELECT MAX(date) FROM bookings b WHERE b.userId = u.id AND b.status = 'checked_in') AS lastVisit
      FROM users u LEFT JOIN memberships m ON m.userId = u.id WHERE ${where.join(' AND ')} ORDER BY u.name LIMIT 300`).all(params)
      .map(r => ({ ...r, status: r.status.toLowerCase(), cancelAtPeriodEnd: !!r.cancelAtPeriodEnd }));
  }

  function member(id) {
    const m = members({}).find(x => x.id === Number(id));
    if (!m) throw new ApiError(404, 'member_not_found', 'Member not found');
    return {
      ...m,
      history: db.prepare(`${reservations.SELECT} WHERE b.userId = ? AND b.status != 'expired' ORDER BY b.date DESC, b.startMin DESC LIMIT 100`).all(m.id)
        .map(r => reservations.adminView(r)),
      ledger: db.prepare('SELECT * FROM credit_ledger WHERE userId = ? ORDER BY id DESC LIMIT 100').all(m.id),
      payments: db.prepare('SELECT * FROM payments WHERE userId = ? ORDER BY id DESC LIMIT 100').all(m.id),
    };
  }

  function adjustCredits(id, { type = 'TABLE_CREDIT', delta, reason } = {}) {
    const m = members({}).find(x => x.id === Number(id));
    if (!m) throw new ApiError(404, 'member_not_found', 'Member not found');
    const d = num(delta, 'delta', { min: -100, max: 100, int: true });
    if (!d) throw bad('delta', 'Enter a number other than 0');
    const why = `Staff: ${text(reason, 'reason', 80)}`;
    db.transaction(() => {
      if (type === 'LESSON_PACK') {
        if (d > 0) {
          const expires = new Date(now()); expires.setMonth(expires.getMonth() + 6);
          db.prepare('INSERT INTO lesson_packs (userId, lessonsTotal, lessonsUsed, expiresAt, createdAt) VALUES (?, ?, 0, ?, ?)').run(m.id, d, expires.toISOString(), iso());
        } else {
          let left = -d;
          for (const p of db.prepare('SELECT * FROM lesson_packs WHERE userId = ? AND expiresAt > ? AND lessonsUsed < lessonsTotal ORDER BY expiresAt').all(m.id, iso())) {
            const take = Math.min(left, p.lessonsTotal - p.lessonsUsed);
            db.prepare('UPDATE lesson_packs SET lessonsUsed = lessonsUsed + ? WHERE id = ?').run(take, p.id);
            left -= take;
            if (!left) break;
          }
          if (left) throw bad('delta', 'They have fewer pack lessons than that');
        }
      } else if (m.credits + d < 0) throw bad('delta', 'Credits can’t go below 0');
      db.prepare('INSERT INTO credit_ledger (userId, type, delta, reason, bookingId, createdAt) VALUES (?, ?, ?, ?, NULL, ?)').run(m.id, type === 'LESSON_PACK' ? 'LESSON_PACK' : 'TABLE_CREDIT', d, why, iso());
    })();
    return member(m.id);
  }

  function setRole(id, role) {
    if (!ROLES.includes(role)) throw bad('role', 'Pick a role');
    db.prepare('UPDATE users SET role = ?, updatedAt = ? WHERE id = ?').run(role, iso(), Number(id));
    return member(id);
  }

  // ======================= club settings =======================

  function clubSettings() {
    const s = settings();
    return {
      centerName: s.centerName, timezone: s.timezone, currency: s.currency, hours: s.hours,
      cancelHours: s.cancelCutoffMinutes / 60, minNoticeMinutes: s.minNoticeMinutes, maxPlayersPerTable: s.maxPlayersPerTable,
      maxActiveBookingsPerPhone: s.maxActiveBookingsPerPhone,
      areas: db.prepare('SELECT * FROM areas ORDER BY sortOrder, id').all(),
      tables: stmts.tables.all().map(t => ({ id: t.id, name: t.name, number: t.number, areaId: t.areaId, area: t.areaName, active: !!t.active })),
      closures: stmts.closures.all(today().date),
    };
  }

  function saveClubSettings(p = {}) {
    service.updateSettings({
      centerName: p.centerName, timezone: p.timezone, hours: p.hours,
      cancelCutoffMinutes: Math.round(num(p.cancelHours, 'cancelHours', { max: 168 }) * 60),
      minNoticeMinutes: num(p.minNoticeMinutes, 'minNoticeMinutes', { max: 1440, int: true }),
      maxPlayersPerTable: num(p.maxPlayersPerTable, 'maxPlayersPerTable', { min: 1, max: 8, int: true }),
      maxActiveBookingsPerPhone: num(p.maxActiveBookingsPerPhone, 'maxActiveBookingsPerPhone', { min: 1, max: 100, int: true }),
    });
    return clubSettings();
  }

  function saveTable(id, t = {}) {
    const area = db.prepare('SELECT id FROM areas WHERE id = ?').get(Number(t.areaId));
    if (!area) throw bad('areaId', 'Pick an area');
    if (id) {
      service.updateTable(id, { name: t.name, active: t.active });
      db.prepare('UPDATE tables SET areaId = ? WHERE id = ?').run(area.id, Number(id));
    } else {
      const created = service.addTable(t.name);
      const n = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tables').get().n;
      db.prepare('UPDATE tables SET areaId = ?, number = ? WHERE id = ?').run(area.id, n, created.id);
    }
    return clubSettings();
  }

  function saveArea(id, a = {}) {
    const vals = [text(a.name, 'name', 40), text(a.description, 'description', 80, { required: false })];
    try {
      if (id) db.prepare('UPDATE areas SET name = ?, description = ? WHERE id = ?').run(...vals, Number(id));
      else db.prepare('INSERT INTO areas (name, description, sortOrder) VALUES (?, ?, 99)').run(...vals);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw bad('name', 'An area with this name exists');
      throw err;
    }
    return clubSettings();
  }

  function addClosure({ date, reason } = {}) {
    requireDate(date);
    db.prepare('INSERT INTO closures (date, reason, createdAt) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET reason = excluded.reason')
      .run(date, text(reason, 'reason', 80, { required: false }), iso());
    const affected = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND status = 'confirmed'").get(date).n;
    return { ...clubSettings(), affected };
  }
  const removeClosure = date => { db.prepare('DELETE FROM closures WHERE date = ?').run(date); return clubSettings(); };

  // ======================= reports =======================

  function reports({ from, to } = {}) {
    const t = today().date;
    to = to ? requireDate(to, 'to') : t;
    from = from ? requireDate(from, 'from') : addDays(to, -29);
    if (from > to) throw bad('from', 'Start must be before the end');
    const span = dayDiff(from, to) + 1;
    if (span > 366) throw bad('from', 'Pick up to a year');

    // Utilization by hour: booked table-minutes ÷ open table-minutes, per hour of the day
    const tables = stmts.tables.all().filter(x => x.active).map(x => x.id);
    const open = Array(24).fill(0);
    const used = Array(24).fill(0);
    for (let i = 0; i < span; i++) {
      const date = addDays(from, i);
      const hours = service.hoursOn(date);
      if (!hours) continue;
      const o = parseHHMM(hours.open);
      const c = parseHHMM(hours.close);
      for (let h = 0; h < 24; h++) open[h] += Math.max(0, Math.min(c, (h + 1) * 60) - Math.max(o, h * 60)) * tables.length;
      const busy = service.occupancy.busyOn(date);
      for (const id of tables) {
        for (const iv of busy.get(id) || []) {
          if (iv.kind === 'block') continue;
          for (let h = Math.floor(iv.start / 60); h * 60 < iv.end && h < 24; h++) used[h] += Math.max(0, Math.min(iv.end, (h + 1) * 60) - Math.max(iv.start, h * 60));
        }
      }
    }
    // Past check-ins/no-shows count as well: busyOn only sees live bookings
    const pastRows = db.prepare(`SELECT tableId, startMin, endMin FROM bookings WHERE date BETWEEN ? AND ? AND tableId IS NOT NULL AND status = 'no_show'`).all(from, to);
    for (const r of pastRows) for (let h = Math.floor(r.startMin / 60); h * 60 < r.endMin && h < 24; h++) used[h] += Math.max(0, Math.min(r.endMin, (h + 1) * 60) - Math.max(r.startMin, h * 60));
    const byHour = open.map((o, h) => ({ hour: h, label: `${String(h).padStart(2, '0')}:00`, pct: o ? Math.round(Math.min(1, used[h] / o) * 100) : null })).filter(x => x.pct !== null);
    const totalOpen = open.reduce((a, b) => a + b, 0);

    // Revenue: payments in the range (refunded ones are counted separately)
    const fromIso = zonedToUtc(from, 0, tz());
    const toIso = zonedToUtc(addDays(to, 1), 0, tz());
    const pay = db.prepare('SELECT kind, status, SUM(amount) AS amount, COUNT(*) AS n FROM payments WHERE createdAt >= ? AND createdAt < ? AND status IN (\'SUCCEEDED\', \'REFUNDED\') GROUP BY kind, status').all(fromIso, toIso);
    const KIND = { BOOKING: 'Bookings', SHARE: 'Split shares', REMAINDER: 'Split remainders', LESSON_PACK: 'Lesson packs', MEMBERSHIP: 'Memberships' };
    const revenue = Object.keys(KIND).map(k => ({
      kind: k, label: KIND[k], amount: round2(pay.filter(p => p.kind === k && p.status === 'SUCCEEDED').reduce((s, p) => s + p.amount, 0)),
    })).filter(r => r.amount > 0);
    const refunds = round2(pay.filter(p => p.status === 'REFUNDED').reduce((s, p) => s + p.amount, 0));

    const counts = db.prepare(`SELECT kind, status, COUNT(*) AS n FROM bookings WHERE date BETWEEN ? AND ? AND status NOT IN ('held', 'expired') GROUP BY kind, status`).all(from, to);
    const sum = (pred) => counts.filter(pred).reduce((s, c) => s + c.n, 0);
    const attended = sum(c => c.status === 'checked_in');
    const noShows = sum(c => c.status === 'no_show');

    const activeMembers = db.prepare(`SELECT planId, COUNT(*) AS n FROM memberships WHERE status = 'ACTIVE' AND planId != 'dropin' GROUP BY planId`).all();
    return {
      from, to, currency: settings().currency,
      utilization: { byHour, overall: totalOpen ? Math.round(used.reduce((a, b) => a + b, 0) / totalOpen * 100) : 0 },
      revenue: { byKind: revenue, total: round2(revenue.reduce((s, r) => s + r.amount, 0)), refunds },
      bookings: {
        tables: sum(c => c.kind === 'TABLE' && c.status !== 'cancelled'), lessons: sum(c => c.kind === 'LESSON' && c.status !== 'cancelled'),
        classSeats: sum(c => c.kind === 'CLASS' && c.status !== 'cancelled'), cancelled: sum(c => c.status === 'cancelled'),
      },
      noShowRate: attended + noShows ? Math.round(noShows / (attended + noShows) * 100) : 0, noShows, attended,
      members: {
        active: activeMembers.reduce((s, m) => s + m.n, 0), byPlan: activeMembers,
        pastDue: db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE status = 'PAST_DUE'").get().n,
        newAccounts: db.prepare('SELECT COUNT(*) AS n FROM users WHERE createdAt >= ? AND createdAt < ?').get(fromIso, toIso).n,
      },
    };
  }

  return {
    day, bookings, setStatus, coachList, saveCoach, addTimeOff, removeTimeOff,
    classList, createClass, updateClass, cancelClass,
    pricing, saveRules, savePlan, saveLessonType, savePacks, savePromo, deletePromo,
    members, member, adjustCredits, setRole,
    clubSettings, saveClubSettings, saveTable, saveArea, addClosure, removeClosure, reports,
  };
}

module.exports = { createAdmin };
