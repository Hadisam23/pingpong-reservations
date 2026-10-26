// Demo data for development (Phase 3). Resets the demo world and fills every screen:
// 2 areas with 4 tables, the 3 plans, price rules, 3 coaches with weekly availability,
// lesson types, a week of classes and open play (one class full, with a waitlist),
// demo logins (player / coach / admin), random table bookings around them, and the
// demo player's own bookings, credits, lesson pack and notifications.
//
// Only demo data is replaced: bookings, blocks, classes, coaches, lesson types, price rules,
// promo codes and the @rallyclub.test accounts. Other accounts are kept.
const crypto = require('crypto');
const { parseHHMM, weekday, addDays, zonedToUtc } = require('./time');
const { hashPassword } = require('./auth');
const { DEFAULT_PLANS } = require('./plans');

const DEMO_DOMAIN = 'rallyclub.test';
const DEMO_PASSWORD = 'rally-demo-2026';

const FIRST_NAMES = ['Noa', 'Itay', 'Maya', 'Omer', 'Yael', 'Daniel', 'Shira', 'Amit', 'Tamar', 'Yosef', 'Lior', 'Adi',
  'Eitan', 'Roni', 'Hadi', 'Lina', 'Karim', 'Nadia', 'Alex', 'Sofia', 'Ben', 'Mika', 'Gal', 'Dana'];
const LAST_NAMES = ['Cohen', 'Levi', 'Mizrahi', 'Peretz', 'Biton', 'Friedman', 'Haddad', 'Khoury', 'Azoulay', 'Katz',
  'Shapiro', 'Ben-David', 'Mansour', 'Golan', 'Avraham'];

// How often each session type shows up, and the durations it tends to use.
const TYPE_MIX = [
  { id: 'casual', weight: 50, durations: [30, 60, 60, 90] },
  { id: 'training', weight: 15, durations: [30, 60] },
  { id: 'coaching', weight: 12, durations: [60, 60, 90] },
  { id: 'league', weight: 13, durations: [90, 120] },
  { id: 'party', weight: 10, durations: [120] },
];

// Tables: 3 in the main hall, 1 in the private room.
const TABLE_LAYOUT = [
  { number: 1, area: 'Main hall' }, { number: 2, area: 'Main hall' },
  { number: 3, area: 'Main hall' }, { number: 4, area: 'Private room' },
];

// Price rules per duration: Sun–Thu peak from 17:00, Fri–Sat peak all day (matches the club settings).
const PRICE_RULES = [30, 60, 90].flatMap(duration => [
  { durationMin: duration, basePrice: duration * 40 / 60, peakPrice: duration * 60 / 60, peakStart: '17:00', peakEnd: '24:00', daysOfWeek: [0, 1, 2, 3, 4] },
  { durationMin: duration, basePrice: duration * 60 / 60, peakPrice: duration * 60 / 60, peakStart: '00:00', peakEnd: '24:00', daysOfWeek: [5, 6] },
]);

// Coach names are sample content: replace them with the club's coaches.
const COACHES = [
  {
    name: 'Dana Peretz', email: `coach@${DEMO_DOMAIN}`, skillLevel: 'advanced',
    certification: 'ITTF Level 2 coach', yearsCoaching: 12,
    specialties: ['Footwork', 'Serve & return'], levels: ['beginner', 'intermediate', 'advanced'],
    bio: 'Head coach. Builds clean footwork and a serve you can trust under pressure.',
    availability: [[0, '16:00', '22:00'], [1, '16:00', '22:00'], [2, '16:00', '22:00'], [3, '16:00', '22:00'], [4, '16:00', '22:00']],
  },
  {
    name: 'Yossi Ben-David', email: `yossi@${DEMO_DOMAIN}`, skillLevel: 'advanced',
    certification: 'ITTF Level 1 coach', yearsCoaching: 6,
    specialties: ['Beginners & kids', 'Fundamentals'], levels: ['beginner', 'kids'],
    bio: 'Patient with first-timers. Runs the kids club and the beginner fundamentals class.',
    availability: [[0, '14:00', '19:00'], [2, '14:00', '19:00'], [4, '14:00', '19:00'], [5, '09:00', '13:00']],
    timeOffInDays: 5,
  },
  {
    name: 'Lina Haddad', email: `lina@${DEMO_DOMAIN}`, skillLevel: 'advanced',
    certification: 'ITTF Level 2 coach · former national team', yearsCoaching: 9,
    specialties: ['Competitive play', 'Match tactics'], levels: ['intermediate', 'advanced'],
    bio: 'Former national team player. Works on match tactics, reading spin and playing under pressure.',
    availability: [[1, '17:00', '22:00'], [3, '17:00', '22:00'], [6, '12:00', '18:00']],
  },
];

const LESSON_TYPES = [
  { name: 'Private lesson', durationMin: 60, maxStudents: 1, price: 180 },
  { name: 'Semi-private lesson', durationMin: 60, maxStudents: 2, price: 240 },
  { name: 'Video analysis', durationMin: 45, maxStudents: 1, price: 150 },
];

// A week of classes and open play. weekday 0 = Sunday. enrolled = seats taken.
const CLASSES = [
  { title: 'Beginner fundamentals', kind: 'CLASS', level: 'beginner', coach: 'Dana Peretz', weekday: 3, start: '18:00', duration: 60, capacity: 8, enrolled: 5, price: 45, tables: [1, 2] },
  { title: 'Intermediate drills', kind: 'CLASS', level: 'intermediate', coach: 'Dana Peretz', weekday: 4, start: '19:30', duration: 90, capacity: 8, enrolled: 8, price: 60, tables: [1, 2, 3] },
  { title: 'Kids club (8–12)', kind: 'CLASS', level: 'kids', coach: 'Lina Haddad', weekday: 6, start: '12:00', duration: 60, capacity: 10, enrolled: 3, price: 40, tables: [1, 2] },
  { title: 'Match tactics', kind: 'CLASS', level: 'advanced', coach: 'Lina Haddad', weekday: 1, start: '18:30', duration: 90, capacity: 6, enrolled: 4, price: 70, tables: [3] },
  { title: 'Open play', kind: 'OPEN_PLAY', level: 'all', coach: null, weekday: 0, start: '19:00', duration: 120, capacity: 12, enrolled: 7, price: 30, tables: [1, 2, 3] },
];

// Small seeded PRNG (mulberry32) so a seed number reproduces the same data.
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedDemo(db, service, { seed = Date.now(), daysBack = 3, daysAhead = 7 } = {}) {
  const rng = createRng(seed);
  const pick = list => list[Math.floor(rng() * list.length)];
  const weighted = list => {
    let r = rng() * list.reduce((s, x) => s + x.weight, 0);
    return list.find(x => (r -= x.weight) < 0) || list[0];
  };

  const settings = service.getSettings();
  const today = service.today();
  const tz = settings.timezone;
  const nowIso = new Date().toISOString();
  const knownTypes = new Set(settings.bookingTypes.map(t => t.id));
  const mix = TYPE_MIX.filter(t => knownTypes.has(t.id));
  if (mix.length === 0) throw new Error('None of the demo booking types exist in settings');

  const codes = new Set(db.prepare('SELECT code FROM bookings').all().map(r => r.code));
  const newCode = () => {
    let c;
    do { c = Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(rng() * 31)]).join(''); } while (codes.has(c));
    codes.add(c);
    return c;
  };
  const phoneNumber = () => `05${Math.floor(rng() * 10)}${String(Math.floor(rng() * 1e7)).padStart(7, '0')}`;
  const hoursOn = date => settings.hours[weekday(date)];

  const tx = db.transaction(() => {
    // ---------- reset the demo world ----------
    db.exec(`
      DELETE FROM bookings; DELETE FROM blocks; DELETE FROM waitlist; DELETE FROM class_sessions;
      DELETE FROM coaches; DELETE FROM lesson_types; DELETE FROM price_rules; DELETE FROM promo_codes;
    `);
    db.prepare('DELETE FROM users WHERE email LIKE ?').run(`%@${DEMO_DOMAIN}`);

    // ---------- areas and tables ----------
    const areaId = name => db.prepare('SELECT id FROM areas WHERE name = ?').get(name).id;
    const existing = db.prepare('SELECT id FROM tables ORDER BY id').all();
    const insertTable = db.prepare('INSERT INTO tables (name, areaId, number, active) VALUES (?, ?, ?, 1)');
    const updateTable = db.prepare('UPDATE tables SET name = ?, areaId = ?, number = ?, active = 1 WHERE id = ?');
    TABLE_LAYOUT.forEach((t, i) => {
      if (existing[i]) updateTable.run(`Table ${t.number}`, areaId(t.area), t.number, existing[i].id);
      else insertTable.run(`Table ${t.number}`, areaId(t.area), t.number);
    });
    existing.slice(TABLE_LAYOUT.length).forEach(t => db.prepare('UPDATE tables SET active = 0 WHERE id = ?').run(t.id));
    const tables = db.prepare('SELECT * FROM tables WHERE active = 1 ORDER BY number').all();
    const tableNo = n => tables.find(t => t.number === n);

    // ---------- plans and prices ----------
    const upsertPlan = db.prepare(`INSERT INTO membership_plans
      (id, name, priceMonthly, tableDiscountPct, bookingWindowDays, monthlyTableCredits, includedLessonsPerMonth,
       offPeakTablesFree, summary, perks, popular, active, sortOrder)
      VALUES (@id, @name, @priceMonthly, @tableDiscountPct, @bookingWindowDays, @monthlyTableCredits, @includedLessonsPerMonth,
       @offPeakTablesFree, @summary, @perks, @popular, 1, @sortOrder)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, priceMonthly = excluded.priceMonthly, tableDiscountPct = excluded.tableDiscountPct,
        bookingWindowDays = excluded.bookingWindowDays, monthlyTableCredits = excluded.monthlyTableCredits,
        includedLessonsPerMonth = excluded.includedLessonsPerMonth, offPeakTablesFree = excluded.offPeakTablesFree,
        summary = excluded.summary, perks = excluded.perks, popular = excluded.popular, active = 1, sortOrder = excluded.sortOrder`);
    DEFAULT_PLANS.forEach((p, i) => upsertPlan.run({
      ...p, perks: JSON.stringify(p.perks), popular: p.popular ? 1 : 0, offPeakTablesFree: p.offPeakTablesFree ? 1 : 0, sortOrder: i,
    }));
    const insertRule = db.prepare('INSERT INTO price_rules (durationMin, basePrice, peakPrice, peakStart, peakEnd, daysOfWeek) VALUES (?, ?, ?, ?, ?, ?)');
    PRICE_RULES.forEach(r => insertRule.run(r.durationMin, r.basePrice, r.peakPrice, r.peakStart, r.peakEnd, JSON.stringify(r.daysOfWeek)));

    // ---------- demo accounts ----------
    const passwordHash = hashPassword(DEMO_PASSWORD);
    const insertUser = db.prepare(`INSERT INTO users (name, email, phone, passwordHash, role, skillLevel, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMembership = db.prepare(`INSERT INTO memberships (userId, planId, status, currentPeriodEnd, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const memberSince = new Date(Date.now() - 200 * 86400000).toISOString();
    function demoUser({ name, email, role = 'PLAYER', skillLevel = 'intermediate', planId = 'dropin', periodEnd = null }) {
      const { lastInsertRowid: id } = insertUser.run(name, email, phoneNumber(), passwordHash, role, skillLevel, memberSince, nowIso);
      insertMembership.run(id, planId, 'ACTIVE', periodEnd, memberSince, nowIso);
      return id;
    }
    const playerId = demoUser({
      name: 'Noa Cohen', email: `player@${DEMO_DOMAIN}`, planId: 'club',
      periodEnd: zonedToUtc(addDays(today.date, 20), 0, tz),
    });
    demoUser({ name: 'Front Desk', email: `admin@${DEMO_DOMAIN}`, role: 'ADMIN', skillLevel: 'advanced' });

    // ---------- coaches ----------
    const insertCoach = db.prepare(`INSERT INTO coaches (userId, bio, certification, yearsCoaching, specialties, levels)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const insertAvailability = db.prepare('INSERT INTO coach_availability (coachId, dayOfWeek, startTime, endTime) VALUES (?, ?, ?, ?)');
    const insertTimeOff = db.prepare('INSERT INTO coach_time_off (coachId, startDate, endDate, reason) VALUES (?, ?, ?, ?)');
    const coachIds = {};
    for (const c of COACHES) {
      const userId = demoUser({ name: c.name, email: c.email, role: 'COACH', skillLevel: c.skillLevel });
      const { lastInsertRowid: coachId } = insertCoach.run(userId, c.bio, c.certification, c.yearsCoaching, JSON.stringify(c.specialties), JSON.stringify(c.levels));
      c.availability.forEach(([day, from, to]) => insertAvailability.run(coachId, day, from, to));
      if (c.timeOffInDays) {
        const off = addDays(today.date, c.timeOffInDays);
        insertTimeOff.run(coachId, off, off, 'Tournament');
      }
      coachIds[c.name] = coachId;
    }

    const insertLessonType = db.prepare('INSERT INTO lesson_types (name, durationMin, maxStudents, price) VALUES (?, ?, ?, ?)');
    const lessonTypeIds = LESSON_TYPES.map(l => insertLessonType.run(l.name, l.durationMin, l.maxStudents, l.price).lastInsertRowid);

    // ---------- bookings ----------
    const insertBooking = db.prepare(`INSERT INTO bookings
      (code, manageToken, tableId, date, startMin, endMin, name, phone, players, price, type, status, source,
       createdAt, updatedAt, userId, kind, coachId, lessonTypeId, classSessionId, paymentMethod)
      VALUES (@code, @manageToken, @tableId, @date, @startMin, @endMin, @name, @phone, @players, @price, @type, @status, @source,
       @createdAt, @createdAt, @userId, @kind, @coachId, @lessonTypeId, @classSessionId, @paymentMethod)`);
    const book = b => insertBooking.run({
      code: newCode(), manageToken: crypto.randomBytes(24).toString('base64url'), phone: null, players: 2,
      type: 'casual', status: 'confirmed', source: 'online', createdAt: nowIso, userId: null, kind: 'TABLE',
      coachId: null, lessonTypeId: null, classSessionId: null, paymentMethod: 'CARD', ...b,
    }).lastInsertRowid;
    const clearTable = (tableId, date, startMin, endMin) => db.prepare(`DELETE FROM bookings
      WHERE tableId = ? AND date = ? AND startMin < ? AND endMin > ?`).run(tableId, date, endMin, startMin);
    const statusFor = (date, endMin, r = rng()) => {
      const past = date < today.date || (date === today.date && endMin <= today.minutes);
      if (past) return r < 0.8 ? 'checked_in' : r < 0.9 ? 'no_show' : 'cancelled';
      return r < 0.08 ? 'cancelled' : 'confirmed';
    };

    // Random table bookings across every table
    let generated = 0;
    for (let d = -daysBack; d <= daysAhead; d++) {
      const date = addDays(today.date, d);
      const hours = hoursOn(date);
      if (!hours) continue;
      const open = parseHHMM(hours.open);
      const close = parseHHMM(hours.close);
      const busyDay = settings.pricing.peakDays.includes(weekday(date));
      for (const table of tables) {
        let t = open;
        while (t < close) {
          // Evenings and peak days fill up more.
          const chance = (busyDay ? 0.4 : 0.22) + (t >= 17 * 60 ? 0.25 : 0);
          if (rng() > chance) { t += settings.slotMinutes; continue; }
          const type = weighted(mix);
          const typeSettings = settings.bookingTypes.find(x => x.id === type.id);
          let duration = pick(type.durations);
          if (typeSettings.minDuration) duration = Math.max(duration, typeSettings.minDuration);
          if (t + duration > close) { t += settings.slotMinutes; continue; }
          const end = t + duration;
          let status = statusFor(date, end);
          if (status === 'confirmed' && d === 0 && t <= today.minutes) status = 'checked_in';
          const fromDesk = rng() < 0.2;
          book({
            tableId: table.id, date, startMin: t, endMin: end, type: type.id, status,
            name: type.id === 'league' ? `${pick(LAST_NAMES)} vs ${pick(LAST_NAMES)}`
              : type.id === 'party' ? `${pick(FIRST_NAMES)}'s birthday` : `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
            phone: fromDesk && rng() < 0.5 ? null : phoneNumber(),
            players: Math.min(type.id === 'coaching' ? 1 + (rng() < 0.3 ? 1 : 0) : type.id === 'party' ? settings.maxPlayersPerTable : 2 + (rng() < 0.35 ? 2 : 0), settings.maxPlayersPerTable),
            price: service.quote(date, t, end, type.id),
            source: fromDesk ? 'desk' : 'online', paymentMethod: fromDesk ? 'DESK' : 'CARD',
            createdAt: new Date(Date.now() - Math.floor(rng() * 7 * 86400000)).toISOString(),
          });
          generated++;
          t = end;
        }
      }
    }

    // ---------- a week of classes ----------
    const insertClass = db.prepare(`INSERT INTO class_sessions
      (title, kind, level, coachId, tableIds, startsAt, endsAt, capacity, price, recurrenceRule, createdAt)
      VALUES (@title, @kind, @level, @coachId, @tableIds, @startsAt, @endsAt, @capacity, @price, 'FREQ=WEEKLY', @createdAt)`);
    const classes = [];
    for (const c of CLASSES) {
      const start = parseHHMM(c.start);
      let offset = (c.weekday - weekday(today.date) + 7) % 7;
      if (offset === 0 && start <= today.minutes) offset = 7;
      const date = addDays(today.date, offset);
      const end = start + c.duration;
      const tableIds = c.tables.map(n => tableNo(n).id);
      tableIds.forEach(id => clearTable(id, date, start, end)); // the class has the tables to itself
      const { lastInsertRowid: id } = insertClass.run({
        ...c, coachId: c.coach ? coachIds[c.coach] : null, tableIds: JSON.stringify(tableIds),
        startsAt: zonedToUtc(date, start, tz), endsAt: zonedToUtc(date, end, tz), createdAt: nowIso,
      });
      classes.push({ ...c, id, date, start, end });
    }

    // ---------- the demo player's own bookings ----------
    // Tomorrow evening on table 3: the "Next up" card
    const tomorrow = addDays(today.date, 1);
    const evening = date => Math.min(18 * 60, parseHHMM(hoursOn(date).close) - 60);
    const nextStart = evening(tomorrow);
    clearTable(tableNo(3).id, tomorrow, nextStart, nextStart + 60);
    book({
      userId: playerId, tableId: tableNo(3).id, date: tomorrow, startMin: nextStart, endMin: nextStart + 60, name: 'Noa Cohen',
      price: service.quote(tomorrow, nextStart, nextStart + 60, 'casual'), paymentMethod: 'CARD',
    });
    // A private lesson with Dana on her next working evening, paid from the lesson pack
    let lessonDate = addDays(today.date, 2);
    while (![0, 1, 2, 3, 4].includes(weekday(lessonDate))) lessonDate = addDays(lessonDate, 1);
    clearTable(tableNo(1).id, lessonDate, 19 * 60, 20 * 60);
    book({
      userId: playerId, tableId: tableNo(1).id, date: lessonDate, startMin: 19 * 60, endMin: 20 * 60, name: 'Noa Cohen', players: 1,
      type: 'coaching', kind: 'LESSON', coachId: coachIds['Dana Peretz'], lessonTypeId: lessonTypeIds[0], price: LESSON_TYPES[0].price, paymentMethod: 'PACK',
    });
    // Played three days ago with a table credit
    const pastDate = addDays(today.date, -3);
    const pastStart = evening(pastDate) - 60;
    clearTable(tableNo(2).id, pastDate, pastStart, pastStart + 60);
    const pastBookingId = book({
      userId: playerId, tableId: tableNo(2).id, date: pastDate, startMin: pastStart, endMin: pastStart + 60, name: 'Noa Cohen',
      status: 'checked_in', price: service.quote(pastDate, pastStart, pastStart + 60, 'casual'), paymentMethod: 'CREDIT',
    });

    // ---------- class seats (no single table, so tableId is empty) ----------
    for (const c of classes) {
      for (let i = 0; i < c.enrolled; i++) {
        const isPlayer = c.kind === 'OPEN_PLAY' && i === 0;
        book({
          tableId: null, date: c.date, startMin: c.start, endMin: c.end, players: 1, kind: 'CLASS', classSessionId: c.id,
          userId: isPlayer ? playerId : null, name: isPlayer ? 'Noa Cohen' : `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
          phone: phoneNumber(), price: c.price, status: statusFor(c.date, c.end, 0.95),
        });
      }
    }
    // Intermediate drills is full: the demo player is first on the waitlist
    const full = classes.find(c => c.enrolled >= c.capacity);
    db.prepare('INSERT INTO waitlist (classSessionId, userId, position, createdAt) VALUES (?, ?, 1, ?)').run(full.id, playerId, nowIso);

    // ---------- credits, lesson pack, promo code, notifications ----------
    const ledger = db.prepare('INSERT INTO credit_ledger (userId, type, delta, reason, bookingId, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
    ledger.run(playerId, 'TABLE_CREDIT', 4, 'Club plan: monthly table credits', null, nowIso);
    ledger.run(playerId, 'TABLE_CREDIT', -1, 'Used for a table booking', pastBookingId, nowIso);
    db.prepare('INSERT INTO lesson_packs (userId, lessonsTotal, lessonsUsed, expiresAt, createdAt) VALUES (?, 10, 6, ?, ?)')
      .run(playerId, zonedToUtc(addDays(today.date, 60), 0, tz), nowIso);
    ledger.run(playerId, 'LESSON_PACK', 10, 'Bought a 10-lesson pack', null, nowIso);
    ledger.run(playerId, 'LESSON_PACK', -6, 'Lessons used', null, nowIso);
    db.prepare('INSERT INTO promo_codes (code, percentOff, validFrom, validTo, maxUses) VALUES (?, ?, ?, ?, ?)')
      .run('WELCOME10', 10, zonedToUtc(addDays(today.date, -1), 0, tz), zonedToUtc(addDays(today.date, 90), 0, tz), 100);
    const notify = db.prepare('INSERT INTO notifications (userId, type, title, body, readAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
    notify.run(playerId, 'booking_confirmed', 'Table booked', `Tomorrow ${Math.floor(nextStart / 60)}:${String(nextStart % 60).padStart(2, '0')} · Table 3 · Main hall`, nowIso, nowIso);
    notify.run(playerId, 'waitlist', "You're on the waitlist", `${full.title} · you're first in line. We'll let you know if a spot opens.`, null, nowIso);

    // One maintenance block on the private room table, two days out
    const blockDate = addDays(today.date, 2);
    const blockHours = hoursOn(blockDate);
    if (blockHours) {
      const start = parseHHMM(blockHours.open);
      clearTable(tableNo(4).id, blockDate, start, start + 180);
      db.prepare('INSERT INTO blocks (tableId, date, startMin, endMin, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(tableNo(4).id, blockDate, start, start + 180, 'Maintenance: new rubber & net', nowIso);
    }

    const count = sql => db.prepare(sql).get().c;
    return {
      areas: count('SELECT COUNT(*) AS c FROM areas'),
      tables: tables.length,
      plans: count('SELECT COUNT(*) AS c FROM membership_plans WHERE active = 1'),
      priceRules: count('SELECT COUNT(*) AS c FROM price_rules'),
      coaches: count('SELECT COUNT(*) AS c FROM coaches'),
      lessonTypes: count('SELECT COUNT(*) AS c FROM lesson_types'),
      classes: count('SELECT COUNT(*) AS c FROM class_sessions'),
      bookings: count('SELECT COUNT(*) AS c FROM bookings'),
      generated,
      logins: { player: `player@${DEMO_DOMAIN}`, coach: `coach@${DEMO_DOMAIN}`, admin: `admin@${DEMO_DOMAIN}`, password: DEMO_PASSWORD },
    };
  });

  return tx.immediate();
}

module.exports = { seedDemo, createRng, DEMO_PASSWORD, DEMO_DOMAIN };
