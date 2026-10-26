// Usage: npm run make-admin -- someone@club.com
// Gives an existing account the ADMIN role (front desk / admin panel at /admin).
const path = require('path');
const { openDb } = require('../src/db');

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -- someone@club.com');
  process.exit(1);
}
const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pingpong.db');
const db = openDb(dbFile);
const { changes } = db.prepare("UPDATE users SET role = 'ADMIN' WHERE email = ?").run(email);
db.close();
if (!changes) {
  console.error(`No account with ${email}. Sign up in the app first, then run this again.`);
  process.exit(1);
}
console.log(`${email} is now an admin. Log in at /admin.`);
