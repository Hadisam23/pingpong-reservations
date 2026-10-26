const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

// Thu 22 Oct 2026, 15:00 in Jerusalem
let server, base, created, clock, adminToken, player;

beforeEach(async () => {
  clock = new Date('2026-10-22T12:00:00Z');
  created = createApp({ now: () => clock });
  await new Promise(resolve => { server = created.app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const a = await call('POST', '/api/auth/signup', { name: 'Desk Admin', email: 'admin@example.com', phone: '0521110000', password: 'admin-pass-1', skillLevel: 'advanced', acceptTerms: true });
  created.db.prepare("UPDATE users SET role = 'ADMIN' WHERE id = ?").run(a.body.user.id);
  adminToken = a.body.token;
  const p = await call('POST', '/api/auth/signup', { name: 'Noa Cohen', email: 'noa@example.com', phone: '0521234567', password: 'table-tennis', skillLevel: 'beginner', acceptTerms: true });
  player = { token: p.body.token, id: p.body.user.id };
});
afterEach(() => new Promise(resolve => server.close(resolve)));

async function call(method, path, body, { token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const A = (method, path, body) => call(method, `/api/admin${path}`, body, { token: adminToken });

async function playerBooking(date, start, extra = {}) {
  const h = await call('POST', '/api/holds', { date, start, duration: 60, ...extra }, { token: player.token });
  const done = await call('POST', `/api/holds/${h.body.code}/checkout`, {}, { token: player.token });
  return done.body.booking;
}

test('staff access: admin accounts in, players forbidden, guests unauthorized', async () => {
  assert.equal((await call('GET', '/api/admin/me')).status, 401);
  assert.equal((await call('GET', '/api/admin/me', undefined, { token: player.token })).status, 403);
  assert.deepEqual((await A('GET', '/me')).body, { name: 'Desk Admin', email: 'admin@example.com', via: 'account' });
});

test('calendar shows bookings, classes and blocks per table', async () => {
  const b = await playerBooking('2026-10-25', '18:00');
  await A('POST', '/classes', { title: 'Drills', kind: 'CLASS', level: 'beginner', coachId: (await A('POST', '/coaches', coach()).then(r => r.body.id)), date: '2026-10-25', start: '20:00', duration: 60, capacity: 6, price: 40, tableIds: [2, 3] });
  await call('POST', '/api/admin/blocks', { tableId: 4, date: '2026-10-25', start: '10:00', end: '12:00', reason: 'New net' }, { token: adminToken });
  const day = (await A('GET', '/calendar?date=2026-10-25')).body;
  assert.equal(day.tables.length, 4);
  const kinds = day.items.map(i => [i.type, i.tableIds.join(','), i.start]);
  assert.deepEqual(kinds.sort(), [['block', '4', 600], ['booking', '1', 1080], ['class', '2,3', 1200]]);
  assert.equal(day.items.find(i => i.type === 'booking').booking.phone, '0521234567');
  assert.equal(day.items.find(i => i.type === 'booking').code, b.code);
});

test('check-in by QR: too early, then on time; a forged code fails; manual by code', async () => {
  const b = await playerBooking('2026-10-22', '18:00');
  const token = created.reservations.byCode(b.code).checkInCode;
  assert.equal((await A('POST', '/checkin', { token })).body.error.code, 'too_early');
  clock = new Date('2026-10-22T14:50:00Z'); // 17:50 local
  const ok = await A('POST', '/checkin', { token });
  assert.deepEqual([ok.body.already, ok.body.booking.status, ok.body.booking.name], [false, 'checked_in', 'Noa Cohen']);
  assert.equal((await A('POST', '/checkin', { token })).body.already, true);
  assert.equal((await A('POST', '/checkin', { token: token.slice(0, -2) + 'xx' })).body.error.code, 'invalid_code');

  const b2 = await playerBooking('2026-10-25', '18:00');
  const manual = await A('POST', '/checkin', { code: `#RC-${b2.code}` });
  assert.equal(manual.body.booking.status, 'checked_in');
});

test('bookings: search and cancel with a refund inside 24 h (staff override)', async () => {
  const b = await playerBooking('2026-10-23', '10:00');
  const found = await A('GET', '/bookings?q=noa');
  assert.deepEqual(found.body.map(x => x.code), [b.code]);
  assert.deepEqual((await A('GET', `/bookings?q=${b.code}`)).body.length, 1);
  const cancelled = await A('POST', `/bookings/${b.code}/cancel`, { refund: true });
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(created.db.prepare('SELECT status FROM payments').get().status, 'REFUNDED');
  assert.equal((await A('POST', `/bookings/${b.code}/status`, { status: 'no_show' })).status, 409);
});

const coach = (over = {}) => ({
  name: 'Lior Golan', email: 'lior@example.com', certification: 'ITTF Level 1', yearsCoaching: 4, specialties: 'Backhand, Footwork',
  levels: ['beginner', 'intermediate'], hours: [{ dayOfWeek: 0, startTime: '16:00', endTime: '19:00' }], ...over,
});

test('coaches: create with hours, appear in the app with slots; time off removes them', async () => {
  const c = (await A('POST', '/coaches', coach())).body;
  assert.deepEqual(c.specialties, ['Backhand', 'Footwork']);
  assert.equal(created.db.prepare('SELECT role FROM users WHERE id = ?').get(c.userId).role, 'COACH');
  created.db.prepare("INSERT INTO lesson_types (name, durationMin, maxStudents, price) VALUES ('Private lesson', 60, 1, 180)").run();
  const slots = await call('GET', `/api/coaches/${c.id}/slots?date=2026-10-25`);
  assert.deepEqual(slots.body.slots, ['16:00', '16:30', '17:00', '17:30', '18:00']);
  await A('POST', `/coaches/${c.id}/time-off`, { startDate: '2026-10-25', endDate: '2026-10-25', reason: 'Tournament' });
  assert.deepEqual((await call('GET', `/api/coaches/${c.id}/slots?date=2026-10-25`)).body.slots, []);
  const updated = await A('PUT', `/coaches/${c.id}`, coach({ active: false }));
  assert.equal(updated.body.active, false);
  assert.equal((await call('GET', '/api/coaches')).body.length, 0);
  assert.equal((await A('POST', '/coaches', coach({ email: 'bad' }))).body.error.field, 'email');
});

test('classes: weekly series, table conflicts refused, cancelling refunds seats', async () => {
  const c = (await A('POST', '/coaches', coach())).body;
  const made = await A('POST', '/classes', { title: 'Sunday drills', kind: 'CLASS', level: 'beginner', coachId: c.id, date: '2026-10-25', start: '17:00', duration: 60, capacity: 4, price: 50, tableIds: [1], weeks: 3 });
  assert.equal(made.body.created, 3);
  const list = (await A('GET', '/classes?from=2026-10-22&days=28')).body;
  assert.deepEqual(list.map(x => x.date), ['2026-10-25', '2026-11-01', '2026-11-08']);
  const clash = await A('POST', '/classes', { title: 'Clash', kind: 'OPEN_PLAY', level: 'all', date: '2026-11-01', start: '17:30', duration: 60, capacity: 4, price: 0, tableIds: [1] });
  assert.equal(clash.body.error.code, 'table_busy');

  const h = await call('POST', `/api/classes/${list[0].id}/join`, {}, { token: player.token });
  await call('POST', `/api/holds/${h.body.code}/checkout`, {}, { token: player.token });
  const res = await A('DELETE', `/classes/${list[0].id}`);
  assert.equal(res.body.refunded, 1);
  assert.equal(created.reservations.byCode(h.body.code).status, 'cancelled');
  assert.equal(created.db.prepare("SELECT status FROM payments WHERE bookingId = (SELECT id FROM bookings WHERE code = ?)").get(h.body.code).status, 'REFUNDED');
});

test('pricing: new rules change prices; plans, lesson packs and promos are editable', async () => {
  const p = (await A('GET', '/pricing')).body;
  assert.equal(p.rules.length, 6);
  const rules = p.rules.map(r => (r.durationMin === 60 && r.daysOfWeek.includes(4) ? { ...r, peakPrice: 70 } : r));
  await A('PUT', '/pricing/rules', { rules });
  const slots = (await call('GET', '/api/tables/availability?date=2026-10-22&duration=60')).body.slots;
  assert.equal(slots.find(s => s.time === '18:00').price, 70);

  const club = p.plans.find(x => x.id === 'club');
  await A('PUT', '/plans/club', { ...club, price: 159, perks: ['Member price'] });
  assert.equal((await call('GET', '/api/plans')).body.find(x => x.id === 'club').price, 159);
  await A('PUT', '/lesson-packs', { lessonPacks: [{ size: 8, discountPct: 12 }], memberPackDiscountPct: 5 });
  assert.deepEqual((await A('GET', '/pricing')).body.lessonPacks, [{ size: 8, discountPct: 12 }]);
  await A('POST', '/promos', { code: 'spring', percentOff: 15, validFrom: '2026-10-01', validTo: '2026-12-31', maxUses: 50 });
  assert.equal((await A('GET', '/pricing')).body.promos[0].code, 'SPRING');
  assert.equal((await A('POST', '/promos', { code: 'x', percentOff: 15, validFrom: '2026-10-01', validTo: '2026-12-31' })).body.error.field, 'code');
});

test('members: list, adjust credits (never below zero), change role', async () => {
  const list = (await A('GET', '/members?q=noa')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].planId, 'dropin');
  const m = (await A('POST', `/members/${player.id}/credits`, { delta: 2, reason: 'Sorry about the broken net' })).body;
  assert.equal(m.credits, 2);
  assert.equal(m.ledger[0].reason, 'Staff: Sorry about the broken net');
  assert.equal((await A('POST', `/members/${player.id}/credits`, { delta: -5, reason: 'oops' })).body.error.field, 'delta');
  const pack = (await A('POST', `/members/${player.id}/credits`, { type: 'LESSON_PACK', delta: 3, reason: 'Gift' })).body;
  assert.equal(pack.packLeft, 3);
  assert.equal((await A('PUT', `/members/${player.id}/role`, { role: 'COACH' })).body.role, 'COACH');
});

test('settings: hours, tables and areas, holiday closures close the day', async () => {
  const club = (await A('GET', '/club')).body;
  assert.equal(club.cancelHours, 24);
  const saved = (await A('PUT', '/club', { ...club, centerName: 'Rally Club Haifa', cancelHours: 12 })).body;
  assert.equal(saved.centerName, 'Rally Club Haifa');
  assert.equal(created.service.getSettings().cancelCutoffMinutes, 720);

  const withTable = (await A('POST', '/club/tables', { name: 'Table 5', areaId: club.areas[1].id })).body;
  assert.equal(withTable.tables.find(t => t.name === 'Table 5').area, 'Private room');

  const closed = (await A('POST', '/club/closures', { date: '2026-10-25', reason: 'Holiday' })).body;
  assert.deepEqual(closed.closures.map(c => c.date), ['2026-10-25']);
  const avail = (await call('GET', '/api/tables/availability?date=2026-10-25&duration=60')).body;
  assert.equal(avail.closed, true);
  assert.equal(avail.days.find(d => d.date === '2026-10-25').bookable, false);
  assert.equal((await call('POST', '/api/holds', { date: '2026-10-25', start: '18:00', duration: 60 })).body.error.code, 'closed');
  await A('DELETE', '/club/closures/2026-10-25');
  assert.equal((await call('GET', '/api/tables/availability?date=2026-10-25&duration=60')).body.closed, false);
});

test('reports: utilization, revenue, no-show rate, members', async () => {
  await playerBooking('2026-10-22', '18:00');
  const b2 = await playerBooking('2026-10-22', '20:00');
  await call('PUT', '/api/me/plan', { plan: 'club' }, { token: player.token });
  created.db.prepare("UPDATE bookings SET status = 'no_show' WHERE code = ?").run(b2.code);
  const r = (await A('GET', '/reports?from=2026-10-22&to=2026-10-22')).body;
  assert.equal(r.bookings.tables, 2);
  assert.equal(r.noShowRate, 100);
  assert.deepEqual(r.revenue.byKind.map(x => [x.kind, x.amount]), [['BOOKING', 120], ['MEMBERSHIP', 149]]);
  assert.equal(r.members.active, 1);
  const six = r.utilization.byHour.find(h => h.hour === 18);
  assert.equal(six.pct, 25, 'one of four tables at 18:00');
});
