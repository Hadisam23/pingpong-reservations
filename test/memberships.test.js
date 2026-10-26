const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');

let server, base, created, clock;
async function start(opts = {}) {
  clock = new Date('2026-10-22T12:00:00Z');
  created = createApp({ now: () => clock, ...opts });
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function signup() {
  const res = await call('POST', '/api/auth/signup', {
    name: 'Noa Cohen', email: `noa${Math.random()}@example.com`, phone: '052-123-4567', password: 'table-tennis', skillLevel: 'beginner', acceptTerms: true,
  });
  return { token: res.body.token, id: res.body.user.id };
}
const me = token => call('GET', '/api/me', undefined, { token }).then(r => r.body);

test('join Club (demo): charged, active, credits and member pricing start at once', async () => {
  const u = await signup();
  const res = await call('PUT', '/api/me/plan', { plan: 'club' }, { token: u.token });
  assert.equal(res.body.membership.status, 'active');
  assert.equal(res.body.membership.currentPeriodEnd, '2026-11-22T12:00:00.000Z');
  const payment = created.db.prepare("SELECT amount, status FROM payments WHERE kind = 'MEMBERSHIP'").get();
  assert.deepEqual({ ...payment }, { amount: 149, status: 'SUCCEEDED' });
  const user = await me(u.token);
  assert.equal(user.stats.tableCredits, 4);
  assert.equal(user.plan.bookingWindowDays, 14);
  const slots = await call('GET', '/api/tables/availability?date=2026-10-22&duration=60', undefined, { token: u.token });
  assert.equal(slots.body.slots.find(s => s.time === '18:00').price, 48);
});

test('upgrade keeps the period; cancel at period end; resume; renewal; then Drop-in', async () => {
  const u = await signup();
  await call('PUT', '/api/me/plan', { plan: 'club' }, { token: u.token });
  const pro = await call('PUT', '/api/me/plan', { plan: 'pro' }, { token: u.token });
  assert.equal(pro.body.membership.plan.id, 'pro');
  assert.equal(pro.body.membership.currentPeriodEnd, '2026-11-22T12:00:00.000Z');

  const cancelled = await call('POST', '/api/me/membership/cancel', {}, { token: u.token });
  assert.equal(cancelled.body.cancelAtPeriodEnd, true);
  assert.equal(cancelled.body.status, 'active', 'benefits stay until the period ends');
  assert.equal((await call('POST', '/api/me/membership/resume', {}, { token: u.token })).body.cancelAtPeriodEnd, false);

  // Renewal: charged again, a new period, credits reset
  created.db.prepare("INSERT INTO credit_ledger (userId, type, delta, reason, createdAt) VALUES (?, 'TABLE_CREDIT', 2, 'test', ?)").run(u.id, clock.toISOString());
  clock = new Date('2026-11-22T12:00:01Z');
  await created.runJobs();
  // (a month later the 30-day session has expired, so read the state directly)
  const credits = () => created.db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE userId = ? AND type = 'TABLE_CREDIT'").get(u.id).n;
  let m = created.memberships.view(u.id);
  assert.equal(m.currentPeriodEnd, '2026-12-22T12:00:00.000Z');
  assert.equal(credits(), 0, 'Pro has no table credits; leftovers lapse');
  assert.equal(created.db.prepare("SELECT COUNT(*) AS c FROM payments WHERE kind = 'MEMBERSHIP'").get().c, 2);

  // Cancel, then the period ends → Drop-in
  await created.memberships.change({ id: u.id }, 'dropin');
  assert.equal(created.memberships.view(u.id).cancelAtPeriodEnd, true);
  clock = new Date('2026-12-22T12:00:01Z');
  await created.runJobs();
  m = created.memberships.view(u.id);
  assert.deepEqual([m.plan.id, m.status, m.currentPeriodEnd], ['dropin', 'active', null]);
});

test('Stripe: subscription checkout, webhook activates, failed invoice → past due (no member price)', async () => {
  await new Promise(resolve => server.close(resolve));
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    let json = { id: 'cs_sub_1', url: 'https://checkout.stripe.com/c/cs_sub_1' };
    if (url.endsWith('/customers')) json = { id: 'cus_9' };
    if (url.includes('/subscriptions/sub_1')) {
      json = { id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: Date.parse('2026-11-22T12:00:00Z') / 1000, metadata: {}, items: { data: [{ id: 'si_1' }] } };
    }
    return { ok: true, json: async () => json };
  };
  await start({ stripeKey: 'sk_test', stripeWebhookSecret: 'whsec_test', fetchImpl: fakeFetch });
  const u = await signup();
  const res = await call('PUT', '/api/me/plan', { plan: 'club' }, { token: u.token });
  assert.equal(res.body.redirect, 'https://checkout.stripe.com/c/cs_sub_1');
  assert.equal(res.body.membership.status, 'pending_payment');
  const session = decodeURIComponent(calls.find(c => c.url.endsWith('/checkout/sessions')).body);
  assert.match(session, /mode=subscription/);
  assert.match(session, /line_items\[0\]\[price_data\]\[recurring\]\[interval\]=month/);

  const hook = async event => {
    const payload = JSON.stringify(event);
    const t = Math.floor(clock.getTime() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
    return call('POST', '/api/stripe/webhook', undefined, { raw: payload, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
  };
  await hook({ type: 'checkout.session.completed', data: { object: { id: 'cs_sub_1', mode: 'subscription', subscription: 'sub_1', metadata: { userId: String(u.id), planId: 'club' } } } });
  let m = (await call('GET', '/api/me/membership', undefined, { token: u.token })).body;
  assert.deepEqual([m.plan.id, m.status, m.currentPeriodEnd, m.stripe], ['club', 'active', '2026-11-22T12:00:00.000Z', true]);
  assert.equal((await me(u.token)).stats.tableCredits, 4);
  // The same period again (invoice.paid) doesn't add credits twice
  await hook({ type: 'invoice.paid', data: { object: { subscription: 'sub_1' } } });
  assert.equal((await me(u.token)).stats.tableCredits, 4);

  await hook({ type: 'invoice.payment_failed', data: { object: { subscription: 'sub_1' } } });
  m = (await call('GET', '/api/me/membership', undefined, { token: u.token })).body;
  assert.equal(m.status, 'past_due');
  const slots = await call('GET', '/api/tables/availability?date=2026-10-22&duration=60', undefined, { token: u.token });
  assert.equal(slots.body.slots.find(s => s.time === '18:00').price, 60, 'member price paused');

  await call('POST', '/api/me/membership/cancel', {}, { token: u.token });
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/subscriptions/sub_1')));
});
