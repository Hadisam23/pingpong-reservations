const express = require('express');
const path = require('path');
const { openDb } = require('./db');
const { createService, ApiError, safeEqual } = require('./service');

function createApp({ dbFile = ':memory:', adminPassword = null, baseUrl = null, now } = {}) {
  const db = openDb(dbFile);
  const service = createService(db, { now });
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));

  const publicUrl = req => baseUrl || `${req.protocol}://${req.get('host')}`;
  const manageUrl = (req, code, token) => `${publicUrl(req)}/manage?code=${code}&t=${encodeURIComponent(token)}`;

  // ---------- public API ----------

  const api = express.Router();

  api.get('/config', (req, res) => {
    const s = service.getSettings();
    res.json({
      centerName: s.centerName,
      timezone: s.timezone,
      currency: s.currency,
      slotMinutes: s.slotMinutes,
      durations: s.durations,
      maxAdvanceDays: s.maxAdvanceDays,
      cancelCutoffMinutes: s.cancelCutoffMinutes,
      maxPlayersPerTable: s.maxPlayersPerTable,
      hours: s.hours,
      pricing: s.pricing,
      today: service.today().date,
    });
  });

  api.get('/availability', (req, res) => {
    res.json(service.getAvailability(req.query.date));
  });

  api.post('/bookings', (req, res) => {
    const { booking, manageToken } = service.createBooking(req.body);
    res.status(201).json({ booking, manageToken, manageUrl: manageUrl(req, booking.code, manageToken) });
  });

  api.get('/bookings/:code', (req, res) => {
    res.json(service.getBookingForCustomer(req.params.code, { token: req.query.token, phone: req.query.phone }));
  });

  api.post('/bookings/:code/cancel', (req, res) => {
    res.json(service.cancelByCustomer(req.params.code, { token: req.body.token, phone: req.body.phone }));
  });

  // ---------- admin API ----------

  const admin = express.Router();

  admin.use((req, res, next) => {
    if (!adminPassword) throw new ApiError(503, 'admin_disabled', 'Set ADMIN_PASSWORD to enable the admin panel');
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m || !safeEqual(m[1], adminPassword)) throw new ApiError(401, 'unauthorized', 'Wrong admin password');
    next();
  });

  admin.get('/day', (req, res) => res.json(service.getDay(req.query.date || service.today().date)));

  admin.post('/bookings', (req, res) => {
    const { booking, manageToken } = service.createBooking(req.body, { admin: true });
    res.status(201).json({ booking, manageUrl: manageUrl(req, booking.code, manageToken) });
  });

  admin.patch('/bookings/:code', (req, res) => res.json(service.setBookingStatus(req.params.code, req.body.status)));

  admin.post('/blocks', (req, res) => res.status(201).json(service.addBlock(req.body)));

  admin.delete('/blocks/:id', (req, res) => {
    service.removeBlock(req.params.id);
    res.status(204).end();
  });

  admin.get('/settings', (req, res) => res.json(service.getSettings()));
  admin.put('/settings', (req, res) => res.json(service.updateSettings(req.body)));

  admin.get('/tables', (req, res) => res.json(service.listTables({ includeInactive: true })));
  admin.post('/tables', (req, res) => res.status(201).json(service.addTable(req.body.name)));
  admin.patch('/tables/:id', (req, res) => res.json(service.updateTable(req.params.id, req.body)));

  api.use('/admin', admin);
  app.use('/api', api);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // ---------- pages ----------

  const pub = path.join(__dirname, '..', 'public');
  app.get('/manage', (req, res) => res.sendFile(path.join(pub, 'manage.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
  app.use(express.static(pub));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint' } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
  });

  return { app, service, db };
}

module.exports = { createApp };
