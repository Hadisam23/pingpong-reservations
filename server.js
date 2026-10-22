const path = require('path');
const { createApp } = require('./src/app');

const PORT = process.env.PORT || 3000;
const dbFile = process.env.DB_PATH || path.join(__dirname, 'data', 'pingpong.db');
const adminPassword = process.env.ADMIN_PASSWORD || null;

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const { app, db } = createApp({ dbFile, adminPassword, corsOrigins, baseUrl: process.env.BASE_URL || null });

if (!adminPassword) {
  console.warn('ADMIN_PASSWORD is not set: the admin panel is disabled.');
}

const server = app.listen(PORT, () => {
  console.log(`Ping pong reservations running on http://localhost:${PORT}`);
  console.log(`  Booking page: /    Manage booking: /manage    Admin: /admin`);
  console.log(`  Database: ${dbFile}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
