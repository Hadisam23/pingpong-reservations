const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

// Thu 22 Oct 2026, 15:00 in Jerusalem
let server, base, created, clock, u;

beforeEach(async () => {
  clock = new Date('2026-10-22T12:00:00Z');
  created = createApp({ now: () => clock, baseUrl: 'https://club.example' });
  await new Promise(resolve => { server = created.app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await call('POST', '/api/auth/signup', { name: 'Noa Cohen', email: 'noa@example.com', phone: '0521234567', password: 'table-tennis', skillLevel: 'beginner', acceptTerms: true });
  u = { token: res.body.token, id: res.body.user.id };
});
afterEach(() => new Promise(resolve => server.close(resolve)));

async function call(method, path, body, { token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const outbox = () => created.mailer.outbox;
async function book(date, start, body = {}, extra = {}) {
  const h = await call('POST', '/api/holds', { date, start, duration: 60, ...extra }, { token: u.token });
  return (await call('POST', `/api/holds/${h.body.code}/checkout`, body, { token: u.token })).body.booking;
}

test('confirmation: in-app entry and a branded email with the calendar file and a pass link', async () => {
  const b = await book('2026-10-25', '18:00');
  const mail = outbox().at(-1);
  assert.equal(mail.to, 'noa@example.com');
  assert.match(mail.subject, /^You're booked: Sun 25 Oct 18:00$/);
  assert.match(mail.html, /Open check-in pass/);
  assert.match(mail.html, new RegExp(`https://club.example/confirmed.html\\?code=${b.code}&amp;view=pass`));
  assert.equal(mail.attachments[0].filename, `rally-club-${b.code}.ics`);
  assert.match(mail.attachments[0].content, /BEGIN:VEVENT/);
  const list = await call('GET', '/api/notifications', undefined, { token: u.token });
  assert.equal(list.body[0].title, 'Table booked');
  assert.equal((await call('GET', '/api/notifications/unread', undefined, { token: u.token })).body.count, 1);
  await call('POST', '/api/notifications/read', {}, { token: u.token });
  assert.equal((await call('GET', '/api/notifications/unread', undefined, { token: u.token })).body.count, 0);
});

test('reminder 2 hours before, once; turning reminders off keeps the bell but stops the email', async () => {
  const b = await book('2026-10-22', '18:00');
  await created.runJobs();
  assert.ok(!outbox().some(m => /^Reminder/.test(m.subject)), 'not yet: 3 h before');
  clock = new Date('2026-10-22T13:05:00Z'); // 16:05, under 2 h
  await created.runJobs();
  await created.runJobs();
  assert.equal(outbox().filter(m => /^Reminder: Table at 18:00/.test(m.subject)).length, 1);
  assert.ok(created.reservations.byCode(b.code).reminderSentAt);

  await call('PUT', '/api/notifications/settings', { reminders: false }, { token: u.token });
  assert.deepEqual((await call('GET', '/api/notifications/settings', undefined, { token: u.token })).body, { email: true, reminders: false });
  await book('2026-10-22', '17:30', {}, { area: 2 });
  const sent = outbox().length;
  clock = new Date('2026-10-22T14:00:00Z'); // 17:00
  await created.runJobs();
  assert.equal(outbox().length, sent, 'no reminder email');
  const bell = await call('GET', '/api/notifications', undefined, { token: u.token });
  assert.equal(bell.body.filter(n => n.type === 'booking_reminder').length, 2);
});

test('split the cost: invited players get a pay link by email', async () => {
  await book('2026-10-25', '20:00', { players: 2, split: true, invites: [{ name: 'Amit Levi', email: 'amit@example.com' }] }, { players: 2 });
  const mail = outbox().find(m => m.to === 'amit@example.com');
  assert.equal(mail.subject, 'Noa split a table with you');
  assert.match(mail.text, /Your share is 30 ILS/);
  assert.match(mail.html, /https:\/\/club.example\/pay.html\?t=/);
});

test('membership: renewal heads-up 3 days before; a failed payment is always emailed', async () => {
  await call('PUT', '/api/me/plan', { plan: 'club' }, { token: u.token });
  await call('PUT', '/api/notifications/settings', { email: false }, { token: u.token });
  clock = new Date('2026-11-20T12:00:00Z');
  await created.runJobs();
  await created.runJobs();
  const renew = created.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'membership_renewing'").get().n;
  assert.equal(renew, 1);
  assert.ok(!outbox().some(m => /renews/.test(m.subject)), 'email updates are off');

  // Renewal charge fails → past due, emailed even with email updates off
  created.payments.chargeSaved = async () => ({ status: 'failed' });
  clock = new Date('2026-11-22T12:00:01Z');
  await created.runJobs();
  assert.equal(created.memberships.view(u.id).status, 'past_due');
  assert.ok(outbox().some(m => m.subject === 'Payment failed' && m.to === 'noa@example.com'));
});

test('password reset email is branded and keeps the link in plain text', async () => {
  await call('POST', '/api/auth/forgot', { email: 'noa@example.com' });
  const mail = outbox().at(-1);
  assert.match(mail.text, /reset-password\?token=/);
  assert.match(mail.html, /Set a new password/);
});
