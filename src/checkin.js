// Check-in codes: a signed token (HMAC-SHA256) with the booking, the player and an expiry
// (the end of the booking). It goes into the QR code; the front desk scanner verifies it.
// The secret comes from CHECKIN_SECRET, or is generated once and kept in the database.
const crypto = require('crypto');

const PREFIX = 'RC1';
const EARLY_MINUTES = 15;

function loadSecret(db) {
  if (process.env.CHECKIN_SECRET) return process.env.CHECKIN_SECRET;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'checkinSecret'").get();
  if (row) return row.value;
  const secret = crypto.randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO settings (key, value) VALUES ('checkinSecret', ?)").run(secret);
  return secret;
}

function createCheckIn(db) {
  let secret = null;
  const key = () => (secret ||= loadSecret(db));
  const mac = body => crypto.createHmac('sha256', key()).update(body).digest('base64url').slice(0, 22);

  // expiresAt: Date or ms; the token stops working then
  function sign({ bookingId, userId, expiresAt }) {
    const body = `${PREFIX}.${bookingId}.${userId || 0}.${Math.floor(new Date(expiresAt).getTime() / 1000)}`;
    return `${body}.${mac(body)}`;
  }

  // → { bookingId, userId, expiresAt } or null when the token is forged or malformed
  function verify(token) {
    const parts = String(token ?? '').trim().split('.');
    if (parts.length !== 5 || parts[0] !== PREFIX) return null;
    const body = parts.slice(0, 4).join('.');
    const expected = Buffer.from(mac(body));
    const given = Buffer.from(parts[4]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return { bookingId: Number(parts[1]), userId: Number(parts[2]) || null, expiresAt: new Date(Number(parts[3]) * 1000) };
  }

  return { sign, verify, EARLY_MINUTES };
}

module.exports = { createCheckIn, EARLY_MINUTES };
