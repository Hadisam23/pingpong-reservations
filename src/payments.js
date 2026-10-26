// Card payments. Two providers behind one interface:
//   demo   — no keys needed: every payment succeeds at once with the test card 4242.
//   stripe — STRIPE_SECRET_KEY set: hosted Stripe Checkout, confirmed by the webhook
//            (STRIPE_WEBHOOK_SECRET). Talks to the Stripe REST API with fetch, no SDK.
// Every attempt is a row in `payments`; refunds flip its status.
const crypto = require('crypto');
const { ApiError } = require('./service');

const TEST_CARD = '4242 4242 4242 4242';
const SIGNATURE_TOLERANCE_S = 300;
const toMinor = amount => Math.round(amount * 100);

// { a: { b: 1 }, c: [{ x: 1 }] } → a[b]=1&c[0][x]=1 (Stripe's form encoding)
function formEncode(params, prefix = '', out = []) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')).filter(p => p.length === 2));
  const signatures = String(header || '').split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!parts.t || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(parts.t)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return signatures.some(sig => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}

function createPayments(db, {
  stripeKey = null, webhookSecret = null, fetchImpl = globalThis.fetch, currency = () => 'ILS', now = () => new Date(),
} = {}) {
  const provider = stripeKey ? 'stripe' : 'demo';
  const paidHandlers = {};
  const eventHandlers = {};

  const stmts = {
    insert: db.prepare(`INSERT INTO payments (bookingId, participantId, userId, kind, provider, amount, currency, status, providerRef, description, createdAt, updatedAt)
      VALUES (@bookingId, @participantId, @userId, @kind, @provider, @amount, @currency, @status, @providerRef, @description, @now, @now)`),
    get: db.prepare('SELECT * FROM payments WHERE id = ?'),
    byRef: db.prepare('SELECT * FROM payments WHERE providerRef = ?'),
    setStatus: db.prepare('UPDATE payments SET status = ?, updatedAt = ? WHERE id = ?'),
    setRef: db.prepare('UPDATE payments SET providerRef = ?, updatedAt = ? WHERE id = ?'),
    setIntent: db.prepare('UPDATE payments SET paymentIntent = ?, updatedAt = ? WHERE id = ?'),
    forBooking: db.prepare("SELECT * FROM payments WHERE bookingId = ? AND status = 'SUCCEEDED'"),
    user: db.prepare('SELECT id, name, email, stripeCustomerId FROM users WHERE id = ?'),
    setCustomer: db.prepare('UPDATE users SET stripeCustomerId = ? WHERE id = ?'),
  };

  function record({ kind, amount, userId = null, bookingId = null, participantId = null, description = null, status }) {
    const { lastInsertRowid } = stmts.insert.run({
      kind, amount, userId, bookingId, participantId, description, status,
      provider, currency: currency(), providerRef: null, now: now().toISOString(),
    });
    return stmts.get.get(lastInsertRowid);
  }

  async function stripe(method, path, params) {
    let res;
    try {
      res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${stripeKey}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: params ? formEncode(params) : undefined,
      });
    } catch {
      throw new ApiError(502, 'payment_unavailable', "We couldn't reach the payment provider. Please try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(402, 'payment_failed', (data.error && data.error.message) || 'The payment did not go through.');
    return data;
  }

  async function customerFor(userId) {
    const user = userId && stmts.user.get(userId);
    if (!user) return null;
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const c = await stripe('POST', '/customers', { email: user.email, name: user.name, metadata: { userId: user.id } });
    stmts.setCustomer.run(c.id, user.id);
    return c.id;
  }

  // Starts a payment. → { status: 'succeeded', payment } or { status: 'redirect', url, payment }
  async function charge({ kind, amount, userId, bookingId, participantId, description, email, successUrl, cancelUrl, saveCard = false }) {
    if (!(amount > 0)) throw new Error('charge() needs a positive amount');
    if (provider === 'demo') {
      return { status: 'succeeded', payment: record({ kind, amount, userId, bookingId, participantId, description, status: 'SUCCEEDED' }) };
    }
    const payment = record({ kind, amount, userId, bookingId, participantId, description, status: 'PENDING' });
    const customer = await customerFor(userId);
    const session = await stripe('POST', '/checkout/sessions', {
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: currency().toLowerCase(), unit_amount: toMinor(amount), product_data: { name: description || 'Rally Club' } } }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer: customer || undefined,
      customer_email: customer ? undefined : email || undefined,
      // Stripe's shortest allowed expiry; holds are extended to match
      expires_at: Math.floor(now().getTime() / 1000) + 31 * 60,
      metadata: { paymentId: payment.id, kind },
      payment_intent_data: saveCard && customer ? { setup_future_usage: 'off_session' } : undefined,
    });
    stmts.setRef.run(session.id, now().toISOString(), payment.id);
    return { status: 'redirect', url: session.url, payment: stmts.get.get(payment.id) };
  }

  // Charges the card a member already used (split-cost remainder). Never redirects.
  async function chargeSaved({ kind, amount, userId, bookingId, description }) {
    if (provider === 'demo') return { status: 'succeeded', payment: record({ kind, amount, userId, bookingId, description, status: 'SUCCEEDED' }) };
    const payment = record({ kind, amount, userId, bookingId, description, status: 'PENDING' });
    try {
      const customer = await customerFor(userId);
      const methods = await stripe('GET', `/payment_methods?customer=${encodeURIComponent(customer)}&type=card`);
      const pm = methods.data && methods.data[0];
      if (!pm) throw new ApiError(402, 'no_saved_card', 'No saved card');
      const intent = await stripe('POST', '/payment_intents', {
        amount: toMinor(amount), currency: currency().toLowerCase(), customer, payment_method: pm.id,
        off_session: true, confirm: true, description, metadata: { paymentId: payment.id, kind },
      });
      stmts.setIntent.run(intent.id, now().toISOString(), payment.id);
      stmts.setStatus.run(intent.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED', now().toISOString(), payment.id);
    } catch {
      stmts.setStatus.run('FAILED', now().toISOString(), payment.id);
    }
    const final = stmts.get.get(payment.id);
    return { status: final.status === 'SUCCEEDED' ? 'succeeded' : 'failed', payment: final };
  }

  async function refund(payment) {
    if (payment.status !== 'SUCCEEDED') return payment;
    if (payment.provider === 'stripe') {
      if (!payment.paymentIntent) throw new ApiError(409, 'refund_failed', 'This payment has no Stripe charge to refund.');
      await stripe('POST', '/refunds', { payment_intent: payment.paymentIntent });
    }
    stmts.setStatus.run('REFUNDED', now().toISOString(), payment.id);
    return stmts.get.get(payment.id);
  }

  const refundBooking = async bookingId => {
    for (const p of stmts.forBooking.all(bookingId)) await refund(p);
  };

  const succeeded = payment => {
    if (payment.status === 'SUCCEEDED') return;
    stmts.setStatus.run('SUCCEEDED', now().toISOString(), payment.id);
    const fresh = stmts.get.get(payment.id);
    if (paidHandlers[fresh.kind]) paidHandlers[fresh.kind](fresh);
  };

  // Stripe webhook. rawBody is the exact request body (a string).
  async function handleWebhook(rawBody, signature) {
    if (provider !== 'stripe' || !webhookSecret) throw new ApiError(404, 'not_found', 'Webhooks are not configured');
    if (!verifyStripeSignature(rawBody, signature, webhookSecret, Math.floor(now().getTime() / 1000))) {
      throw new ApiError(400, 'bad_signature', 'Invalid Stripe signature');
    }
    const event = JSON.parse(rawBody);
    const obj = event.data && event.data.object;
    if (event.type === 'checkout.session.completed' && obj.mode === 'payment') {
      const payment = stmts.byRef.get(obj.id);
      if (payment) {
        if (obj.payment_intent) stmts.setIntent.run(obj.payment_intent, now().toISOString(), payment.id);
        succeeded(stmts.get.get(payment.id));
      }
    } else if (event.type === 'checkout.session.expired' && obj.mode === 'payment') {
      const payment = stmts.byRef.get(obj.id);
      if (payment && payment.status === 'PENDING') stmts.setStatus.run('CANCELED', now().toISOString(), payment.id);
    }
    if (eventHandlers[event.type]) await eventHandlers[event.type](obj, event);
    return { received: true };
  }

  return {
    provider,
    TEST_CARD,
    card: provider === 'demo'
      ? { title: 'Card ending 4242', sub: 'Saved card · test mode' }
      : { title: 'Pay by card', sub: 'Secure checkout by Stripe' },
    charge, chargeSaved, refund, refundBooking, handleWebhook,
    onPaid: (kind, fn) => { paidHandlers[kind] = fn; },
    onEvent: (type, fn) => { eventHandlers[type] = fn; },
    stripe: (method, path, params) => stripe(method, path, params),
    customerFor,
    get: id => stmts.get.get(id),
    forBooking: bookingId => db.prepare('SELECT * FROM payments WHERE bookingId = ? ORDER BY id').all(bookingId),
  };
}

module.exports = { createPayments, formEncode, verifyStripeSignature, TEST_CARD };
