// Usage: npm run seed [-- --seed 42]
// Resets the demo data in DB_PATH (see src/seed.js). Accounts outside @rallyclub.test are kept.
const path = require('path');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { seedDemo } = require('../src/seed');

const args = process.argv.slice(2);
const seedArg = args.indexOf('--seed');
const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : Date.now() % 1e9;

const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pingpong.db');
const db = openDb(dbFile);
const r = seedDemo(db, createService(db), { seed });
db.close();

console.log(`Seeded ${dbFile} (seed ${seed})
  ${r.areas} areas · ${r.tables} tables · ${r.plans} plans · ${r.priceRules} price rules
  ${r.coaches} coaches · ${r.lessonTypes} lesson types · ${r.classes} classes · ${r.bookings} bookings

Demo logins (password: ${r.logins.password})
  player  ${r.logins.player}
  coach   ${r.logins.coach}
  admin   ${r.logins.admin}`);
