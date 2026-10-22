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
`;

const INITIAL_TABLE_COUNT = 6;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM tables').get();
  if (count === 0) {
    const insert = db.prepare('INSERT INTO tables (name) VALUES (?)');
    for (let i = 1; i <= INITIAL_TABLE_COUNT; i++) insert.run(`Table ${i}`);
  }
  return db;
}

module.exports = { openDb };
