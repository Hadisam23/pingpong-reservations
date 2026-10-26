// Memberships (Phase 6): monthly subscriptions to a plan.
//   demo   — the card is charged at once and renewals run from the background job.
//   stripe — Stripe Checkout in subscription mode; Stripe renews, and webhooks keep the
//            membership in step (paid → ACTIVE, failed payment → PAST_DUE, deleted → Drop-in).
// Member pricing and the longer booking window only apply while the status is ACTIVE.
// Each paid period starts with the plan's table credits; unused ones lapse at renewal.
const { ApiError } = require('./service');
const { findPlan, listPlans } = require('./plans');

const RENEWAL_NOTICE_DAYS = 3;

function addMonth(date) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  if (d.getUTCDate() < day) d.setUTCDate(0);   // 31 Jan → 28/29 Feb
  return d;
}

function createMemberships(db, { payments, notifier, service, now = () => new Date() }) {
  const stmts = {
    get: db.prepare('SELECT * FROM memberships WHERE userId = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    upsert: db.prepare(`INSERT INTO memberships (userId, planId, status, currentPeriodEnd, cancelAtPeriodEnd, stripeSubscriptionId, createdAt, updatedAt)
      VALUES (@userId, @planId, @status, @currentPeriodEnd, 0, @stripeSubscriptionId, @now, @now)
      ON CONFLICT(userId) DO UPDATE SET planId = excluded.planId, status = excluded.status, currentPeriodEnd = excluded.currentPeriodEnd,
        cancelAtPeriodEnd = 0, stripeSubscriptionId = excluded.stripeSubscriptionId, updatedAt = excluded.updatedAt`),
    setStatus: db.prepare('UPDATE memberships SET status = ?, updatedAt = ? WHERE userId = ?'),
    setCancel: db.prepare('UPDATE memberships SET cancelAtPeriodEnd = ?, updatedAt = ? WHERE userId = ?'),
    setPeriod: db.prepare('UPDATE memberships SET currentPeriodEnd = ?, status = ?, updatedAt = ? WHERE userId = ?'),
    setPlan: db.prepare('UPDATE memberships SET planId = ?, updatedAt = ? WHERE userId = ?'),
    bySubscription: db.prepare('SELECT * FROM memberships WHERE stripeSubscriptionId = ?'),
    due: db.prepare(`SELECT * FROM memberships WHERE planId != 'dropin' AND currentPeriodEnd IS NOT NULL AND currentPeriodEnd <= ?
      AND stripeSubscriptionId IS NULL AND status IN ('ACTIVE', 'PAST_DUE')`),
    credits: db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE userId = ? AND type = 'TABLE_CREDIT'"),
    renewingSoon: db.prepare(`SELECT * FROM memberships WHERE status = 'ACTIVE' AND planId != 'dropin' AND cancelAtPeriodEnd = 0
      AND currentPeriodEnd > ? AND currentPeriodEnd <= ? AND (renewalNoticeFor IS NULL OR renewalNoticeFor != currentPeriodEnd)`),
    noticeSent: db.prepare('UPDATE memberships SET renewalNoticeFor = ? WHERE userId = ?'),
    ledger: db.prepare("INSERT INTO credit_ledger (userId, type, delta, reason, bookingId, createdAt) VALUES (?, 'TABLE_CREDIT', ?, ?, NULL, ?)"),
  };
  const iso = () => now().toISOString();
  const currency = () => service.getSettings().currency;

  function requirePlan(id) {
    const plan = typeof id === 'string' ? findPlan(db, id) : null;
    if (!plan) throw new ApiError(400, 'invalid_input', 'Pick a plan', { field: 'plan' });
    return plan;
  }

  // A new paid period: last period's unused credits lapse, the plan's credits arrive
  function startPeriod(userId, plan, periodEnd) {
    db.transaction(() => {
      const left = stmts.credits.get(userId).n;
      if (left > 0) stmts.ledger.run(userId, -left, 'Unused credits lapsed at renewal', iso());
      if (plan.monthlyTableCredits) stmts.ledger.run(userId, plan.monthlyTableCredits, `${plan.name} plan: monthly table credits`, iso());
      stmts.setPeriod.run(periodEnd, 'ACTIVE', iso(), userId);
    })();
  }

  function view(userId) {
    const m = stmts.get.get(userId) || { planId: 'dropin', status: 'ACTIVE', cancelAtPeriodEnd: 0 };
    const plan = findPlan(db, m.planId) || findPlan(db, 'dropin');
    return {
      plan: { ...plan, currency: currency() },
      status: m.status.toLowerCase(),
      currentPeriodEnd: m.currentPeriodEnd || null,
      cancelAtPeriodEnd: !!m.cancelAtPeriodEnd,
      stripe: !!m.stripeSubscriptionId,
      provider: payments.provider,
      card: payments.card,
      plans: listPlans(db).map(p => ({ ...p, currency: currency() })),
    };
  }

  // ---------- change plan ----------

  async function change(user, planId, { baseUrl } = {}) {
    const plan = requirePlan(planId);
    const current = stmts.get.get(user.id) || { planId: 'dropin', status: 'ACTIVE' };
    const paidNow = current.planId !== 'dropin' && current.status === 'ACTIVE';

    // Moving to Drop-in = cancel at the end of the paid period
    if (plan.price === 0) {
      if (paidNow) return cancel(user);
      stmts.upsert.run({ userId: user.id, planId: 'dropin', status: 'ACTIVE', currentPeriodEnd: null, stripeSubscriptionId: null, now: iso() });
      return view(user.id);
    }
    if (current.planId === plan.id && paidNow) {
      if (current.cancelAtPeriodEnd) return resume(user);
      return view(user.id);
    }

    // Already paying: switch plans on the same subscription (Stripe prorates; demo keeps the period)
    if (paidNow) {
      if (current.stripeSubscriptionId) {
        const sub = await payments.stripe('GET', `/subscriptions/${current.stripeSubscriptionId}`);
        await payments.stripe('POST', `/subscriptions/${current.stripeSubscriptionId}`, {
          items: [{ id: sub.items.data[0].id, price_data: priceData(plan) }], proration_behavior: 'create_prorations', cancel_at_period_end: false,
        });
      }
      db.transaction(() => {
        stmts.setPlan.run(plan.id, iso(), user.id);
        stmts.setCancel.run(0, iso(), user.id);
      })();
      notifier.notify({ userId: user.id, type: 'membership', title: `You're on ${plan.name}`, body: `Your plan changed to ${plan.name}.` });
      return view(user.id);
    }

    // New subscription
    if (payments.provider === 'stripe') {
      stmts.upsert.run({ userId: user.id, planId: plan.id, status: 'PENDING_PAYMENT', currentPeriodEnd: null, stripeSubscriptionId: null, now: iso() });
      const customer = await payments.customerFor(user.id);
      const session = await payments.stripe('POST', '/checkout/sessions', {
        mode: 'subscription', customer,
        line_items: [{ quantity: 1, price_data: priceData(plan) }],
        success_url: `${baseUrl}/membership.html?paid=1`, cancel_url: `${baseUrl}/membership.html`,
        metadata: { userId: user.id, planId: plan.id },
        subscription_data: { metadata: { userId: user.id, planId: plan.id } },
      });
      return { ...view(user.id), redirect: session.url };
    }
    const charged = await payments.charge({ kind: 'MEMBERSHIP', amount: plan.price, userId: user.id, description: `${plan.name} membership · 1 month` });
    if (charged.status !== 'succeeded') throw new ApiError(402, 'payment_failed', 'The payment did not go through.');
    stmts.upsert.run({ userId: user.id, planId: plan.id, status: 'ACTIVE', currentPeriodEnd: null, stripeSubscriptionId: null, now: iso() });
    startPeriod(user.id, plan, addMonth(now()).toISOString());
    notifier.notify({
      userId: user.id, type: 'membership', title: `Welcome to ${plan.name}`,
      body: `Member prices, ${plan.bookingWindowDays}-day booking${plan.monthlyTableCredits ? ` and ${plan.monthlyTableCredits} table credits` : ''} start now.`,
      emailSubject: `Welcome to ${plan.name}`,
      emailText: `You're now a ${plan.name} member. Your membership renews monthly; cancel anytime from your profile.`,
    });
    return view(user.id);
  }

  const priceData = plan => ({
    currency: currency().toLowerCase(), unit_amount: Math.round(plan.price * 100),
    recurring: { interval: 'month' }, product_data: { name: `Rally Club ${plan.name}` },
  });

  async function cancel(user) {
    const m = stmts.get.get(user.id);
    if (!m || m.planId === 'dropin') throw new ApiError(409, 'no_membership', "You don't have a paid membership.");
    if (m.status !== 'ACTIVE') {
      // Nothing paid for (pending or failed payment): drop to Drop-in at once
      if (m.stripeSubscriptionId) await payments.stripe('DELETE', `/subscriptions/${m.stripeSubscriptionId}`).catch(() => {});
      stmts.upsert.run({ userId: user.id, planId: 'dropin', status: 'ACTIVE', currentPeriodEnd: null, stripeSubscriptionId: null, now: iso() });
      return view(user.id);
    }
    if (m.stripeSubscriptionId) await payments.stripe('POST', `/subscriptions/${m.stripeSubscriptionId}`, { cancel_at_period_end: true });
    stmts.setCancel.run(1, iso(), user.id);
    const plan = findPlan(db, m.planId);
    notifier.notify({ userId: user.id, type: 'membership', title: 'Membership cancelled', body: `Your ${plan.name} benefits stay until ${m.currentPeriodEnd.slice(0, 10)}, then you move to Drop-in.` });
    return view(user.id);
  }

  async function resume(user) {
    const m = stmts.get.get(user.id);
    if (!m || !m.cancelAtPeriodEnd) return view(user.id);
    if (m.stripeSubscriptionId) await payments.stripe('POST', `/subscriptions/${m.stripeSubscriptionId}`, { cancel_at_period_end: false });
    stmts.setCancel.run(0, iso(), user.id);
    return view(user.id);
  }

  // Stripe Billing portal for cards and invoices (Stripe mode only)
  async function portal(user, { baseUrl }) {
    if (payments.provider !== 'stripe') return { demo: true, card: payments.card };
    const customer = await payments.customerFor(user.id);
    const s = await payments.stripe('POST', '/billing_portal/sessions', { customer, return_url: `${baseUrl}/profile.html` });
    return { redirect: s.url };
  }

  // ---------- renewals (demo provider) ----------

  // 3 days before a renewal: a heads-up with the amount
  function renewalNotices() {
    const soon = new Date(now().getTime() + RENEWAL_NOTICE_DAYS * 86400000).toISOString();
    for (const m of stmts.renewingSoon.all(iso(), soon)) {
      const plan = findPlan(db, m.planId);
      if (!plan || !plan.price) continue;
      stmts.noticeSent.run(m.currentPeriodEnd, m.userId);
      const on = new Date(m.currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      notifier.notify({
        userId: m.userId, type: 'membership_renewing', title: `${plan.name} renews ${on}`,
        body: `We'll charge ${plan.price} ${currency()} for the next month.`,
        emailText: `Your ${plan.name} membership renews on ${on} for ${plan.price} ${currency()}.\n\nNothing to do if you'd like to keep it. To change or cancel, open Membership in the app.`,
        button: { label: 'Manage membership', path: 'membership.html' },
      });
    }
  }

  async function runJobs() {
    renewalNotices();
    for (const m of stmts.due.all(iso())) {
      const plan = findPlan(db, m.planId);
      if (m.cancelAtPeriodEnd || !plan || plan.price === 0) {
        stmts.upsert.run({ userId: m.userId, planId: 'dropin', status: 'ACTIVE', currentPeriodEnd: null, stripeSubscriptionId: null, now: iso() });
        notifier.notify({ userId: m.userId, type: 'membership', title: "You're on Drop-in now", body: 'Your membership ended. Join again anytime from your profile.' });
        continue;
      }
      const res = await payments.chargeSaved({ kind: 'MEMBERSHIP', amount: plan.price, userId: m.userId, description: `${plan.name} membership · renewal` });
      if (res.status === 'succeeded') {
        startPeriod(m.userId, plan, addMonth(new Date(m.currentPeriodEnd)).toISOString());
      } else if (m.status !== 'PAST_DUE') {
        stmts.setStatus.run('PAST_DUE', iso(), m.userId);
        notifier.notify({
          userId: m.userId, type: 'payment_failed', title: 'Payment failed', critical: true,
          body: `We couldn't renew ${plan.name}. Member prices are paused until your card is updated.`,
          emailText: `We couldn't charge your card for ${plan.name}, so member prices and the longer booking window are paused.\n\nUpdate your card to switch them back on.`,
          button: { label: 'Update payment', path: 'membership.html' },
        });
      }
    }
  }

  // ---------- Stripe webhooks ----------

  async function syncSubscription(subscriptionId, { userId, planId } = {}) {
    const sub = await payments.stripe('GET', `/subscriptions/${subscriptionId}`);
    const meta = sub.metadata || {};
    const uid = Number(userId || meta.userId) || (stmts.bySubscription.get(subscriptionId) || {}).userId;
    if (!uid) return;
    const current = stmts.get.get(uid) || {};
    const plan = findPlan(db, planId || meta.planId || current.planId) || findPlan(db, 'dropin');
    const periodEnd = new Date((sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end)) * 1000).toISOString();
    const status = { active: 'ACTIVE', trialing: 'ACTIVE', past_due: 'PAST_DUE', unpaid: 'PAST_DUE', canceled: 'CANCELED', incomplete: 'PENDING_PAYMENT' }[sub.status] || 'PENDING_PAYMENT';
    if (status === 'CANCELED') {
      stmts.upsert.run({ userId: uid, planId: 'dropin', status: 'ACTIVE', currentPeriodEnd: null, stripeSubscriptionId: null, now: iso() });
      return;
    }
    const newPeriod = current.currentPeriodEnd !== periodEnd || current.stripeSubscriptionId !== subscriptionId;
    stmts.upsert.run({ userId: uid, planId: plan.id, status, currentPeriodEnd: current.currentPeriodEnd || null, stripeSubscriptionId: subscriptionId, now: iso() });
    stmts.setCancel.run(sub.cancel_at_period_end ? 1 : 0, iso(), uid);
    if (status === 'ACTIVE' && newPeriod) startPeriod(uid, plan, periodEnd);
    else stmts.setPeriod.run(periodEnd, status, iso(), uid);
  }

  payments.onEvent('checkout.session.completed', async obj => {
    if (obj.mode === 'subscription' && obj.subscription) await syncSubscription(obj.subscription, obj.metadata || {});
  });
  payments.onEvent('invoice.paid', async obj => { if (obj.subscription) await syncSubscription(obj.subscription); });
  payments.onEvent('invoice.payment_failed', async obj => {
    const m = obj.subscription && stmts.bySubscription.get(obj.subscription);
    if (m) {
      stmts.setStatus.run('PAST_DUE', iso(), m.userId);
      notifier.notify({
        userId: m.userId, type: 'payment_failed', title: 'Payment failed', critical: true, body: 'Member prices are paused until your card is updated.',
        emailText: "We couldn't charge your card for your membership, so member prices are paused.\n\nUpdate your card to switch them back on.",
        button: { label: 'Update payment', path: 'membership.html' },
      });
    }
  });
  payments.onEvent('customer.subscription.updated', async obj => syncSubscription(obj.id));
  payments.onEvent('customer.subscription.deleted', async obj => {
    const m = stmts.bySubscription.get(obj.id);
    if (m) stmts.upsert.run({ userId: m.userId, planId: 'dropin', status: 'ACTIVE', currentPeriodEnd: null, stripeSubscriptionId: null, now: iso() });
  });

  return { view, change, cancel, resume, portal, runJobs, addMonth };
}

module.exports = { createMemberships, addMonth };
