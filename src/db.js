const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    manageToken TEXT NOT NULL,
    tableId INTEGER NOT NULL REFERENCES tables(id),
    date TEXT NOT NULL,
    startMin INTEGER NOT NULL,
    endMin INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    players INTEGER NOT NULL,
    price REAL NOT NULL,
    type TEXT NOT NULL DEFAULT 'casual',
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, tableId);
  CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone);

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tableId INTEGER REFERENCES tables(id),
    date TEXT NOT NULL,
    startMin INTEGER NOT NULL,
    endMin INTEGER NOT NULL,
    reason TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks(date);

  -- Accounts (Phase 2). Guest bookings keep working without one.
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'PLAYER',
    skillLevel TEXT NOT NULL,
    planId TEXT NOT NULL DEFAULT 'dropin',
    planStatus TEXT NOT NULL DEFAULT 'active',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- Only a SHA-256 of each token is stored, so a leaked database can't be used to log in.
  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY,
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);

  CREATE TABLE IF NOT EXISTS password_resets (
    tokenHash TEXT PRIMARY KEY,
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expiresAt TEXT NOT NULL,
    usedAt TEXT
  );
`;

const INITIAL_TABLE_COUNT = 5;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Databases created before booking types existed
  const columns = db.prepare('PRAGMA table_info(bookings)').all().map(c => c.name);
  if (!columns.includes('type')) db.exec("ALTER TABLE bookings ADD COLUMN type TEXT NOT NULL DEFAULT 'casual'");

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM tables').get();
  if (count === 0) {
    const insert = db.prepare('INSERT INTO tables (name) VALUES (?)');
    for (let i = 1; i <= INITIAL_TABLE_COUNT; i++) insert.run(`Table ${i}`);
  }
  return db;
}

module.exports = { openDb };
