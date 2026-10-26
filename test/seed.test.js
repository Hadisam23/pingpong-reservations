const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { createAuth } = require('../src/auth');
const { createMailer } = require('../src/mailer');
const { seedDemo, DEMO_PASSWORD } = require('../src/seed');

const NOW = new Date('2026-10-22T12:00:00Z');
const run = seed => {
  const db = openDb(':memory:');
  const service = createService(db, { now: () => NOW });
  const result = seedDemo(db, service, { seed });
  return { db, result };
};

test('demo seed: 4 tables in 2 areas, plans, coaches, classes, no overlaps, reproducible', () => {
  const { db, result } = run(42);
  assert.equal(result.tables, 4);
  assert.equal(result.areas, 2);
  const byArea = db.prepare(`SELECT a.name, COUNT(*) AS c FROM tables t JOIN areas a ON a.id = t.areaId
    WHERE t.active = 1 GROUP BY a.name ORDER BY a.name`).all();
  assert.deepEqual(byArea.map(r => [r.name, r.c]), [['Main hall', 3], ['Private room', 1]]);

  assert.equal(result.plans, 3);
  assert.equal(result.priceRules, 6);
  assert.equal(result.coaches, 3);
  assert.equal(result.lessonTypes, 3);
  assert.equal(result.classes, 5);
  assert.ok(result.bookings > 50, `only ${result.bookings} bookings`);
  const coachesWithoutHours = db.prepare(`SELECT COUNT(*) AS c FROM coaches c
    WHERE NOT EXISTS (SELECT 1 FROM coach_availability a WHERE a.coachId = c.id)`).get().c;
  assert.equal(coachesWithoutHours, 0);

  const types = db.prepare("SELECT DISTINCT type FROM bookings WHERE kind = 'TABLE' ORDER BY type").all().map(r => r.type);
  for (const t of ['casual', 'league', 'party', 'training']) assert.ok(types.includes(t), `no ${t} bookings`);
  const kinds = db.prepare('SELECT DISTINCT kind FROM bookings ORDER BY kind').all().map(r => r.kind);
  assert.deepEqual(kinds, ['CLASS', 'LESSON', 'TABLE']);

  // Class seats have no table; table bookings never overlap each other or a class's tables
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE kind = 'CLASS' AND tableId IS NOT NULL").get().c, 0);
  const overlaps = db.prepare(`SELECT COUNT(*) AS c FROM bookings a JOIN bookings b
    ON a.tableId = b.tableId AND a.date = b.date AND a.id < b.id AND a.startMin < b.endMin AND a.endMin > b.startMin
    WHERE a.status NOT IN ('cancelled') AND b.status NOT IN ('cancelled')`).get().c;
  assert.equal(overlaps, 0);

  // One full class, with the demo player first on its waitlist
  const full = db.prepare(`SELECT s.id, s.capacity, COUNT(b.id) AS seats FROM class_sessions s
    JOIN bookings b ON b.classSessionId = s.id GROUP BY s.id HAVING seats >= s.capacity`).all();
  assert.equal(full.length, 1);
  const player = db.prepare("SELECT id FROM users WHERE email = 'player@rallyclub.test'").get();
  assert.deepEqual(db.prepare('SELECT classSessionId, position FROM waitlist WHERE userId = ?').get(player.id),
    { classSessionId: full[0].id, position: 1 });

  const pack = db.prepare('SELECT lessonsTotal, lessonsUsed FROM lesson_packs WHERE userId = ?').get(player.id);
  assert.deepEqual({ ...pack }, { lessonsTotal: 10, lessonsUsed: 6 });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM blocks').get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM promo_codes WHERE code = 'WELCOME10'").get().c, 1);

  assert.equal(run(42).result.bookings, result.bookings);
});

test('demo seed: the demo logins work and the player looks like a Club member', () => {
  const { db } = run(7);
  const auth = createAuth(db, { mailer: createMailer(), now: () => NOW });
  const { user } = auth.login({ email: 'player@rallyclub.test', password: DEMO_PASSWORD });
  assert.equal(user.name, 'Noa Cohen');
  assert.equal(user.plan.id, 'club');
  assert.equal(user.plan.status, 'active');
  assert.ok(user.plan.currentPeriodEnd);
  assert.equal(user.stats.tableCredits, 3);
  assert.ok(user.stats.sessionsThisMonth >= 2);
  assert.equal(auth.login({ email: 'admin@rallyclub.test', password: DEMO_PASSWORD }).user.role, 'ADMIN');
  assert.equal(auth.login({ email: 'coach@rallyclub.test', password: DEMO_PASSWORD }).user.role, 'COACH');
});

test('demo seed: re-seeding keeps real accounts and replaces demo ones', () => {
  const { db } = run(1);
  const auth = createAuth(db, { mailer: createMailer(), now: () => NOW });
  auth.signup({ name: 'Real Person', email: 'real@example.com', phone: '052-555-0199', password: 'a-long-password', skillLevel: 'beginner', acceptTerms: true });
  seedDemo(db, createService(db, { now: () => NOW }), { seed: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE email = 'real@example.com'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE email = 'player@rallyclub.test'").get().c, 1);
});
