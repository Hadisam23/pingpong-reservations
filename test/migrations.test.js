const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb } = require('../src/db');
const { MIGRATIONS } = require('../src/migrations');

test('a fresh database gets the latest schema, 4 tables in 2 areas and the plans', () => {
  const db = openDb(':memory:');
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  const tables = db.prepare('SELECT t.name, a.name AS area FROM tables t JOIN areas a ON a.id = t.areaId ORDER BY t.id').all();
  assert.deepEqual(tables.map(t => `${t.name}/${t.area}`),
    ['Table 1/Main hall', 'Table 2/Main hall', 'Table 3/Main hall', 'Table 4/Private room']);
  assert.deepEqual(db.prepare('SELECT id FROM membership_plans ORDER BY sortOrder').all().map(p => p.id), ['dropin', 'club', 'pro']);
});

test('a Phase 2 database is upgraded in place without losing data', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mig-')), 'old.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tables (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, manageToken TEXT NOT NULL,
      tableId INTEGER NOT NULL REFERENCES tables(id), date TEXT NOT NULL, startMin INTEGER NOT NULL, endMin INTEGER NOT NULL,
      name TEXT NOT NULL, phone TEXT, players INTEGER NOT NULL, price REAL NOT NULL, type TEXT NOT NULL DEFAULT 'casual',
      status TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, tableId INTEGER REFERENCES tables(id), date TEXT NOT NULL,
      startMin INTEGER NOT NULL, endMin INTEGER NOT NULL, reason TEXT, createdAt TEXT NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT,
      passwordHash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'PLAYER', skillLevel TEXT NOT NULL,
      planId TEXT NOT NULL DEFAULT 'dropin', planStatus TEXT NOT NULL DEFAULT 'active', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE sessions (tokenHash TEXT PRIMARY KEY, userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL);
    CREATE TABLE password_resets (tokenHash TEXT PRIMARY KEY, userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expiresAt TEXT NOT NULL, usedAt TEXT);
  `);
  const ts = '2026-10-01T10:00:00Z';
  for (let i = 1; i <= 5; i++) old.prepare('INSERT INTO tables (name) VALUES (?)').run(`Table ${i}`);
  old.prepare(`INSERT INTO users (name, email, passwordHash, skillLevel, planId, planStatus, createdAt, updatedAt)
    VALUES ('Old Member', 'old@example.com', 'x', 'beginner', 'club', 'pending_payment', ?, ?)`).run(ts, ts);
  old.prepare(`INSERT INTO bookings (code, manageToken, tableId, date, startMin, endMin, name, players, price, type, status, source, createdAt, updatedAt)
    VALUES ('ABC123', 'tok', 5, '2026-10-02', 600, 660, 'Guest', 2, 60, 'training', 'confirmed', 'online', ?, ?)`).run(ts, ts);
  old.close();

  const db = openDb(file);
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  // Existing tables are kept and go to the main hall
  const tables = db.prepare('SELECT t.name, a.name AS area FROM tables t JOIN areas a ON a.id = t.areaId').all();
  assert.equal(tables.length, 5);
  assert.ok(tables.every(t => t.area === 'Main hall'));
  const m = db.prepare('SELECT m.planId, m.status FROM memberships m JOIN users u ON u.id = m.userId WHERE u.email = ?').get('old@example.com');
  assert.deepEqual({ ...m }, { planId: 'club', status: 'PENDING_PAYMENT' });
  const b = db.prepare("SELECT tableId, type, kind, userId FROM bookings WHERE code = 'ABC123'").get();
  assert.deepEqual({ ...b }, { tableId: 5, type: 'training', kind: 'TABLE', userId: null });
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();

  // Opening again is a no-op
  const again = openDb(file);
  assert.equal(again.prepare('SELECT COUNT(*) AS c FROM tables').get().c, 5);
  again.close();
});
