const path = require('path');
const { createApp } = require('./src/app');
const { createMailer } = require('./src/mailer');

const PORT = process.env.PORT || 3000;
const dbFile = process.env.DB_PATH || path.join(__dirname, 'data', 'pingpong.db');
const adminPassword = process.env.ADMIN_PASSWORD || null;
const JOB_INTERVAL_MS = 60 * 1000;

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const { app, db, payments, runJobs } = createApp({
  dbFile,
  adminPassword,
  corsOrigins,
  baseUrl: process.env.BASE_URL || null,
  mailer: createMailer({ log: true }),
  stripeKey: process.env.STRIPE_SECRET_KEY || null,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
});

if (!adminPassword) {
  console.warn('ADMIN_PASSWORD is not set: the admin panel is disabled.');
}

// Background jobs: release expired holds, mark no-shows, settle split costs
const jobs = setInterval(() => {
  runJobs().catch(err => console.error('[jobs]', err));
}, JOB_INTERVAL_MS);
jobs.unref();

const server = app.listen(PORT, () => {
  console.log(`Rally Club running on http://localhost:${PORT}`);
  console.log('  App: /    Book: /book.html    Admin: /admin    Styleguide: /styleguide');
  console.log(`  Database: ${dbFile}`);
  console.log(payments.provider === 'stripe'
    ? '  Payments: Stripe'
    : `  Payments: demo mode (set STRIPE_SECRET_KEY for Stripe). Test card ${payments.TEST_CARD}`);
});

function shutdown() {
  clearInterval(jobs);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
