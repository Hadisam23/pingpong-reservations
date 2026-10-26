// Lessons & classes (Phase 5): coaches and their free slots, lesson holds, group classes with
// capacity, the waitlist (a freed seat is offered to #1 for 2 hours, then #2), and lesson packs.
// Holds, checkout, cancel and refunds go through reservations.js like table bookings.
const { ApiError } = require('./service');
const { OCCUPYING } = require('./occupancy');
const { formatHHMM, parseHHMM, isValidDate, weekday, addDays, nowIn, zonedToUtc } = require('./time');

const LESSON_WINDOW_DAYS = 14;
const CLASS_WINDOW_DAYS = 14;
const OFFER_HOURS = 2;
const PACK_MONTHS = 6;
// Pack sizes and their saving on the private-lesson price; members save another 10%.
const LESSON_PACKS = [{ size: 5, discountPct: 10 }, { size: 10, discountPct: 15 }];
const MEMBER_PACK_DISCOUNT_PCT = 10;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function createLessons(db, { service, reservations, payments, notifier, now = () => new Date() }) {
  const stmts = {
    coaches: db.prepare(`SELECT c.*, u.name FROM coaches c JOIN users u ON u.id = c.userId WHERE c.active = 1 ORDER BY c.id`),
    coach: db.prepare('SELECT c.*, u.name FROM coaches c JOIN users u ON u.id = c.userId WHERE c.id = ? AND c.active = 1'),
    hours: db.prepare('SELECT startTime, endTime FROM coach_availability WHERE coachId = ? AND dayOfWeek = ? ORDER BY startTime'),
    timeOff: db.prepare('SELECT 1 FROM coach_time_off WHERE coachId = ? AND startDate <= ? AND endDate >= ? LIMIT 1'),
    coachBookings: db.prepare(`SELECT startMin, endMin FROM bookings WHERE coachId = @coachId AND date = @date AND ${OCCUPYING}`),
    coachClasses: db.prepare('SELECT startsAt, endsAt FROM class_sessions WHERE coachId = ? AND startsAt < ? AND endsAt > ?'),
    lessonTypes: db.prepare('SELECT * FROM lesson_types WHERE active = 1 ORDER BY sortOrder, id'),
    lessonType: db.prepare('SELECT * FROM lesson_types WHERE id = ? AND active = 1'),
    tables: db.prepare(`SELECT t.* FROM tables t LEFT JOIN areas a ON a.id = t.areaId WHERE t.active = 1
      ORDER BY COALESCE(a.sortOrder, 99), t.number, t.id`),
    classes: db.prepare(`SELECT cs.*, u.name AS coachName FROM class_sessions cs
      LEFT JOIN coaches c ON c.id = cs.coachId LEFT JOIN users u ON u.id = c.userId
      WHERE cs.startsAt >= ? AND cs.startsAt < ? ORDER BY cs.startsAt`),
    classById: db.prepare('SELECT * FROM class_sessions WHERE id = ?'),
    classWithCoach: db.prepare(`SELECT cs.*, u.name AS coachName FROM class_sessions cs
      LEFT JOIN coaches c ON c.id = cs.coachId LEFT JOIN users u ON u.id = c.userId WHERE cs.id = ?`),
    seatsTaken: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE classSessionId = @id AND ${OCCUPYING}`),
    mySeat: db.prepare("SELECT code FROM bookings WHERE classSessionId = ? AND userId = ? AND status IN ('confirmed', 'checked_in')"),
    waitlist: db.prepare('SELECT * FROM waitlist WHERE classSessionId = ? ORDER BY position, id'),
    myWait: db.prepare('SELECT * FROM waitlist WHERE classSessionId = ? AND userId = ?'),
    offersHeld: db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE classSessionId = ? AND offerExpiresAt > ? AND userId != ?'),
    joinWait: db.prepare(`INSERT INTO waitlist (classSessionId, userId, position, createdAt)
      VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM waitlist WHERE classSessionId = ?), ?)`),
    leaveWait: db.prepare('DELETE FROM waitlist WHERE classSessionId = ? AND userId = ?'),
    renumber: db.prepare('UPDATE waitlist SET position = position - 1 WHERE classSessionId = ? AND position > ?'),
    offer: db.prepare('UPDATE waitlist SET notifiedAt = ?, offerExpiresAt = ? WHERE id = ?'),
    expiredOffers: db.prepare('SELECT * FROM waitlist WHERE offerExpiresAt IS NOT NULL AND offerExpiresAt <= ?'),
    waitingClasses: db.prepare('SELECT DISTINCT classSessionId AS id FROM waitlist'),
    insertPack: db.prepare('INSERT INTO lesson_packs (userId, lessonsTotal, lessonsUsed, expiresAt, createdAt, paymentId) VALUES (?, ?, 0, ?, ?, ?)'),
    ledger: db.prepare('INSERT INTO credit_ledger (userId, type, delta, reason, bookingId, createdAt) VALUES (?, ?, ?, ?, NULL, ?)'),
    packs: db.prepare('SELECT * FROM lesson_packs WHERE userId = ? AND expiresAt > ? ORDER BY expiresAt'),
  };

  const settings = () => service.getSettings();
  const tz = () => settings().timezone;
  const today = () => nowIn(tz(), now());
  const iso = () => now().toISOString();
  const LEVELS = reservations.LEVEL_LABEL;
  const initials = name => name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const local = isoString => nowIn(tz(), new Date(isoString));

  function dayLabel(date) {
    const t = today().date;
    if (date === t) return 'Today';
    if (date === addDays(t, 1)) return 'Tomorrow';
    return DOW[weekday(date)];
  }

  // ---------- coaches ----------

  function levelLine(levels) {
    const adult = ['beginner', 'intermediate', 'advanced'];
    if (adult.every(l => levels.includes(l))) return 'all levels';
    return levels.map(l => (LEVELS[l] || l).toLowerCase()).join(' & ');
  }

  function coachCard(c, { withNext = true } = {}) {
    const specialties = JSON.parse(c.specialties);
    const levels = JSON.parse(c.levels);
    const next = withNext ? nextFree(c.id) : null;
    return {
      id: c.id, name: c.name, initials: initials(c.name), certification: c.certification, yearsCoaching: c.yearsCoaching,
      bio: c.bio, specialties, levels, line: [...specialties, levelLine(levels)].join(' · ').replace(/^./, m => m.toUpperCase()),
      nextFree: next ? { ...next, label: `${dayLabel(next.date)} ${next.time}` } : null,
    };
  }

  function coaches({ level } = {}) {
    return stmts.coaches.all()
      .filter(c => !level || level === 'all' || JSON.parse(c.levels).includes(level))
      .map(c => coachCard(c));
  }

  function requireCoach(id) {
    const c = stmts.coach.get(Number(id));
    if (!c) throw new ApiError(404, 'coach_not_found', 'Coach not found');
    return c;
  }

  function lessonTypes() {
    return stmts.lessonTypes.all().map(t => ({
      id: t.id, name: t.name, short: t.name.replace(/ lesson$/i, ''), durationMin: t.durationMin, maxStudents: t.maxStudents,
      price: t.price, description: t.description,
    }));
  }

  function coachDetail(id) {
    const c = requireCoach(id);
    return { ...coachCard(c), lessonTypes: lessonTypes(), currency: settings().currency, packs: packOffers(null) };
  }

  // Minutes the coach is already teaching on a date (lessons and classes)
  function coachBusy(coachId, date) {
    const from = zonedToUtc(date, 0, tz());
    const to = zonedToUtc(addDays(date, 1), 0, tz());
    const busy = stmts.coachBookings.all({ coachId, date, now: iso() }).map(b => ({ start: b.startMin, end: b.endMin }));
    for (const cl of stmts.coachClasses.all(coachId, to, from)) {
      const s = local(cl.startsAt);
      const e = local(cl.endsAt);
      busy.push({ start: s.date < date ? 0 : s.minutes, end: e.date > date ? 1440 : e.minutes });
    }
    return busy;
  }

  // The table a lesson would use: the first free one (Main hall first)
  function tableFor(date, start, end, tableBusy) {
    return stmts.tables.all().find(t => !(tableBusy.get(t.id) || []).some(i => i.start < end && i.end > start)) || null;
  }

  function slotsFor(coachId, date, duration) {
    const t = today();
    if (date < t.date || date > addDays(t.date, LESSON_WINDOW_DAYS)) return [];
    if (stmts.timeOff.get(coachId, date, date)) return [];
    const hours = settings().hours[weekday(date)];
    if (!hours) return [];
    const open = parseHHMM(hours.open);
    const close = parseHHMM(hours.close);
    const earliest = date === t.date ? t.minutes + settings().minNoticeMinutes : -1;
    const busy = coachBusy(coachId, date);
    const tableBusy = service.occupancy.busyOn(date);
    const out = [];
    for (const w of stmts.hours.all(coachId, weekday(date))) {
      const from = Math.max(open, parseHHMM(w.startTime));
      const to = Math.min(close, parseHHMM(w.endTime));
      for (let s = from; s + duration <= to; s += settings().slotMinutes) {
        if (s < earliest || busy.some(b => b.start < s + duration && b.end > s)) continue;
        if (tableFor(date, s, s + duration, tableBusy)) out.push({ time: formatHHMM(s), start: s });
      }
    }
    return out;
  }

  function nextFree(coachId) {
    const duration = (stmts.lessonTypes.all()[0] || { durationMin: 60 }).durationMin;
    const t = today().date;
    for (let i = 0; i <= LESSON_WINDOW_DAYS; i++) {
      const date = addDays(t, i);
      const slot = slotsFor(coachId, date, duration)[0];
      if (slot) return { date, time: slot.time };
    }
    return null;
  }

  function requireLessonType(id) {
    const lt = stmts.lessonType.get(Number(id));
    if (!lt) throw new ApiError(400, 'invalid_lesson_type', 'Pick a lesson type', { field: 'lessonType' });
    return lt;
  }

  function coachSlots(id, { date, lessonType } = {}) {
    const c = requireCoach(id);
    const lt = lessonType ? requireLessonType(lessonType) : stmts.lessonTypes.all()[0];
    const t = today().date;
    const days = Array.from({ length: LESSON_WINDOW_DAYS + 1 }, (_, i) => {
      const d = addDays(t, i);
      const n = slotsFor(c.id, d, lt.durationMin).length;
      return { date: d, dow: DOW[weekday(d)], num: Number(d.slice(8)), free: n };
    });
    const day = date || (days.find(d => d.free) || days[0]).date;
    if (!isValidDate(day)) throw new ApiError(400, 'invalid_date', 'Date must be YYYY-MM-DD', { field: 'date' });
    return { date: day, lessonType: lt.id, duration: lt.durationMin, slots: slotsFor(c.id, day, lt.durationMin).map(s => s.time), days };
  }

  function holdLesson({ coachId, lessonType, date, start } = {}, { user }) {
    const c = requireCoach(coachId);
    const lt = requireLessonType(lessonType);
    const startMin = parseHHMM(start);
    if (!isValidDate(date) || startMin === null) throw new ApiError(400, 'invalid_time', 'Pick a day and a time', { field: 'start' });
    const create = db.transaction(() => {
      if (!slotsFor(c.id, date, lt.durationMin).some(s => s.start === startMin)) {
        throw new ApiError(409, 'slot_taken', 'That time was just taken. Pick another time.');
      }
      const table = tableFor(date, startMin, startMin + lt.durationMin, service.occupancy.busyOn(date));
      return reservations.insertHoldRow({
        user, kind: 'LESSON', tableId: table.id, date, startMin, endMin: startMin + lt.durationMin,
        players: 1, price: lt.price, basePrice: lt.price, coachId: c.id, lessonTypeId: lt.id,
      });
    });
    return create.immediate();
  }

  // ---------- classes ----------

  function seatsLeft(cls, userId = 0) {
    const taken = stmts.seatsTaken.get({ id: cls.id, now: iso() }).n;
    const offers = stmts.offersHeld.get(cls.id, iso(), userId || 0).n;
    return { taken, left: Math.max(0, cls.capacity - taken - offers) };
  }

  function classView(cls, user) {
    const s = local(cls.startsAt);
    const e = local(cls.endsAt);
    const { taken, left } = seatsLeft(cls, user && user.id);
    const seat = user ? stmts.mySeat.get(cls.id, user.id) : null;
    const wait = user ? stmts.myWait.get(cls.id, user.id) : null;
    const offered = !!(wait && wait.offerExpiresAt && wait.offerExpiresAt > iso());
    return {
      id: cls.id, title: cls.title, kind: cls.kind, level: cls.level, levelLabel: LEVELS[cls.level] || cls.level,
      coach: cls.coachName || null, date: s.date, start: formatHHMM(s.minutes), end: formatHHMM(e.minutes),
      duration: Math.round((new Date(cls.endsAt) - new Date(cls.startsAt)) / 60000),
      capacity: cls.capacity, taken: Math.min(taken, cls.capacity), spotsLeft: left, full: left === 0 && !offered,
      price: cls.price, currency: settings().currency,
      joined: seat ? seat.code : null,
      waitlist: wait ? { position: wait.position, offered, offerExpiresAt: offered ? wait.offerExpiresAt : null } : null,
    };
  }

  function classes({ level, user } = {}) {
    const from = iso();
    const to = new Date(now().getTime() + CLASS_WINDOW_DAYS * 86400000).toISOString();
    return stmts.classes.all(from, to)
      .filter(c => !level || level === 'all' || c.level === level || c.level === 'all')
      .map(c => classView(c, user));
  }

  function requireClass(id) {
    const cls = stmts.classById.get(Number(id));
    if (!cls) throw new ApiError(404, 'class_not_found', 'Class not found');
    if (cls.startsAt <= iso()) throw new ApiError(409, 'class_started', 'This class has already started.');
    return cls;
  }

  function join(id, { user }) {
    const create = db.transaction(() => {
      const cls = requireClass(id);
      if (stmts.mySeat.get(cls.id, user.id)) throw new ApiError(409, 'already_joined', "You're already in this class.");
      // Capacity check and the hold happen in one transaction
      if (seatsLeft(cls, user.id).left < 1) throw new ApiError(409, 'class_full', 'This class is full. Join the waitlist instead.');
      const s = local(cls.startsAt);
      const e = local(cls.endsAt);
      return reservations.insertHoldRow({
        user, kind: 'CLASS', date: s.date, startMin: s.minutes, endMin: e.date > s.date ? 1440 : e.minutes,
        players: 1, price: cls.price, basePrice: cls.price, classSessionId: cls.id,
      });
    });
    return create.immediate();
  }

  function joinWaitlist(id, { user }) {
    const cls = requireClass(id);
    if (stmts.mySeat.get(cls.id, user.id)) throw new ApiError(409, 'already_joined', "You're already in this class.");
    if (seatsLeft(cls, user.id).left > 0) throw new ApiError(409, 'not_full', 'There are spots left. Join the class instead.');
    if (!stmts.myWait.get(cls.id, user.id)) stmts.joinWait.run(cls.id, user.id, cls.id, iso());
    return classView(stmts.classWithCoach.get(cls.id), user);
  }

  function removeFromWaitlist(classId, userId) {
    const w = stmts.myWait.get(classId, userId);
    if (!w) return;
    stmts.leaveWait.run(classId, userId);
    stmts.renumber.run(classId, w.position);
  }

  function leaveWaitlist(id, { user }) {
    const cls = stmts.classById.get(Number(id));
    if (!cls) throw new ApiError(404, 'class_not_found', 'Class not found');
    db.transaction(() => {
      removeFromWaitlist(cls.id, user.id);
      offerNext(cls.id);   // their offer, if they had one, goes to the next person
    })();
  }

  // A seat is free: offer it to the first person on the waitlist who has no offer yet
  function offerNext(classId) {
    const cls = stmts.classById.get(classId);
    if (!cls || cls.startsAt <= iso()) return;
    let { left } = seatsLeft(cls, 0);
    for (const w of stmts.waitlist.all(classId)) {
      if (left < 1) break;
      if (w.offerExpiresAt) continue;
      const until = new Date(Math.min(now().getTime() + OFFER_HOURS * 3600000, new Date(cls.startsAt).getTime())).toISOString();
      stmts.offer.run(iso(), until, w.id);
      left -= 1;
      const s = local(cls.startsAt);
      notifier.notify({
        userId: w.userId, type: 'waitlist_offer', title: 'A spot opened up',
        body: `${cls.title} · ${DOW[weekday(s.date)]} ${formatHHMM(s.minutes)}. It's yours if you confirm within ${OFFER_HOURS} hours.`,
        emailSubject: `A spot opened in ${cls.title}`,
        emailText: `Good news: a spot opened in ${cls.title} (${s.date}, ${formatHHMM(s.minutes)}).\nIt's held for you for ${OFFER_HOURS} hours. Open the app → Lessons → Group classes to confirm.`,
      });
    }
  }

  reservations.hooks.claimSeat = row => {
    if (row.userId) removeFromWaitlist(row.classSessionId, row.userId);
  };
  reservations.hooks.seatFreed = classId => offerNext(classId);

  function runJobs() {
    // Offers not taken in time: that person leaves the list, the seat moves on
    for (const w of stmts.expiredOffers.all(iso())) {
      removeFromWaitlist(w.classSessionId, w.userId);
      notifier.notify({ userId: w.userId, type: 'waitlist_expired', title: 'Waitlist spot released', body: 'The spot we held for you has gone to the next person.' });
    }
    // Seats freed by expired holds or cancellations
    for (const { id } of stmts.waitingClasses.all()) offerNext(id);
  }

  // ---------- lesson packs ----------

  function packOffers(user) {
    const base = (stmts.lessonTypes.all()[0] || { price: 0 }).price;
    const member = !!(user && reservations.planOf(user).pricingPlan);
    return LESSON_PACKS.map(p => {
      const pct = p.discountPct + (member ? MEMBER_PACK_DISCOUNT_PCT : 0);
      const price = Math.round(p.size * base * (1 - pct / 100));
      return { size: p.size, price, perLesson: Math.round(price / p.size), savePct: pct, full: p.size * base };
    });
  }

  function packsView(user) {
    const packs = stmts.packs.all(user.id, iso());
    const left = packs.reduce((n, p) => n + p.lessonsTotal - p.lessonsUsed, 0);
    const total = packs.reduce((n, p) => n + p.lessonsTotal, 0);
    return {
      offers: packOffers(user), currency: settings().currency, memberDiscount: !!reservations.planOf(user).pricingPlan,
      current: { left, total, expiresAt: packs.length ? packs[packs.length - 1].expiresAt : null },
    };
  }

  function grantPack(userId, size, paymentId) {
    const expires = new Date(now());
    expires.setMonth(expires.getMonth() + PACK_MONTHS);
    db.transaction(() => {
      stmts.insertPack.run(userId, size, expires.toISOString(), iso(), paymentId);
      stmts.ledger.run(userId, 'LESSON_PACK', size, `Bought a ${size}-lesson pack`, iso());
    })();
    notifier.notify({ userId, type: 'pack_bought', title: `${size}-lesson pack added`, body: `${size} lessons, valid for ${PACK_MONTHS} months. They're used automatically when you book.` });
  }

  async function buyPack({ size } = {}, { user, baseUrl }) {
    const offer = packOffers(user).find(p => p.size === Number(size));
    if (!offer) throw new ApiError(400, 'invalid_pack', 'Pick a pack', { field: 'size' });
    const result = await payments.charge({
      kind: 'LESSON_PACK', amount: offer.price, userId: user.id, description: `Lesson pack · ${offer.size} lessons`,
      email: user.email, saveCard: true, successUrl: `${baseUrl}/packs.html?paid=1`, cancelUrl: `${baseUrl}/packs.html`,
    });
    if (result.status === 'redirect') return { redirect: result.url };
    grantPack(user.id, offer.size, result.payment.id);
    return packsView(user);
  }
  payments.onPaid('LESSON_PACK', p => grantPack(p.userId, Number(/(\d+) lessons/.exec(p.description)[1]), p.id));

  return {
    coaches, coachDetail, coachSlots, holdLesson, lessonTypes,
    classes, join, joinWaitlist, leaveWaitlist, offerNext, runJobs,
    packsView, buyPack, packOffers,
  };
}

module.exports = { createLessons, LESSON_PACKS, OFFER_HOURS };
