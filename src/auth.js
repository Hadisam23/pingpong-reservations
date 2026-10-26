// Accounts and sessions: email + password sign up, log in, log out, password reset,
// profile and plan choice. Passwords use scrypt; session and reset tokens are random
// and stored only as SHA-256 hashes.
const crypto = require('crypto');
const { ApiError, normalizePhone } = require('./service');
const { listPlans, findPlan } = require('./plans');
const { nowIn } = require('./time');

const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced'];
const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
const LOGIN_LIMIT = { attempts: 10, windowMs: 15 * 60 * 1000 };
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

// Each validation error names the field, so forms can show it in the right place.
const invalid = (field, message) => new ApiError(400, 'invalid_input', message, { field });

function cleanName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) throw invalid('name', 'Enter your first and last name');
  return name;
}

function cleanEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw invalid('email', 'Enter a valid email address');
  return email;
}

function cleanPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) throw invalid('phone', 'Enter a valid phone number');
  return phone;
}

function cleanPassword(value) {
  const password = String(value ?? '');
  if (password.length < 8) throw invalid('password', 'Use 8 or more characters');
  if (password.length > 128) throw invalid('password', 'Use 128 characters or fewer');
  return password;
}

function cleanLevel(value) {
  if (!SKILL_LEVELS.includes(value)) throw invalid('skillLevel', 'Pick your level');
  return value;
}

function createAuth(db, { mailer, now = () => new Date() } = {}) {
  const stmts = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare(`INSERT INTO users (name, email, phone, passwordHash, skillLevel, createdAt, updatedAt)
      VALUES (@name, @email, @phone, @passwordHash, @skillLevel, @now, @now)`),
    updateProfile: db.prepare('UPDATE users SET name = @name, email = @email, phone = @phone, skillLevel = @skillLevel, updatedAt = @now WHERE id = @id'),
    membership: db.prepare('SELECT * FROM memberships WHERE userId = ?'),
    upsertMembership: db.prepare(`INSERT INTO memberships (userId, planId, status, createdAt, updatedAt) VALUES (@userId, @planId, @status, @now, @now)
      ON CONFLICT(userId) DO UPDATE SET planId = excluded.planId, status = excluded.status, cancelAtPeriodEnd = 0, updatedAt = excluded.updatedAt`),
    creditBalance: db.prepare("SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_ledger WHERE userId = ? AND type = 'TABLE_CREDIT'"),
    sessionsInMonth: db.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE userId = ? AND date BETWEEN ? AND ?
      AND status IN ('confirmed', 'checked_in')`),
    clubTimezone: db.prepare("SELECT value FROM settings WHERE key = 'config'"),
    updatePassword: db.prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (tokenHash, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)'),
    sessionByHash: db.prepare('SELECT * FROM sessions WHERE tokenHash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE tokenHash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE userId = ?'),
    deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expiresAt <= ?'),
    insertReset: db.prepare('INSERT INTO password_resets (tokenHash, userId, expiresAt) VALUES (?, ?, ?)'),
    resetByHash: db.prepare('SELECT * FROM password_resets WHERE tokenHash = ?'),
    useReset: db.prepare('UPDATE password_resets SET usedAt = ? WHERE tokenHash = ?'),
    deleteUserResets: db.prepare('DELETE FROM password_resets WHERE userId = ?'),
  };

  // Failed logins per email and per IP, in memory. Enough for one server process.
  const failures = new Map();
  function checkRateLimit(keys) {
    const t = now().getTime();
    for (const key of keys) {
      const list = (failures.get(key) || []).filter(at => t - at < LOGIN_LIMIT.windowMs);
      failures.set(key, list);
      if (list.length >= LOGIN_LIMIT.attempts) {
        throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Wait 15 minutes and try again.');
      }
    }
  }
  function recordFailure(keys) {
    const t = now().getTime();
    for (const key of keys) failures.set(key, [...(failures.get(key) || []), t]);
  }

  function timezone() {
    const row = stmts.clubTimezone.get();
    return (row && JSON.parse(row.value).timezone) || 'Asia/Jerusalem';
  }

  function publicUser(row) {
    const membership = stmts.membership.get(row.id) || { planId: 'dropin', status: 'ACTIVE' };
    const plan = findPlan(db, membership.planId) || findPlan(db, 'dropin');
    const month = nowIn(timezone(), now()).date.slice(0, 7);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      skillLevel: row.skillLevel,
      role: row.role,
      memberSince: row.createdAt,
      plan: {
        id: plan.id, name: plan.name, price: plan.price, bookingWindowDays: plan.bookingWindowDays,
        status: membership.status === 'PENDING_PAYMENT' ? 'pending_payment' : membership.status.toLowerCase(),
        currentPeriodEnd: membership.currentPeriodEnd || null,
      },
      stats: {
        sessionsThisMonth: stmts.sessionsInMonth.get(row.id, `${month}-01`, `${month}-31`).c,
        tableCredits: stmts.creditBalance.get(row.id).balance,
      },
    };
  }

  function startSession(userId) {
    const token = newToken();
    const created = now();
    const expires = new Date(created.getTime() + SESSION_DAYS * 86400000);
    stmts.deleteExpiredSessions.run(created.toISOString());
    stmts.insertSession.run(sha256(token), userId, created.toISOString(), expires.toISOString());
    return { token, expiresAt: expires.toISOString() };
  }

  function signup(input = {}) {
    const name = cleanName(input.name);
    const email = cleanEmail(input.email);
    const phone = cleanPhone(input.phone);
    const password = cleanPassword(input.password);
    const skillLevel = cleanLevel(input.skillLevel);
    if (input.acceptTerms !== true) throw invalid('acceptTerms', 'Please agree to the club rules to continue');
    if (stmts.userByEmail.get(email)) {
      throw new ApiError(409, 'email_taken', 'An account with this email already exists. Log in instead.', { field: 'email' });
    }
    const { lastInsertRowid } = db.transaction(() => {
      const result = stmts.insertUser.run({ name, email, phone, passwordHash: hashPassword(password), skillLevel, now: now().toISOString() });
      stmts.upsertMembership.run({ userId: result.lastInsertRowid, planId: 'dropin', status: 'ACTIVE', now: now().toISOString() });
      return result;
    })();
    return { user: publicUser(stmts.userById.get(lastInsertRowid)), ...startSession(lastInsertRowid) };
  }

  function login({ email, password } = {}, { ip = '' } = {}) {
    const cleanEmailValue = String(email ?? '').trim().toLowerCase();
    const keys = [`email:${cleanEmailValue}`, `ip:${ip}`];
    checkRateLimit(keys);
    const row = cleanEmailValue ? stmts.userByEmail.get(cleanEmailValue) : null;
    // Same message whether the email exists or not
    if (!row || !verifyPassword(String(password ?? ''), row.passwordHash)) {
      recordFailure(keys);
      throw new ApiError(401, 'invalid_credentials', 'That email and password don\'t match.');
    }
    failures.delete(keys[0]);
    return { user: publicUser(row), ...startSession(row.id) };
  }

  function userForToken(token) {
    if (!token) return null;
    const session = stmts.sessionByHash.get(sha256(token));
    if (!session || session.expiresAt <= now().toISOString()) return null;
    const row = stmts.userById.get(session.userId);
    return row ? publicUser(row) : null;
  }

  function logout(token) {
    if (token) stmts.deleteSession.run(sha256(token));
  }

  function updateProfile(userId, input = {}) {
    const row = stmts.userById.get(userId);
    const email = input.email === undefined ? row.email : cleanEmail(input.email);
    if (email !== row.email && stmts.userByEmail.get(email)) {
      throw new ApiError(409, 'email_taken', 'Another account already uses this email.', { field: 'email' });
    }
    stmts.updateProfile.run({
      id: userId,
      name: input.name === undefined ? row.name : cleanName(input.name),
      email,
      phone: input.phone === undefined ? row.phone : cleanPhone(input.phone),
      skillLevel: input.skillLevel === undefined ? row.skillLevel : cleanLevel(input.skillLevel),
      now: now().toISOString(),
    });
    return publicUser(stmts.userById.get(userId));
  }

  // Free plans are active at once; paid plans wait for payment (Phase 6).
  function choosePlan(userId, planId) {
    const plan = typeof planId === 'string' ? findPlan(db, planId) : null;
    if (!plan) throw invalid('plan', 'Pick a plan');
    stmts.upsertMembership.run({ userId, planId: plan.id, status: plan.price === 0 ? 'ACTIVE' : 'PENDING_PAYMENT', now: now().toISOString() });
    return publicUser(stmts.userById.get(userId));
  }

  // Always succeeds from the caller's point of view, so it never reveals which emails have accounts.
  function requestPasswordReset(email, { baseUrl }) {
    const clean = String(email ?? '').trim().toLowerCase();
    const row = clean ? stmts.userByEmail.get(clean) : null;
    if (!row) return;
    const token = newToken();
    const expires = new Date(now().getTime() + RESET_MINUTES * 60000);
    stmts.insertReset.run(sha256(token), row.id, expires.toISOString());
    const link = `${baseUrl}/reset-password?token=${token}`;
    mailer.send({
      to: row.email,
      subject: 'Reset your Rally Club password',
      text: `Hi ${row.name.split(' ')[0]},\n\nUse this link to set a new password. It works once and expires in ${RESET_MINUTES} minutes:\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
    });
  }

  function resetPassword({ token, password } = {}) {
    const reset = token ? stmts.resetByHash.get(sha256(String(token))) : null;
    if (!reset || reset.usedAt || reset.expiresAt <= now().toISOString()) {
      throw new ApiError(400, 'invalid_reset_link', 'This reset link has expired or was already used. Request a new one.');
    }
    const clean = cleanPassword(password);
    const run = db.transaction(() => {
      stmts.useReset.run(now().toISOString(), reset.tokenHash);
      stmts.updatePassword.run(hashPassword(clean), now().toISOString(), reset.userId);
      // Log out every device, and burn any other reset links
      stmts.deleteUserSessions.run(reset.userId);
      stmts.deleteUserResets.run(reset.userId);
    });
    run();
    return { user: publicUser(stmts.userById.get(reset.userId)), ...startSession(reset.userId) };
  }

  return {
    signup, login, logout, userForToken, updateProfile, choosePlan, requestPasswordReset, resetPassword,
    plans: () => listPlans(db),
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, SKILL_LEVELS };
