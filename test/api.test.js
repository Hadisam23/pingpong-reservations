const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

// Thursday 2026-10-22, 12:10 in the center's time zone (UTC in tests).
const NOW = new Date('2026-10-22T12:10:00Z');
const TODAY = '2026-10-22';
const TOMORROW = '2026-10-23'; // Friday: a peak day, open 09:00-16:00
const NEXT_SUN = '2026-10-25'; // off-peak until 17:00
const PASSWORD = 'secret';

let server, base, service, clock;

beforeEach(async () => {
  clock = NOW;
  const created = createApp({ adminPassword: PASSWORD, now: () => clock });
  service = created.service;
  service.updateSettings({ timezone: 'UTC' });
  await new Promise(resolve => { server = created.app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise(resolve => server.close(resolve)));

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const adminHeaders = { authorization: `Bearer ${PASSWORD}` };
const book = (over = {}) => call('POST', '/api/bookings', {
  tableId: 1, date: NEXT_SUN, start: '10:00', duration: 60, name: 'Dana Cohen', phone: '052-123-4567', players: 2, ...over,
});

test('config and availability', async () => {
  const cfg = await call('GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.today, TODAY);

  const av = await call('GET', `/api/availability?date=${TODAY}`);
  assert.equal(av.status, 200);
  assert.equal(av.body.tables.length, 6);
  assert.equal(av.body.slots[0].time, '10:00');
  assert.equal(av.body.slots.at(-1).time, '22:30');
  assert.equal(av.body.slots.find(s => s.time === '12:00').past, true);
  assert.equal(av.body.slots.find(s => s.time === '12:30').past, false);
  assert.equal(av.body.slots.find(s => s.time === '17:00').peak, true);

  assert.equal((await call('GET', '/api/availability?date=2026-10-21')).status, 400);
  assert.equal((await call('GET', '/api/availability?date=2026-11-06')).status, 400);
  assert.equal((await call('GET', '/api/availability?date=nope')).status, 400);
});

test('availability never exposes customer details', async () => {
  await book();
  const av = await call('GET', `/api/availability?date=${NEXT_SUN}`);
  assert.deepEqual(av.body.tables[0].busy, [{ start: 600, end: 660 }]);
  assert.ok(!JSON.stringify(av.body).includes('Dana'));
});

test('creates a booking with correct pricing', async () => {
  const res = await book();
  assert.equal(res.status, 201);
  assert.match(res.body.booking.code, /^[A-Z2-9]{6}$/);
  assert.equal(res.body.booking.price, 40);
  assert.equal(res.body.booking.phone, '0521234567');
  assert.equal(res.body.booking.end, '11:00');
  assert.ok(res.body.manageUrl.includes(`/manage?code=${res.body.booking.code}&t=`));

  // Crossing into peak: 16:30-17:00 off-peak (20) + 17:00-17:30 peak (30)
  assert.equal((await book({ start: '16:30', tableId: 2 })).body.booking.price, 50);
  // Friday is a peak day
  assert.equal((await book({ date: TOMORROW, start: '10:00', tableId: 3 })).body.booking.price, 60);
});

test('prevents overlapping bookings on the same table', async () => {
  assert.equal((await book({ start: '10:00', duration: 90 })).status, 201);
  const clash = await book({ start: '11:00', phone: '0500000001' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'slot_taken');
  assert.equal((await book({ start: '11:30', phone: '0500000001' })).status, 201); // adjacent is fine
  assert.equal((await book({ start: '10:00', tableId: 2, phone: '0500000002' })).status, 201); // other table fine
});

test('simultaneous requests for the same slot: exactly one wins', async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => book({ phone: `05000000${String(i).padStart(2, '0')}` }))
  );
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 11);
});

test('validates booking input', async () => {
  const cases = [
    [{ date: TODAY, start: '12:00' }, 'in_past'],
    [{ date: '2026-10-20' }, 'in_past'],
    [{ date: '2026-11-06' }, 'too_far_ahead'],
    [{ start: '09:00' }, 'outside_hours'],
    [{ start: '22:30', duration: 60 }, 'outside_hours'],
    [{ start: '10:15' }, 'invalid_time'],
    [{ duration: 45 }, 'invalid_duration'],
    [{ tableId: 99 }, 'invalid_table'],
    [{ name: ' ' }, 'invalid_name'],
    [{ phone: '123' }, 'invalid_phone'],
    [{ phone: undefined }, 'invalid_phone'],
    [{ players: 9 }, 'invalid_players'],
  ];
  for (const [over, code] of cases) {
    const res = await book(over);
    assert.equal(res.status, 400, `${JSON.stringify(over)} -> ${res.status}`);
    assert.equal(res.body.error.code, code, JSON.stringify(over));
  }

  const hours = service.getSettings().hours;
  hours[0] = null;
  service.updateSettings({ hours });
  assert.equal((await book()).body.error.code, 'closed');
});

test('limits upcoming bookings per phone', async () => {
  for (const tableId of [1, 2, 3]) assert.equal((await book({ tableId })).status, 201);
  const fourth = await book({ tableId: 4 });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, 'booking_limit');
});

test('blocks make time unavailable', async () => {
  const blocked = await call('POST', '/api/admin/blocks', { tableId: null, date: NEXT_SUN, start: '18:00', end: '20:00', reason: 'Tournament' }, adminHeaders);
  assert.equal(blocked.status, 201);
  assert.equal((await book({ start: '19:00', tableId: 5 })).body.error.code, 'slot_blocked');
  const av = await call('GET', `/api/availability?date=${NEXT_SUN}`);
  assert.deepEqual(av.body.tables[3].busy, [{ start: 1080, end: 1200 }]);

  await call('DELETE', `/api/admin/blocks/${blocked.body.block.id}`, undefined, adminHeaders);
  assert.equal((await book({ start: '19:00', tableId: 5 })).status, 201);

  // A new block reports the bookings it clashes with
  const clash = await call('POST', '/api/admin/blocks', { tableId: 5, date: NEXT_SUN, start: '19:00', end: '19:30' }, adminHeaders);
  assert.equal(clash.body.conflicts.length, 1);
});

test('customers can view and cancel with token or phone', async () => {
  const { body } = await book();
  const { code } = body.booking;

  assert.equal((await call('GET', `/api/bookings/${code}?token=${body.manageToken}`)).body.canCancel, true);
  assert.equal((await call('GET', `/api/bookings/${code.toLowerCase()}?phone=0521234567`)).status, 200);
  assert.equal((await call('GET', `/api/bookings/${code}?token=wrong`)).status, 404);
  assert.equal((await call('GET', `/api/bookings/${code}?phone=0529999999`)).status, 404);
  assert.equal((await call('GET', `/api/bookings/${code}`)).status, 404);

  const cancelled = await call('POST', `/api/bookings/${code}/cancel`, { token: body.manageToken });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await call('POST', `/api/bookings/${code}/cancel`, { token: body.manageToken })).body.error.code, 'not_cancellable');

  // Slot is free again
  assert.equal((await book({ phone: '0500000009' })).status, 201);
});

test('online cancellation closes before the cutoff', async () => {
  const { body } = await book({ date: TODAY, start: '14:00' }); // 110 minutes away, cutoff is 120
  const view = await call('GET', `/api/bookings/${body.booking.code}?token=${body.manageToken}`);
  assert.equal(view.body.canCancel, false);
  const res = await call('POST', `/api/bookings/${body.booking.code}/cancel`, { token: body.manageToken });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'too_late_to_cancel');
});

test('admin auth', async () => {
  assert.equal((await call('GET', '/api/admin/day')).status, 401);
  assert.equal((await call('GET', '/api/admin/day', undefined, { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await call('GET', '/api/admin/day', undefined, adminHeaders)).status, 200);

  const noPassword = createApp({}).app.listen(0);
  await new Promise(r => noPassword.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${noPassword.address().port}/api/admin/day`, { headers: adminHeaders });
  assert.equal(res.status, 503);
  noPassword.close();
});

test('admin: walk-ins, status changes and day view', async () => {
  const walkIn = await call('POST', '/api/admin/bookings', { tableId: 1, date: TODAY, start: '12:00', duration: 60, name: 'Walk in' }, adminHeaders);
  assert.equal(walkIn.status, 201);
  assert.equal(walkIn.body.booking.source, 'desk');
  assert.equal(walkIn.body.booking.phone, null);

  const { code } = walkIn.body.booking;
  assert.equal((await call('PATCH', `/api/admin/bookings/${code}`, { status: 'checked_in' }, adminHeaders)).body.status, 'checked_in');
  assert.equal((await call('PATCH', `/api/admin/bookings/${code}`, { status: 'bogus' }, adminHeaders)).status, 400);

  const day = await call('GET', `/api/admin/day?date=${TODAY}`, undefined, adminHeaders);
  assert.equal(day.body.bookings.length, 1);
  assert.equal(day.body.bookings[0].name, 'Walk in');

  // Cancel, someone takes the slot, restoring must then fail
  await call('PATCH', `/api/admin/bookings/${code}`, { status: 'cancelled' }, adminHeaders);
  await call('POST', '/api/admin/bookings', { tableId: 1, date: TODAY, start: '12:30', duration: 30, name: 'Other' }, adminHeaders);
  assert.equal((await call('PATCH', `/api/admin/bookings/${code}`, { status: 'confirmed' }, adminHeaders)).body.error.code, 'slot_taken');
});

test('admin: tables and settings', async () => {
  const added = await call('POST', '/api/admin/tables', { name: 'Pro table' }, adminHeaders);
  assert.equal(added.status, 201);
  assert.equal((await call('GET', '/api/config')).status, 200);

  await book({ tableId: 2 });
  const deactivate = await call('PATCH', '/api/admin/tables/2', { active: false }, adminHeaders);
  assert.equal(deactivate.body.error.code, 'table_has_bookings');
  assert.equal((await call('PATCH', '/api/admin/tables/3', { active: false, name: 'Broken' }, adminHeaders)).body.active, false);
  const av = await call('GET', `/api/availability?date=${NEXT_SUN}`);
  assert.equal(av.body.tables.length, 6); // 6 + 1 added - 1 inactive

  const bad = await call('PUT', '/api/admin/settings', { durations: [45] }, adminHeaders);
  assert.equal(bad.status, 400);
  const ok = await call('PUT', '/api/admin/settings', { pricing: { peakPerHour: 80 } }, adminHeaders);
  assert.equal(ok.body.pricing.peakPerHour, 80);
  assert.equal(ok.body.pricing.offPeakPerHour, 40);
});
