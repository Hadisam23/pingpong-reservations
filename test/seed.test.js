const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { seedDemo } = require('../src/seed');

test('demo seed: 5 tables, every booking type, no overlaps, reproducible', () => {
  const run = seed => {
    const db = openDb(':memory:');
    const service = createService(db, { now: () => new Date('2026-10-22T12:00:00Z') });
    const result = seedDemo(db, service, { seed });
    return { db, result };
  };

  const { db, result } = run(42);
  assert.equal(result.tables, 5);
  assert.ok(result.bookings > 50, `only ${result.bookings} bookings`);

  const types = db.prepare('SELECT DISTINCT type FROM bookings ORDER BY type').all().map(r => r.type);
  assert.deepEqual(types, ['casual', 'coaching', 'league', 'party', 'training']);
  const statuses = db.prepare('SELECT DISTINCT status FROM bookings ORDER BY status').all().map(r => r.status);
  assert.deepEqual(statuses, ['cancelled', 'checked_in', 'confirmed', 'no_show']);

  const overlaps = db.prepare(`SELECT COUNT(*) AS c FROM bookings a JOIN bookings b
    ON a.tableId = b.tableId AND a.date = b.date AND a.id < b.id AND a.startMin < b.endMin AND a.endMin > b.startMin`).get().c;
  assert.equal(overlaps, 0);

  const parties = db.prepare("SELECT MIN(endMin - startMin) AS m FROM bookings WHERE type = 'party'").get().m;
  assert.ok(parties >= 120);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM blocks').get().c, 1);
  assert.equal(run(42).result.bookings, result.bookings);
});
