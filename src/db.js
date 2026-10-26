const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { migrate } = require('./migrations');

// Opens the database and brings its schema up to date (see migrations.js).
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

module.exports = { openDb };
