const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { zonedToUtc } = require('../src/time');

// Thu 22 Oct 2026, 15:00 in Jerusalem
const START = '2026-10-22T12:00:00Z';
const TZ = 'Asia/Jerusalem';
let server, base, created, clock, coachId, lessonTypes;

beforeEach(async () => {
  clock = new Date(START);
  created = createApp({ now: () => clock });
  const db = created.db;
  // A coach who works Sun–Thu 16:00–20:00, and the three lesson types
  const u = db.prepare("INSERT INTO users (name, email, passwordHash, role, skillLevel, createdAt, updatedAt) VALUES ('Dana Peretz', 'dana@example.com', ?, 'COACH', 'advanced', ?, ?)")
    .run(hashPassword('coach-pass-1'), START, START);
  coachId = db.prepare(`INSERT INTO coaches (userId, certification, yearsCoaching, specialties, levels) VALUES (?, 'ITTF Level 2', 12, '["Footwork"]', '["beginner","intermediate","advanced"]')`)
    .run(u.lastInsertRowid).lastInsertRowid;
  for (const d of [0, 1, 2, 3, 4]) db.prepare("INSERT INTO coach_availability (coachId, dayOfWeek, startTime, endTime) VALUES (?, ?, '16:00', '20:00')").run(coachId, d);
  const lt = db.prepare('INSERT INTO lesson_types (name, durationMin, maxStudents, price, description, sortOrder) VALUES (?, ?, ?, ?, ?, ?)');
  lessonTypes = [
    lt.run('Private lesson', 60, 1, 180, '1-on-1', 0).lastInsertRowid,
    lt.run('Semi-private lesson', 60, 2, 240, 'Bring a partner', 1).lastInsertRowid,
  ];
  await new Promise(resolve => { server = created.app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => new Promise(resolve => server.close(resolve)));

async function call(method, path, body, { token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let n = 0;
async function player(plan = 'dropin') {
  const res = await call('POST', '/api/auth/signup', {
    name: `Player ${++n}`, email: `p${n}@example.com`, phone: '052-123-4567', password: 'table-tennis', skillLevel: 'beginner', acceptTerms: true,
  });
  created.db.prepare("UPDATE memberships SET planId = ?, status = 'ACTIVE' WHERE userId = ?").run(plan, res.body.user.id);
  return { token: res.body.token, id: res.body.user.id };
}

function addClass({ title = 'Drills', kind = 'CLASS', level = 'beginner', date = '2026-10-25', start = 18 * 60, minutes = 60, capacity = 2, price = 45 } = {}) {
  return created.db.prepare(`INSERT INTO class_sessions (title, kind, level, coachId, tableIds, startsAt, endsAt, capacity, price, createdAt)
    VALUES (?, ?, ?, ?, '[1]', ?, ?, ?, ?, ?)`).run(title, kind, level, kind === 'CLASS' ? coachId : null,
    zonedToUtc(date, start, TZ), zonedToUtc(date, start + minutes, TZ), capacity, price, START).lastInsertRowid;
}

async function book(token, hold, body = {}) {
  return call('POST', `/api/holds/${hold.code}/checkout`, body, { token });
}

test('coaches: list with next free slot and level filter; detail with lesson types', async () => {
  const list = await call('GET', '/api/coaches');
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].initials, 'DP');
  assert.equal(list.body[0].line, 'Footwork · all levels');
  assert.deepEqual(list.body[0].nextFree, { date: '2026-10-22', time: '16:00', label: 'Today 16:00' });
  assert.equal((await call('GET', '/api/coaches?level=kids')).body.length, 0);
  const detail = await call('GET', `/api/coaches/${coachId}`);
  assert.deepEqual(detail.body.lessonTypes.map(t => t.short), ['Private', 'Semi-private']);
  assert.deepEqual(detail.body.packs.map(p => [p.size, p.price]), [[5, 810], [10, 1530]]);
});

test('lesson: slots follow coach hours, then book by card; the coach cannot be double booked', async () => {
  const p = await player();
  const slots = await call('GET', `/api/coaches/${coachId}/slots?date=2026-10-25&lessonType=${lessonTypes[0]}`);
  assert.deepEqual(slots.body.slots, ['16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00']);
  // Friday: not working
  assert.deepEqual((await call('GET', `/api/coaches/${coachId}/slots?date=2026-10-23`)).body.slots, []);

  // Guests must log in to book a lesson
  assert.equal((await call('POST', '/api/lessons/holds', { coachId, lessonType: lessonTypes[0], date: '2026-10-25', start: '19:00' })).status, 401);
  const hold = await call('POST', '/api/lessons/holds', { coachId, lessonType: lessonTypes[0], date: '2026-10-25', start: '19:00' }, { token: p.token });
  assert.equal(hold.status, 201);
  const view = await call('GET', `/api/holds/${hold.body.code}`, undefined, { token: p.token });
  assert.equal(view.body.kind, 'LESSON');
  assert.equal(view.body.title, 'Private lesson');
  assert.equal(view.body.coach, 'Dana Peretz');
  assert.deepEqual(view.body.quote.lines.map(l => [l.label, l.amount]), [['Private lesson, 60 min', 180]]);
  assert.deepEqual(view.body.quote.methods.map(m => m.id), ['CARD']);
  const done = await book(p.token, hold.body);
  assert.equal(done.body.booking.status, 'confirmed');
  assert.ok(done.body.booking.table, 'a table is reserved for the lesson');

  const after = await call('GET', `/api/coaches/${coachId}/slots?date=2026-10-25&lessonType=${lessonTypes[0]}`);
  assert.deepEqual(after.body.slots, ['16:00', '16:30', '17:00', '17:30', '18:00']);
  const other = await player();
  const clash = await call('POST', '/api/lessons/holds', { coachId, lessonType: lessonTypes[0], date: '2026-10-25', start: '18:30' }, { token: other.token });
  assert.equal(clash.status, 409);

  // Time off removes the day
  created.db.prepare("INSERT INTO coach_time_off (coachId, startDate, endDate) VALUES (?, '2026-10-26', '2026-10-27')").run(coachId);
  assert.deepEqual((await call('GET', `/api/coaches/${coachId}/slots?date=2026-10-26`)).body.slots, []);
});

test('lesson packs: buy (member price), used automatically, refunded on an early cancel', async () => {
  const p = await player('club');
  const offers = await call('GET', '/api/lesson-packs', undefined, { token: p.token });
  assert.deepEqual(offers.body.offers.map(o => [o.size, o.price]), [[5, 720], [10, 1350]]);
  const bought = await call('POST', '/api/lesson-packs', { size: 10 }, { token: p.token });
  assert.deepEqual(bought.body.current, { left: 10, total: 10, expiresAt: bought.body.current.expiresAt });

  const hold = await call('POST', '/api/lessons/holds', { coachId, lessonType: lessonTypes[0], date: '2026-10-25', start: '17:00' }, { token: p.token });
  const view = await call('GET', `/api/holds/${hold.body.code}`, undefined, { token: p.token });
  assert.equal(view.body.quote.method, 'PACK');
  assert.equal(view.body.quote.total, 0);
  await book(p.token, hold.body, { paymentMethod: 'PACK' });
  assert.equal((await call('GET', '/api/lesson-packs', undefined, { token: p.token })).body.current.left, 9);
  const mine = await call('GET', '/api/my/bookings', undefined, { token: p.token });
  assert.deepEqual(mine.body.credits.pack, { left: 9, total: 10 });

  await call('POST', `/api/reservations/${hold.body.code}/cancel`, {}, { token: p.token });
  assert.equal((await call('GET', '/api/lesson-packs', undefined, { token: p.token })).body.current.left, 10);
});

test('Pro: one lesson a month is included', async () => {
  const p = await player('pro');
  const h1 = await call('POST', '/api/lessons/holds', { coachId, lessonType: lessonTypes[0], date: '2026-10-25', start: '16:00' }, { token: p.token });
  const v1 = await call('GET', `/api/holds/${h1.body.code}`, undefined, { token: p.token });
  assert.equal(v1.body.quote.method, 'MEMBERSHIP');
  await book(p.token, h1.body, { paymentMethod: 'MEMBERSHIP' });
  const h2 = await call('POST', '/api/lessons/holds', { coachId, lessonType: lessonTypes[0], date: '2026-10-26', start: '16:00' }, { token: p.token });
  const v2 = await call('GET', `/api/holds/${h2.body.code}`, undefined, { token: p.token });
  assert.deepEqual(v2.body.quote.methods.map(m => m.id), ['CARD']);
});

test('classes: capacity, waitlist, a freed seat is offered to #1 for 2 hours, then #2', async () => {
  const classId = addClass({ capacity: 2 });
  const [a, b, c, d] = [await player(), await player(), await player(), await player()];
  for (const p of [a, b]) {
    const h = await call('POST', `/api/classes/${classId}/join`, {}, { token: p.token });
    assert.equal(h.status, 201);
    assert.equal((await book(p.token, h.body)).body.booking.kind, 'CLASS');
  }
  const full = await call('POST', `/api/classes/${classId}/join`, {}, { token: c.token });
  assert.equal(full.body.error.code, 'class_full');
  const listed = (await call('GET', '/api/classes', undefined, { token: c.token })).body.find(x => x.id === classId);
  assert.deepEqual([listed.taken, listed.spotsLeft, listed.full], [2, 0, true]);

  assert.equal((await call('POST', `/api/classes/${classId}/waitlist`, {}, { token: c.token })).body.waitlist.position, 1);
  assert.equal((await call('POST', `/api/classes/${classId}/waitlist`, {}, { token: d.token })).body.waitlist.position, 2);

  // A cancels → C gets the offer; D can't take the seat meanwhile
  const aCode = (await call('GET', '/api/my/bookings', undefined, { token: a.token })).body.upcoming[0].code;
  await call('POST', `/api/reservations/${aCode}/cancel`, {}, { token: a.token });
  const cView = (await call('GET', '/api/classes', undefined, { token: c.token })).body.find(x => x.id === classId);
  assert.equal(cView.waitlist.offered, true);
  assert.equal(cView.full, false);
  assert.equal((await call('POST', `/api/classes/${classId}/join`, {}, { token: d.token })).body.error.code, 'class_full');
  const note = created.db.prepare("SELECT title FROM notifications WHERE userId = ? AND type = 'waitlist_offer'").get(c.id);
  assert.equal(note.title, 'A spot opened up');

  // C lets it lapse → after 2 h D gets it
  clock = new Date(clock.getTime() + 2 * 3600000 + 60000);
  await created.runJobs();
  const dView = (await call('GET', '/api/classes', undefined, { token: d.token })).body.find(x => x.id === classId);
  assert.deepEqual([dView.waitlist.position, dView.waitlist.offered], [1, true]);
  assert.equal((await call('GET', '/api/classes', undefined, { token: c.token })).body.find(x => x.id === classId).waitlist, null);

  const h = await call('POST', `/api/classes/${classId}/join`, {}, { token: d.token });
  await book(d.token, h.body);
  const final = (await call('GET', '/api/classes', undefined, { token: d.token })).body.find(x => x.id === classId);
  assert.deepEqual([final.taken, final.joined !== null, final.waitlist], [2, true, null]);
});

test('open play is included for Club members; class tables are busy for table booking', async () => {
  const openId = addClass({ title: 'Open play', kind: 'OPEN_PLAY', level: 'all', capacity: 12, price: 30, start: 19 * 60 });
  const club = await player('club');
  const h = await call('POST', `/api/classes/${openId}/join`, {}, { token: club.token });
  const v = await call('GET', `/api/holds/${h.body.code}`, undefined, { token: club.token });
  assert.equal(v.body.quote.method, 'MEMBERSHIP');
  assert.equal(v.body.quote.total, 0);
  assert.equal(v.body.maxPlayers, 1);
  const dropin = await player();
  const h2 = await call('POST', `/api/classes/${openId}/join`, {}, { token: dropin.token });
  assert.equal((await call('GET', `/api/holds/${h2.body.code}`, undefined, { token: dropin.token })).body.quote.total, 30);
  const tables = await call('GET', '/api/tables/availability?date=2026-10-25&duration=60&area=1');
  assert.equal(tables.body.slots.find(s => s.time === '19:00').free, 2, 'table 1 is used by open play');
});
