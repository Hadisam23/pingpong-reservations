const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { zonedToUtc } = require('../src/time');

// Thu 22 Oct 2026, 15:00 in Jerusalem. Sun–Thu peak from 17:00; Fri–Sat peak all day.
const START = '2026-10-22T12:00:00Z';
let server, base, created, clock;

async function start(opts = {}) {
  clock = new Date(START);
  created = createApp({ adminPassword: 'secret', now: () => clock, ...opts });
  await new Promise(resolve => { server = created.app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}
beforeEach(() => start());
afterEach(() => new Promise(resolve => server.close(resolve)));

async function call(method, path, body, { token, raw, headers: extra } = {}) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

const later = minutes => { clock = new Date(clock.getTime() + minutes * 60000); };

let emailCount = 0;
async function member({ plan = 'club', credits = 0 } = {}) {
  const res = await call('POST', '/api/auth/signup', {
    name: 'Noa Cohen', email: `noa${++emailCount}@example.com`, phone: '052-123-4567', password: 'table-tennis', skillLevel: 'intermediate', acceptTerms: true,
  });
  const id = res.body.user.id;
  created.db.prepare("UPDATE memberships SET planId = ?, status = 'ACTIVE' WHERE userId = ?").run(plan, id);
  if (credits) created.db.prepare("INSERT INTO credit_ledger (userId, type, delta, reason, createdAt) VALUES (?, 'TABLE_CREDIT', ?, 'test', ?)").run(id, credits, START);
  return { token: res.body.token, id };
}

const guest = { name: 'Guest Player', email: 'guest@example.com', phone: '054-777-8888' };
const mainHall = () => created.db.prepare("SELECT id FROM areas WHERE name = 'Main hall'").get().id;
const privateRoom = () => created.db.prepare("SELECT id FROM areas WHERE name = 'Private room'").get().id;

test('availability: slots per area with free tables, peak flag and member price', async () => {
  const { token } = await member();
  const res = await call('GET', `/api/tables/availability?date=2026-10-22&duration=60&area=${mainHall()}`, undefined, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.area.name, 'Main hall');
  assert.deepEqual(res.body.durations, [30, 60, 90]);
  // Today: only times after now (15:00)
  assert.equal(res.body.slots[0].time, '15:00');
  const six = res.body.slots.find(s => s.time === '18:00');
  assert.deepEqual({ free: six.free, peak: six.peak, base: six.base, price: six.price }, { free: 3, peak: true, base: 60, price: 48 });
  const four = res.body.slots.find(s => s.time === '16:00');
  assert.deepEqual({ peak: four.peak, base: four.base, price: four.price }, { peak: false, base: 40, price: 32 });
  // Club window is 14 days; the strip shows them all
  assert.equal(res.body.window.days, 14);
  assert.equal(res.body.days.length, 15);
  assert.equal(res.body.days[15 - 1].bookable, true);
});

test('guest books a table: hold → checkout with card → confirmed with QR and calendar file', async () => {
  const hold = await call('POST', '/api/holds', { date: '2026-10-25', start: '18:00', duration: 60, area: mainHall() });
  assert.equal(hold.status, 201);
  assert.match(hold.body.code, /^[A-Z2-9]{6}$/);
  assert.equal(new Date(hold.body.expiresAt) - clock, 10 * 60000);

  const view = await call('GET', `/api/holds/${hold.body.code}?token=${hold.body.token}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.guest, true);
  assert.deepEqual(view.body.quote.methods.map(m => m.id), ['CARD']);
  assert.equal(view.body.quote.total, 60);
  assert.equal(view.body.cancellation.freeUntilDate, '2026-10-24');

  // Someone else can't see it without the token
  assert.equal((await call('GET', `/api/holds/${hold.body.code}`)).status, 404);

  const bad = await call('POST', `/api/holds/${hold.body.code}/checkout`, { token: hold.body.token, ...guest, email: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.field, 'email');

  const done = await call('POST', `/api/holds/${hold.body.code}/checkout`, { token: hold.body.token, ...guest, paymentMethod: 'CARD' });
  assert.equal(done.status, 200);
  assert.equal(done.body.booking.status, 'confirmed');
  assert.equal(done.body.booking.price, 60);
  assert.equal(done.body.booking.where, 'Main hall');
  assert.match(done.body.booking.checkIn, /^RC1\./);
  const payment = created.db.prepare('SELECT * FROM payments').get();
  assert.deepEqual({ amount: payment.amount, status: payment.status, provider: payment.provider }, { amount: 60, status: 'SUCCEEDED', provider: 'demo' });
  assert.equal(created.mailer.outbox.at(-1).to, 'guest@example.com');

  const full = await call('GET', `/api/reservations/${hold.body.code}?token=${hold.body.token}`);
  assert.match(full.body.qrSvg, /^<svg/);
  const ics = await call('GET', `/api/reservations/${hold.body.code}/calendar.ics?token=${hold.body.token}`);
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  assert.match(ics.body, /DTSTART:20261025T160000Z/);
});

test('no double booking: holds take the lowest free table and the area fills up', async () => {
  const area = mainHall();
  const tables = [];
  for (let i = 0; i < 3; i++) {
    const h = await call('POST', '/api/holds', { date: '2026-10-25', start: '19:00', duration: 90, area });
    assert.equal(h.status, 201);
    tables.push(created.reservations.byCode(h.body.code).tableName);
  }
  assert.deepEqual(tables, ['Table 1', 'Table 2', 'Table 3']);
  const fourth = await call('POST', '/api/holds', { date: '2026-10-25', start: '19:30', duration: 30, area });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, 'slot_taken');
  const slots = (await call('GET', `/api/tables/availability?date=2026-10-25&duration=60&area=${area}`)).body.slots;
  assert.equal(slots.find(s => s.time === '19:00').full, true);
  assert.equal(slots.find(s => s.time === '18:00').full, false, '18:00–19:00 ends as the holds start');
  assert.equal(slots.find(s => s.time === '18:30').full, true);
  // The private room is separate
  assert.equal((await call('POST', '/api/holds', { date: '2026-10-25', start: '19:00', duration: 60, area: privateRoom() })).status, 201);
  // The front desk can't book over a hold either
  const desk = await call('POST', '/api/admin/bookings', { tableId: 1, date: '2026-10-25', start: '19:00', duration: 60, name: 'Desk' }, { token: 'secret' });
  assert.equal(desk.status, 409);
});

test('holds expire after 10 minutes; a lapsed hold still checks out if nobody took the table', async () => {
  const area = privateRoom();
  const a = await call('POST', '/api/holds', { date: '2026-10-25', start: '12:00', duration: 60, area });
  later(11);
  const view = await call('GET', `/api/holds/${a.body.code}?token=${a.body.token}`);
  assert.equal(view.body.status, 'expired');
  // Still free → checkout works
  const ok = await call('POST', `/api/holds/${a.body.code}/checkout`, { token: a.body.token, ...guest });
  assert.equal(ok.body.booking.status, 'confirmed');

  const b = await call('POST', '/api/holds', { date: '2026-10-25', start: '14:00', duration: 60, area });
  later(11);
  const c = await call('POST', '/api/holds', { date: '2026-10-25', start: '14:00', duration: 60, area });
  assert.equal(c.status, 201, 'the expired hold no longer blocks the table');
  const lost = await call('POST', `/api/holds/${b.body.code}/checkout`, { token: b.body.token, ...guest, phone: '054-111-2222' });
  assert.equal(lost.status, 409);
  assert.equal(lost.body.error.code, 'hold_expired');
});

test('booking window follows the plan: Drop-in 3 days, Club 14', async () => {
  const dropin = await call('POST', '/api/holds', { date: '2026-10-26', start: '18:00', duration: 60, area: mainHall() });
  assert.equal(dropin.status, 400);
  assert.equal(dropin.body.error.code, 'outside_window');
  const avail = await call('GET', '/api/tables/availability?date=2026-10-26&duration=60');
  assert.equal(avail.body.outsideWindow, true);
  assert.equal(avail.body.days.filter(d => d.bookable).length, 4);
  const { token } = await member({ plan: 'club' });
  assert.equal((await call('POST', '/api/holds', { date: '2026-11-05', start: '18:00', duration: 60 }, { token })).status, 201);
});

test('classes and blocks make tables busy', async () => {
  const ids = created.db.prepare("SELECT id FROM tables WHERE areaId = ? ORDER BY number").all(mainHall()).map(t => t.id);
  created.db.prepare(`INSERT INTO class_sessions (title, kind, level, tableIds, startsAt, endsAt, capacity, price, createdAt)
    VALUES ('Drills', 'CLASS', 'all', ?, ?, ?, 8, 40, ?)`).run(JSON.stringify(ids), zonedToUtc('2026-10-25', 18 * 60, 'Asia/Jerusalem'), zonedToUtc('2026-10-25', 19 * 60, 'Asia/Jerusalem'), START);
  const slots = (await call('GET', `/api/tables/availability?date=2026-10-25&duration=60&area=${mainHall()}`)).body.slots;
  assert.equal(slots.find(s => s.time === '18:00').full, true);
  assert.equal(slots.find(s => s.time === '17:30').full, true);
  assert.equal(slots.find(s => s.time === '19:00').full, false);
  assert.equal((await call('POST', '/api/holds', { date: '2026-10-25', start: '18:30', duration: 30, area: mainHall() })).status, 409);
  // Legacy grid sees it too
  const legacy = await call('GET', '/api/availability?date=2026-10-25');
  assert.deepEqual(legacy.body.tables.find(t => t.id === ids[0]).busy, [{ start: 1080, end: 1140 }]);
});

test('member discount, promo code, and Pro off-peak included', async () => {
  const club = await member({ plan: 'club' });
  created.db.prepare("INSERT INTO promo_codes (code, percentOff, validFrom, validTo, maxUses) VALUES ('WELCOME10', 10, ?, ?, 1)")
    .run('2026-10-01T00:00:00Z', '2026-12-31T00:00:00Z');
  const h = await call('POST', '/api/holds', { date: '2026-10-22', start: '18:00', duration: 60 }, { token: club.token });
  const q = await call('POST', `/api/holds/${h.body.code}/quote`, { promo: 'welcome10' }, { token: club.token });
  assert.deepEqual(q.body.lines.map(l => [l.label, l.amount]), [['Table, 60 min', 60], ['Club member discount', -12], ['Promo WELCOME10', -4.8]]);
  assert.equal(q.body.total, 43.2);
  const badPromo = await call('POST', `/api/holds/${h.body.code}/quote`, { promo: 'NOPE' }, { token: club.token });
  assert.equal(badPromo.body.error.field, 'promo');
  const done = await call('POST', `/api/holds/${h.body.code}/checkout`, { promo: 'WELCOME10', paymentMethod: 'CARD' }, { token: club.token });
  assert.equal(done.body.booking.price, 43.2);
  // maxUses = 1: used up now
  const h2 = await call('POST', '/api/holds', { date: '2026-10-25', start: '19:00', duration: 60 }, { token: club.token });
  assert.match((await call('POST', `/api/holds/${h2.body.code}/quote`, { promo: 'WELCOME10' }, { token: club.token })).body.error.message, /used up/);

  const pro = await member({ plan: 'pro' });
  const off = await call('POST', '/api/holds', { date: '2026-10-25', start: '11:00', duration: 60 }, { token: pro.token });
  const offView = await call('GET', `/api/holds/${off.body.code}`, undefined, { token: pro.token });
  assert.equal(offView.body.quote.method, 'MEMBERSHIP');
  assert.equal(offView.body.quote.total, 0);
  const proDone = await call('POST', `/api/holds/${off.body.code}/checkout`, { paymentMethod: 'MEMBERSHIP' }, { token: pro.token });
  assert.equal(proDone.body.booking.paymentMethod, 'MEMBERSHIP');
  assert.equal(created.db.prepare('SELECT COUNT(*) AS c FROM payments WHERE userId = ?').get(pro.id).c, 0);
});

test('table credits: spend one, refund it on an early cancel, not for 90 minutes', async () => {
  const m = await member({ plan: 'club', credits: 2 });
  const h = await call('POST', '/api/holds', { date: '2026-10-25', start: '18:00', duration: 60 }, { token: m.token });
  const view = await call('GET', `/api/holds/${h.body.code}`, undefined, { token: m.token });
  const credit = view.body.quote.methods.find(x => x.id === 'CREDIT');
  assert.equal(credit.sub, '2 credits left this month');
  const done = await call('POST', `/api/holds/${h.body.code}/checkout`, { paymentMethod: 'CREDIT' }, { token: m.token });
  assert.equal(done.body.booking.paymentMethod, 'CREDIT');
  assert.equal((await call('GET', '/api/me', undefined, { token: m.token })).body.stats.tableCredits, 1);

  const cancel = await call('POST', `/api/reservations/${h.body.code}/cancel`, {}, { token: m.token });
  assert.equal(cancel.body.status, 'cancelled');
  assert.equal(cancel.body.refunded, true);
  assert.equal((await call('GET', '/api/me', undefined, { token: m.token })).body.stats.tableCredits, 2);

  const long = await call('POST', '/api/holds', { date: '2026-10-25', start: '18:00', duration: 90 }, { token: m.token });
  const longView = await call('GET', `/api/holds/${long.body.code}`, undefined, { token: m.token });
  assert.equal(longView.body.quote.methods.find(x => x.id === 'CREDIT').disabled, true);
  const refused = await call('POST', `/api/holds/${long.body.code}/checkout`, { paymentMethod: 'CREDIT' }, { token: m.token });
  assert.equal(refused.status, 400);
});

test('cancellation: refund until 24 h before, no refund after; my bookings lists both', async () => {
  const m = await member({ plan: 'club' });
  const early = await call('POST', '/api/holds', { date: '2026-10-25', start: '18:00', duration: 60 }, { token: m.token });
  await call('POST', `/api/holds/${early.body.code}/checkout`, {}, { token: m.token });
  const late = await call('POST', '/api/holds', { date: '2026-10-23', start: '10:00', duration: 60 }, { token: m.token });
  assert.equal(late.status, 201);
  await call('POST', `/api/holds/${late.body.code}/checkout`, {}, { token: m.token });

  const mine = await call('GET', '/api/my/bookings', undefined, { token: m.token });
  assert.deepEqual(mine.body.upcoming.map(b => b.code), [late.body.code, early.body.code]);
  assert.equal(mine.body.upcoming[0].refundable, false);  // 22 h away
  assert.equal(mine.body.upcoming[1].refundable, true);

  await call('POST', `/api/reservations/${early.body.code}/cancel`, {}, { token: m.token });
  await call('POST', `/api/reservations/${late.body.code}/cancel`, {}, { token: m.token });
  const pays = created.db.prepare('SELECT b.code, p.status FROM payments p JOIN bookings b ON b.id = p.bookingId').all();
  assert.deepEqual(Object.fromEntries(pays.map(p => [p.code, p.status])), { [early.body.code]: 'REFUNDED', [late.body.code]: 'SUCCEEDED' });
  const after = await call('GET', '/api/my/bookings', undefined, { token: m.token });
  assert.equal(after.body.upcoming.length, 0);
  assert.equal(after.body.past.length, 2);
  // A second cancel is refused
  assert.equal((await call('POST', `/api/reservations/${early.body.code}/cancel`, {}, { token: m.token })).status, 409);
});

test('reschedule moves the booking atomically and keeps its code', async () => {
  const m = await member({ plan: 'club' });
  const h = await call('POST', '/api/holds', { date: '2026-10-25', start: '18:00', duration: 60, area: privateRoom() }, { token: m.token });
  await call('POST', `/api/holds/${h.body.code}/checkout`, {}, { token: m.token });
  const before = created.reservations.byCode(h.body.code).checkInCode;

  // The new time is taken → nothing changes
  const other = await call('POST', '/api/holds', { date: '2026-10-26', start: '20:00', duration: 60, area: privateRoom() });
  assert.equal(other.status, 400, 'guests cannot book that far');
  const blocker = await member({ plan: 'club' });
  const bh = await call('POST', '/api/holds', { date: '2026-10-26', start: '20:00', duration: 60, area: privateRoom() }, { token: blocker.token });
  await call('POST', `/api/holds/${bh.body.code}/checkout`, {}, { token: blocker.token });
  const taken = await call('POST', `/api/reservations/${h.body.code}/reschedule`, { date: '2026-10-26', start: '20:00' }, { token: m.token });
  assert.equal(taken.status, 409);
  assert.equal(created.reservations.byCode(h.body.code).date, '2026-10-25');

  const moved = await call('POST', `/api/reservations/${h.body.code}/reschedule`, { date: '2026-10-26', start: '21:00' }, { token: m.token });
  assert.equal(moved.status, 200);
  assert.deepEqual([moved.body.code, moved.body.date, moved.body.start, moved.body.end], [h.body.code, '2026-10-26', '21:00', '22:00']);
  assert.notEqual(created.reservations.byCode(h.body.code).checkInCode, before);

  clock = new Date('2026-10-26T00:00:00Z'); // 02:00 local: 19 h before, inside 24 h
  const tooLate = await call('POST', `/api/reservations/${h.body.code}/reschedule`, { date: '2026-10-27', start: '18:00' }, { token: m.token });
  assert.equal(tooLate.body.error.code, 'too_late_to_reschedule');
});

test('split the cost: shares, pay link, organizer covers the rest 2 h before', async () => {
  const m = await member({ plan: 'dropin' });
  const h = await call('POST', '/api/holds', { date: '2026-10-25', start: '20:00', duration: 60, players: 3 }, { token: m.token });
  const q = await call('POST', `/api/holds/${h.body.code}/quote`, { players: 3, split: true }, { token: m.token });
  assert.deepEqual([q.body.total, q.body.yourShare, q.body.otherShare], [60, 20, 20]);
  const done = await call('POST', `/api/holds/${h.body.code}/checkout`, { players: 3, split: true, invites: [{ name: 'Amit' }, { name: 'Gal' }] }, { token: m.token });
  const shares = done.body.booking.shares;
  assert.deepEqual(shares.map(s => [s.name, s.amount, s.paid]), [['Amit', 20, false], ['Gal', 20, false]]);

  const link = await call('GET', `/api/shares/${shares[0].payToken}`);
  assert.deepEqual([link.body.organizer, link.body.amount, link.body.paid], ['Noa', 20, false]);
  assert.deepEqual((await call('POST', `/api/shares/${shares[0].payToken}/pay`, {})).body, { paid: true });

  await created.runJobs();
  assert.equal(created.db.prepare("SELECT COUNT(*) AS c FROM payments WHERE kind = 'REMAINDER'").get().c, 0, 'too early');
  clock = new Date('2026-10-25T16:30:00Z'); // 18:30 local (UTC+2 after DST), 90 min before
  await created.runJobs();
  const rest = created.db.prepare("SELECT amount, userId FROM payments WHERE kind = 'REMAINDER'").all();
  assert.deepEqual(rest.map(r => ({ ...r })), [{ amount: 20, userId: m.id }]);
  const notes = created.db.prepare("SELECT title FROM notifications WHERE userId = ? AND type = 'split_remainder'").all(m.id);
  assert.equal(notes.length, 1);
});

test('jobs mark no-shows 15 minutes after the start', async () => {
  const h = await call('POST', '/api/holds', { date: '2026-10-22', start: '16:00', duration: 60, area: privateRoom() });
  await call('POST', `/api/holds/${h.body.code}/checkout`, { token: h.body.token, ...guest });
  clock = new Date('2026-10-22T13:10:00Z'); // 16:10
  await created.runJobs();
  assert.equal(created.reservations.byCode(h.body.code).status, 'confirmed');
  clock = new Date('2026-10-22T13:16:00Z'); // 16:16
  await created.runJobs();
  assert.equal(created.reservations.byCode(h.body.code).status, 'no_show');
});

test('check-in codes are signed: a changed character fails', () => {
  const token = created.checkIn.sign({ bookingId: 7, userId: 3, expiresAt: new Date('2026-10-25T16:00:00Z') });
  assert.deepEqual(created.checkIn.verify(token), { bookingId: 7, userId: 3, expiresAt: new Date('2026-10-25T16:00:00Z') });
  const forged = token.replace('.7.', '.8.');
  assert.equal(created.checkIn.verify(forged), null);
  assert.equal(created.checkIn.verify('garbage'), null);
});

test('Stripe: checkout redirects to Stripe, the signed webhook confirms the booking', async () => {
  await new Promise(resolve => server.close(resolve));
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    const json = url.endsWith('/customers') ? { id: 'cus_1' } : { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' };
    return { ok: true, json: async () => json };
  };
  await start({ stripeKey: 'sk_test_x', stripeWebhookSecret: 'whsec_x', fetchImpl: fakeFetch });
  const m = await member({ plan: 'dropin' });
  const h = await call('POST', '/api/holds', { date: '2026-10-25', start: '18:00', duration: 60 }, { token: m.token });
  const res = await call('POST', `/api/holds/${h.body.code}/checkout`, { paymentMethod: 'CARD' }, { token: m.token });
  assert.equal(res.body.redirect, 'https://checkout.stripe.com/c/cs_test_1');
  const session = calls.find(c => c.url.endsWith('/checkout/sessions'));
  assert.match(decodeURIComponent(session.body), /line_items\[0\]\[price_data\]\[unit_amount\]=6000/);
  assert.match(decodeURIComponent(session.body), /payment_intent_data\[setup_future_usage\]=off_session/);
  assert.equal(created.reservations.byCode(h.body.code).status, 'held');

  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', mode: 'payment', payment_intent: 'pi_1' } } });
  const t = Math.floor(clock.getTime() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_x').update(`${t}.${payload}`).digest('hex');
  const forged = await call('POST', '/api/stripe/webhook', undefined, { raw: payload, headers: { 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` } });
  assert.equal(forged.status, 400);
  const ok = await call('POST', '/api/stripe/webhook', undefined, { raw: payload, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
  assert.equal(ok.status, 200);
  assert.equal(created.reservations.byCode(h.body.code).status, 'confirmed');
  assert.equal(created.db.prepare('SELECT paymentIntent FROM payments').get().paymentIntent, 'pi_1');
});

test('find a booking with its code and the phone or email used (guests on another device)', async () => {
  const h = await call('POST', '/api/holds', { date: '2026-10-25', start: '18:00', duration: 60 });
  await call('POST', `/api/holds/${h.body.code}/checkout`, { token: h.body.token, ...guest });
  const byPhone = await call('POST', '/api/reservations/find', { code: `rc-${h.body.code.toLowerCase()}`, contact: '054 777 8888' });
  assert.deepEqual(byPhone.body, { code: h.body.code, token: h.body.token, upcoming: true });
  assert.equal((await call('POST', '/api/reservations/find', { code: h.body.code, contact: 'GUEST@example.com' })).status, 200);
  const wrong = await call('POST', '/api/reservations/find', { code: h.body.code, contact: '0500000000' });
  assert.equal(wrong.status, 404);
  assert.equal((await call('POST', '/api/reservations/find', { code: 'ZZZZZZ', contact: '0547778888' })).body.error.message, wrong.body.error.message);
});
