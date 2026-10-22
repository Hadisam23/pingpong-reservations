// Usage: npm run seed [-- --seed 42]
// Replaces ALL bookings and blocks in DB_PATH with random demo data.
const path = require('path');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { seedDemo } = require('../src/seed');

const args = process.argv.slice(2);
const seedArg = args.indexOf('--seed');
const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : Date.now() % 1e9;

const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pingpong.db');
const db = openDb(dbFile);
const result = seedDemo(db, createService(db), { seed });
db.close();

console.log(`Seeded ${dbFile} (seed ${seed}): ${result.tables} tables, ${result.bookings} bookings`);
