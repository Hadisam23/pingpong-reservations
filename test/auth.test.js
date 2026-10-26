const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server, base, created, clock;

beforeEach(async () => {
  clock = new Date('2026-10-22T12:00:00Z');
  created = createApp({ adminPassword: 'secret', now: () => clock });
  await new Promise(resolve => { server = created.app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise(resolve => server.close(resolve)));

async function call(method, path, body, { token, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

const newUser = (over = {}) => ({
  name: 'Noa Cohen', email: 'noa@example.com', phone: '052-123-4567', password: 'table-tennis', skillLevel: 'intermediate', acceptTerms: true, ...over,
});
const signup = over => call('POST', '/api/auth/signup', newUser(over));

test('sign up creates an account, a session cookie and a Drop-in plan', async () => {
  const res = await signup();
  assert.equal(res.status, 201);
  assert.equal(res.body.user.name, 'Noa Cohen');
  assert.equal(res.body.user.email, 'noa@example.com');
  assert.equal(res.body.user.phone, '0521234567');
  assert.equal(res.body.user.skillLevel, 'intermediate');
  assert.equal(res.body.user.role, 'PLAYER');
  assert.deepEqual(res.body.user.plan, { id: 'dropin', name: 'Drop-in', price: 0, bookingWindowDays: 3, status: 'active', currentPeriodEnd: null });
  assert.deepEqual(res.body.user.stats, { sessionsThisMonth: 0, tableCredits: 0 });
  assert.ok(!('passwordHash' in res.body.user));
  assert.ok(res.body.token.length > 30);

  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^rc_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  // The password is stored hashed, never as text
  const row = created.db.prepare('SELECT passwordHash FROM users').get();
  assert.match(row.passwordHash, /^scrypt\$/);
  assert.ok(!row.passwordHash.includes('table-tennis'));
});

test('sign up validates every field and names it', async () => {
  const cases = [
    [{ name: 'N' }, 'name'],
    [{ email: 'not-an-email' }, 'email'],
    [{ phone: '123' }, 'phone'],
    [{ password: 'short' }, 'password'],
    [{ skillLevel: 'pro' }, 'skillLevel'],
    [{ acceptTerms: false }, 'acceptTerms'],
  ];
  for (const [over, field] of cases) {
    const res = await signup(over);
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal(res.body.error.code, 'invalid_input');
    assert.equal(res.body.error.field, field);
  }
});

test('one account per email, case-insensitive', async () => {
  assert.equal((await signup()).status, 201);
  const again = await signup({ email: 'NOA@Example.com ' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'email_taken');
  assert.equal(again.body.error.field, 'email');
});

test('log in, /me with cookie or bearer, log out', async () => {
  await signup();
  const wrong = await call('POST', '/api/auth/login', { email: 'noa@example.com', password: 'nope-nope' });
  assert.equal(wrong.status, 401);
  const unknown = await call('POST', '/api/auth/login', { email: 'ghost@example.com', password: 'nope-nope' });
  assert.equal(unknown.body.error.message, wrong.body.error.message); // no hint which emails exist

  const ok = await call('POST', '/api/auth/login', { email: ' Noa@Example.com', password: 'table-tennis' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/me', undefined, { cookie })).body.email, 'noa@example.com');
  assert.equal((await call('GET', '/api/me', undefined, { token: ok.body.token })).body.name, 'Noa Cohen');
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.deepEqual((await call('GET', '/api/session')).body, { user: null });
  assert.equal((await call('GET', '/api/session', undefined, { cookie })).body.user.name, 'Noa Cohen');

  assert.equal((await call('POST', '/api/auth/logout', undefined, { token: ok.body.token })).status, 204);
  assert.equal((await call('GET', '/api/me', undefined, { token: ok.body.token })).status, 401);
});

test('sessions expire after 30 days', async () => {
  const { body } = await signup();
  clock = new Date(clock.getTime() + 29 * 86400000);
  assert.equal((await call('GET', '/api/me', undefined, { token: body.token })).status, 200);
  clock = new Date(clock.getTime() + 2 * 86400000);
  assert.equal((await call('GET', '/api/me', undefined, { token: body.token })).status, 401);
});

test('too many failed logins are slowed down', async () => {
  await signup();
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('POST', '/api/auth/login', { email: 'noa@example.com', password: 'wrong-wrong' })).status, 401);
  }
  const blocked = await call('POST', '/api/auth/login', { email: 'noa@example.com', password: 'table-tennis' });
  assert.equal(blocked.status, 429);
  clock = new Date(clock.getTime() + 16 * 60000);
  assert.equal((await call('POST', '/api/auth/login', { email: 'noa@example.com', password: 'table-tennis' })).status, 200);
});

test('forgot password emails a single-use link that expires', async () => {
  const { body: first } = await signup();
  // Unknown emails get the same answer and no email
  assert.deepEqual((await call('POST', '/api/auth/forgot', { email: 'ghost@example.com' })).body, { ok: true });
  assert.equal(created.mailer.outbox.length, 0);

  assert.deepEqual((await call('POST', '/api/auth/forgot', { email: 'NOA@example.com' })).body, { ok: true });
  assert.equal(created.mailer.outbox.length, 1);
  const mail = created.mailer.outbox[0];
  assert.equal(mail.to, 'noa@example.com');
  const token = /reset-password\?token=([\w-]+)/.exec(mail.text)[1];

  assert.equal((await call('POST', '/api/auth/reset', { token, password: 'short' })).body.error.field, 'password');
  const reset = await call('POST', '/api/auth/reset', { token, password: 'new-password-1' });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.token);
  // Old sessions are logged out, the link can't be reused, the new password works
  assert.equal((await call('GET', '/api/me', undefined, { token: first.token })).status, 401);
  assert.equal((await call('POST', '/api/auth/reset', { token, password: 'another-one-2' })).body.error.code, 'invalid_reset_link');
  assert.equal((await call('POST', '/api/auth/login', { email: 'noa@example.com', password: 'new-password-1' })).status, 200);

  // Links expire after an hour
  await call('POST', '/api/auth/forgot', { email: 'noa@example.com' });
  const late = /reset-password\?token=([\w-]+)/.exec(created.mailer.outbox.at(-1).text)[1];
  clock = new Date(clock.getTime() + 61 * 60000);
  assert.equal((await call('POST', '/api/auth/reset', { token: late, password: 'too-late-123' })).body.error.code, 'invalid_reset_link');
});

test('profile edits and plan choice', async () => {
  const { body } = await signup();
  const opts = { token: body.token };
  const edited = await call('PATCH', '/api/me', { name: 'Noa Levi', skillLevel: 'advanced', phone: '+972 52 555 0101' }, opts);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.name, 'Noa Levi');
  assert.equal(edited.body.skillLevel, 'advanced');
  assert.equal(edited.body.phone, '+972525550101');
  assert.equal((await call('PATCH', '/api/me', { name: '' }, opts)).body.error.field, 'name');

  await signup({ email: 'other@example.com' });
  assert.equal((await call('PATCH', '/api/me', { email: 'other@example.com' }, opts)).status, 409);

  const plans = await call('GET', '/api/plans');
  assert.deepEqual(plans.body.map(p => p.id), ['dropin', 'club', 'pro']);
  const club = await call('PUT', '/api/me/plan', { plan: 'club' }, opts);
  assert.equal(club.body.plan.id, 'club');
  assert.equal(club.body.plan.status, 'pending_payment');
  assert.equal(club.body.plan.bookingWindowDays, 14);
  assert.equal((await call('PUT', '/api/me/plan', { plan: 'dropin' }, opts)).body.plan.status, 'active');
  assert.equal((await call('PUT', '/api/me/plan', { plan: 'gold' }, opts)).status, 400);
  assert.equal((await call('PUT', '/api/me/plan', { plan: 'club' })).status, 401);
});

test('guest booking still works without an account', async () => {
  const res = await call('POST', '/api/bookings', {
    tableId: 1, date: '2026-10-25', start: '10:00', duration: 60, name: 'Walk Up', phone: '0500000001',
  });
  assert.equal(res.status, 201);
});

test('account pages are served', async () => {
  for (const path of ['/welcome', '/signup', '/login', '/forgot-password', '/reset-password', '/profile', '/profile/edit']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /html/);
  }
});
