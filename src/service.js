const crypto = require('crypto');
const { DEFAULT_SETTINGS, validateSettings } = require('./settings');
const { parseHHMM, formatHHMM, isValidDate, weekday, addDays, nowIn, minutesUntil } = require('./time');
const { createOccupancy } = require('./occupancy');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const STATUSES = ['confirmed', 'checked_in', 'no_show', 'cancelled'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

// Keeps a leading "+" and digits only. Returns null if it doesn't look like a phone number.
function normalizePhone(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const digits = raw.replace(/\D/g, '');
  if (!/^\+?[\d\s\-().]+$/.test(raw) || digits.length < 9 || digits.length > 15) return null;
  return (raw.startsWith('+') ? '+' : '') + digits;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createService(db, { now = () => new Date() } = {}) {
  const stmts = {
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

    allTables: db.prepare('SELECT * FROM tables ORDER BY id'),
    activeTables: db.prepare('SELECT * FROM tables WHERE active = 1 ORDER BY id'),
    getTable: db.prepare('SELECT * FROM tables WHERE id = ?'),
    insertTable: db.prepare('INSERT INTO tables (name) VALUES (?)'),
    updateTable: db.prepare('UPDATE tables SET name = ?, active = ? WHERE id = ?'),
    upcomingOnTable: db.prepare(`SELECT COUNT(*) AS count FROM bookings
      WHERE tableId = ? AND status = 'confirmed' AND (date > ? OR (date = ? AND endMin > ?))`),

    bookingsOnDate: db.prepare(`SELECT b.*, t.name AS tableName FROM bookings b JOIN tables t ON t.id = b.tableId
      WHERE b.date = ? AND b.status NOT IN ('held', 'expired') ORDER BY b.startMin, b.tableId`),
    blocksOnDate: db.prepare('SELECT * FROM blocks WHERE date = ? ORDER BY startMin'),
    upcomingForPhone: db.prepare(`SELECT COUNT(*) AS count FROM bookings
      WHERE phone = ? AND status = 'confirmed' AND (date > ? OR (date = ? AND endMin > ?))`),
    insertBooking: db.prepare(`INSERT INTO bookings
      (code, manageToken, tableId, date, startMin, endMin, name, phone, players, price, type, status, source, createdAt, updatedAt)
      VALUES (@code, @manageToken, @tableId, @date, @startMin, @endMin, @name, @phone, @players, @price, @type, 'confirmed', @source, @now, @now)`),
    codeExists: db.prepare('SELECT 1 FROM bookings WHERE code = ?'),
    getBooking: db.prepare('SELECT b.*, t.name AS tableName FROM bookings b LEFT JOIN tables t ON t.id = b.tableId WHERE b.code = ?'),
    setStatus: db.prepare('UPDATE bookings SET status = ?, updatedAt = ? WHERE code = ?'),

    insertBlock: db.prepare('INSERT INTO blocks (tableId, date, startMin, endMin, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)'),
    deleteBlock: db.prepare('DELETE FROM blocks WHERE id = ?'),
    conflictsForBlock: db.prepare(`SELECT b.code, b.name, b.startMin, b.endMin, t.name AS tableName FROM bookings b
      JOIN tables t ON t.id = b.tableId
      WHERE b.date = ? AND b.status IN ('confirmed', 'checked_in') AND b.startMin < ? AND b.endMin > ?
        AND (? IS NULL OR b.tableId = ?)`),
  };

  const occupancy = createOccupancy(db, { now, timezone: () => getSettings().timezone });
  const closureOn = db.prepare('SELECT reason FROM closures WHERE date = ?');

  // Opening hours on a date, or null when closed (weekly hours or a holiday closure)
  function hoursOn(date, settings = getSettings()) {
    if (closureOn.get(date)) return null;
    return settings.hours[weekday(date)];
  }

  // ---------- settings ----------

  function getSettings() {
    const row = stmts.getSetting.get('config');
    const saved = row ? JSON.parse(row.value) : {};
    return { ...DEFAULT_SETTINGS, ...saved, pricing: { ...DEFAULT_SETTINGS.pricing, ...saved.pricing } };
  }

  function updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ApiError(400, 'invalid_settings', 'Settings must be an object');
    }
    const current = getSettings();
    const next = { ...current, ...patch, pricing: { ...current.pricing, ...(patch.pricing || {}) } };
    for (const key of Object.keys(next)) {
      if (!(key in DEFAULT_SETTINGS)) delete next[key];
    }
    const error = validateSettings(next);
    if (error) throw new ApiError(400, 'invalid_settings', error);
    stmts.putSetting.run('config', JSON.stringify(next));
    return next;
  }

  function localNow(settings) {
    return nowIn(settings.timezone, now());
  }

  // ---------- pricing ----------

  function isPeak(settings, date, startMin) {
    const p = settings.pricing;
    if (p.peakDays.includes(weekday(date))) return true;
    return p.peakStart !== null && startMin >= parseHHMM(p.peakStart);
  }

  function slotPrice(settings, date, startMin) {
    const rate = isPeak(settings, date, startMin) ? settings.pricing.peakPerHour : settings.pricing.offPeakPerHour;
    return rate * settings.slotMinutes / 60;
  }

  function findType(settings, id) {
    return settings.bookingTypes.find(t => t.id === id) || null;
  }

  function priceFor(settings, date, startMin, endMin, typeId) {
    let total = 0;
    for (let t = startMin; t < endMin; t += settings.slotMinutes) total += slotPrice(settings, date, t);
    const type = findType(settings, typeId);
    if (type) total += type.extraPerHour * (endMin - startMin) / 60;
    return Math.round(total * 100) / 100;
  }

  // ---------- tables ----------

  function formatTable(t) {
    return { id: t.id, name: t.name, active: !!t.active };
  }

  function listTables({ includeInactive = false } = {}) {
    return (includeInactive ? stmts.allTables : stmts.activeTables).all().map(formatTable);
  }

  function cleanTableName(name) {
    const clean = String(name ?? '').trim();
    if (clean.length < 1 || clean.length > 40) throw new ApiError(400, 'invalid_name', 'Table name must be 1-40 characters');
    return clean;
  }

  function addTable(name) {
    const { lastInsertRowid } = stmts.insertTable.run(cleanTableName(name));
    return formatTable(stmts.getTable.get(lastInsertRowid));
  }

  function updateTable(id, { name, active } = {}) {
    const table = stmts.getTable.get(Number(id));
    if (!table) throw new ApiError(404, 'table_not_found', 'Table not found');
    const nextName = name === undefined ? table.name : cleanTableName(name);
    const nextActive = active === undefined ? !!table.active : !!active;
    if (table.active && !nextActive) {
      const n = localNow(getSettings());
      const { count } = stmts.upcomingOnTable.get(table.id, n.date, n.date, n.minutes);
      if (count > 0) {
        throw new ApiError(409, 'table_has_bookings', `This table still has ${count} upcoming booking(s). Move or cancel them first.`);
      }
    }
    stmts.updateTable.run(nextName, nextActive ? 1 : 0, table.id);
    return formatTable(stmts.getTable.get(table.id));
  }

  // ---------- availability ----------

  function requireDate(date) {
    if (!isValidDate(date)) throw new ApiError(400, 'invalid_date', 'Date must be YYYY-MM-DD');
  }

  function getAvailability(date) {
    requireDate(date);
    const settings = getSettings();
    const today = localNow(settings);
    const lastDay = addDays(today.date, settings.maxAdvanceDays);
    if (date < today.date || date > lastDay) {
      throw new ApiError(400, 'out_of_range', `Bookings are open from ${today.date} to ${lastDay}`);
    }

    const tables = listTables();
    const hours = hoursOn(date, settings);
    if (!hours) {
      return { date, closed: true, slotMinutes: settings.slotMinutes, slots: [], tables: tables.map(t => ({ ...t, busy: [] })) };
    }

    const open = parseHHMM(hours.open);
    const close = parseHHMM(hours.close);
    const earliest = date === today.date ? today.minutes + settings.minNoticeMinutes : -1;
    const slots = [];
    for (let t = open; t + settings.slotMinutes <= close; t += settings.slotMinutes) {
      slots.push({
        start: t,
        time: formatHHMM(t),
        peak: isPeak(settings, date, t),
        price: slotPrice(settings, date, t),
        past: t < earliest,
      });
    }

    const busy = occupancy.busyOn(date);
    return {
      date,
      closed: false,
      open: hours.open,
      close: hours.close,
      slotMinutes: settings.slotMinutes,
      slots,
      // Only time ranges are public: never names or phone numbers.
      tables: tables.map(t => ({ ...t, busy: (busy.get(t.id) || []).map(b => ({ start: b.start, end: b.end })) })),
    };
  }

  // ---------- bookings ----------

  function formatBooking(row, settings) {
    const type = findType(settings, row.type);
    return {
      code: row.code,
      type: row.type,
      typeLabel: type ? type.label : row.type,
      table: { id: row.tableId, name: row.tableName || null },
      date: row.date,
      start: formatHHMM(row.startMin),
      end: formatHHMM(row.endMin),
      duration: row.endMin - row.startMin,
      name: row.name,
      phone: row.phone,
      players: row.players,
      price: row.price,
      currency: settings.currency,
      status: row.status,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // admin = true is a front-desk booking: skips the advance window, notice and
  // per-phone limits and makes the phone optional. Overlap rules always apply.
  function createBooking(input = {}, { admin = false } = {}) {
    const settings = getSettings();
    const today = localNow(settings);

    const table = stmts.getTable.get(Number(input.tableId));
    if (!table || !table.active) throw new ApiError(400, 'invalid_table', 'Pick a valid table');

    const { date } = input;
    requireDate(date);
    if (date < today.date) throw new ApiError(400, 'in_past', 'That date has already passed');
    if (!admin && date > addDays(today.date, settings.maxAdvanceDays)) {
      throw new ApiError(400, 'too_far_ahead', `You can book up to ${settings.maxAdvanceDays} days ahead`);
    }

    const hours = hoursOn(date, settings);
    if (!hours) throw new ApiError(400, 'closed', 'The center is closed that day');
    const open = parseHHMM(hours.open);
    const close = parseHHMM(hours.close);

    const startMin = parseHHMM(input.start);
    if (startMin === null || startMin % settings.slotMinutes !== 0) {
      throw new ApiError(400, 'invalid_time', `Start time must be on a ${settings.slotMinutes}-minute slot`);
    }
    const duration = Number(input.duration);
    const durationOk = admin
      ? Number.isInteger(duration) && duration > 0 && duration % settings.slotMinutes === 0
      : settings.durations.includes(duration);
    if (!durationOk) throw new ApiError(400, 'invalid_duration', `Duration must be one of: ${settings.durations.join(', ')} minutes`);
    const endMin = startMin + duration;
    if (startMin < open || endMin > close) {
      throw new ApiError(400, 'outside_hours', `Open ${hours.open}–${hours.close} that day`);
    }
    if (date === today.date) {
      const tooEarly = admin ? endMin <= today.minutes : startMin < today.minutes + settings.minNoticeMinutes;
      if (tooEarly) throw new ApiError(400, 'in_past', 'That time has already passed');
    }

    const type = findType(settings, input.type === undefined || input.type === null || input.type === '' ? settings.bookingTypes[0].id : input.type);
    if (!type) throw new ApiError(400, 'invalid_type', `Type must be one of: ${settings.bookingTypes.map(t => t.id).join(', ')}`);
    if (type.minDuration && duration < type.minDuration) {
      throw new ApiError(400, 'too_short_for_type', `${type.label} needs at least ${type.minDuration} minutes`);
    }

    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 60) throw new ApiError(400, 'invalid_name', 'Please enter your name (2-60 characters)');

    const phone = normalizePhone(input.phone);
    const phoneGiven = input.phone !== undefined && input.phone !== null && input.phone !== '';
    if ((phoneGiven && !phone) || (!admin && !phone)) {
      throw new ApiError(400, 'invalid_phone', 'Please enter a valid phone number');
    }

    const players = input.players === undefined || input.players === null || input.players === '' ? 2 : Number(input.players);
    if (!Number.isInteger(players) || players < 1 || players > settings.maxPlayersPerTable) {
      throw new ApiError(400, 'invalid_players', `Players must be 1-${settings.maxPlayersPerTable}`);
    }

    const price = priceFor(settings, date, startMin, endMin, type.id);

    const insert = db.transaction(() => {
      const clash = occupancy.conflict(table.id, date, startMin, endMin);
      if (clash && clash.kind === 'booking') {
        throw new ApiError(409, 'slot_taken', 'Sorry, that time was just taken. Please pick another slot.');
      }
      if (clash) throw new ApiError(409, 'slot_blocked', 'That table is not available at that time');
      if (!admin) {
        const { count } = stmts.upcomingForPhone.get(phone, today.date, today.date, today.minutes);
        if (count >= settings.maxActiveBookingsPerPhone) {
          throw new ApiError(409, 'booking_limit', `You already have ${count} upcoming bookings. Cancel one to book another.`);
        }
      }
      let code;
      do { code = randomCode(); } while (stmts.codeExists.get(code));
      const manageToken = crypto.randomBytes(24).toString('base64url');
      stmts.insertBooking.run({
        code, manageToken, tableId: table.id, date, startMin, endMin, name, phone, players, price, type: type.id,
        source: admin ? 'desk' : 'online', now: now().toISOString(),
      });
      return { code, manageToken };
    });

    // IMMEDIATE takes the write lock before the overlap check, so the check and
    // the insert are atomic even with several server processes on one DB file.
    const { code, manageToken } = insert.immediate();
    return { booking: formatBooking(stmts.getBooking.get(code), settings), manageToken };
  }

  function findForCustomer(code, { token, phone } = {}) {
    const row = stmts.getBooking.get(String(code ?? '').trim().toUpperCase());
    const tokenOk = row && token && safeEqual(token, row.manageToken);
    const normalized = normalizePhone(phone);
    const phoneOk = row && normalized && row.phone && safeEqual(normalized, row.phone);
    // Same error whether the code is unknown or the credentials are wrong.
    if (!tokenOk && !phoneOk) throw new ApiError(404, 'booking_not_found', 'No booking found with those details');
    return row;
  }

  function customerView(row, settings) {
    const today = localNow(settings);
    const until = minutesUntil(row.date, row.startMin, today);
    return {
      ...formatBooking(row, settings),
      canCancel: row.status === 'confirmed' && until >= settings.cancelCutoffMinutes,
      cancelCutoffMinutes: settings.cancelCutoffMinutes,
    };
  }

  function getBookingForCustomer(code, credentials) {
    const settings = getSettings();
    return customerView(findForCustomer(code, credentials), settings);
  }

  function cancelByCustomer(code, credentials) {
    const settings = getSettings();
    const row = findForCustomer(code, credentials);
    if (row.status !== 'confirmed') throw new ApiError(409, 'not_cancellable', `This booking is already ${row.status.replace('_', ' ')}`);
    const until = minutesUntil(row.date, row.startMin, localNow(settings));
    if (until < settings.cancelCutoffMinutes) {
      throw new ApiError(409, 'too_late_to_cancel',
        `Bookings can only be cancelled online up to ${settings.cancelCutoffMinutes} minutes before the start. Please call the center.`);
    }
    stmts.setStatus.run('cancelled', now().toISOString(), row.code);
    return customerView(stmts.getBooking.get(row.code), settings);
  }

  // ---------- admin ----------

  function getDay(date) {
    requireDate(date);
    const settings = getSettings();
    const hours = settings.hours[weekday(date)];
    return {
      date,
      hours,
      slotMinutes: settings.slotMinutes,
      tables: listTables(),
      bookings: stmts.bookingsOnDate.all(date).map(r => formatBooking(r, settings)),
      blocks: stmts.blocksOnDate.all(date).map(b => ({
        id: b.id, tableId: b.tableId, start: formatHHMM(b.startMin), end: formatHHMM(b.endMin), reason: b.reason,
      })),
    };
  }

  function setBookingStatus(code, status) {
    if (!STATUSES.includes(status)) throw new ApiError(400, 'invalid_status', `Status must be one of: ${STATUSES.join(', ')}`);
    const settings = getSettings();
    const row = stmts.getBooking.get(String(code).toUpperCase());
    if (!row) throw new ApiError(404, 'booking_not_found', 'Booking not found');
    const reactivating = !['confirmed', 'checked_in'].includes(row.status) && ['confirmed', 'checked_in'].includes(status);

    db.transaction(() => {
      // Restoring a cancelled booking must not create a double booking.
      if (reactivating && row.tableId && occupancy.conflict(row.tableId, row.date, row.startMin, row.endMin, { excludeBookingId: row.id })) {
        throw new ApiError(409, 'slot_taken', 'That slot has been taken or blocked since this booking was cancelled');
      }
      stmts.setStatus.run(status, now().toISOString(), row.code);
    }).immediate();
    return formatBooking(stmts.getBooking.get(row.code), settings);
  }

  function addBlock({ tableId, date, start, end, reason } = {}) {
    requireDate(date);
    const tid = tableId === undefined || tableId === null || tableId === '' ? null : Number(tableId);
    if (tid !== null && !stmts.getTable.get(tid)) throw new ApiError(400, 'invalid_table', 'Table not found');
    const startMin = parseHHMM(start);
    const endMin = parseHHMM(end);
    if (startMin === null || endMin === null || startMin >= endMin) {
      throw new ApiError(400, 'invalid_time', 'Block needs a start before its end (HH:MM)');
    }
    const cleanReason = reason ? String(reason).trim().slice(0, 120) : null;
    const { lastInsertRowid } = stmts.insertBlock.run(tid, date, startMin, endMin, cleanReason, now().toISOString());
    const conflicts = stmts.conflictsForBlock.all(date, endMin, startMin, tid, tid).map(b => ({
      code: b.code, name: b.name, table: b.tableName, start: formatHHMM(b.startMin), end: formatHHMM(b.endMin),
    }));
    return { block: { id: lastInsertRowid, tableId: tid, date, start: formatHHMM(startMin), end: formatHHMM(endMin), reason: cleanReason }, conflicts };
  }

  function removeBlock(id) {
    const { changes } = stmts.deleteBlock.run(Number(id));
    if (!changes) throw new ApiError(404, 'block_not_found', 'Block not found');
  }

  return {
    getSettings, updateSettings,
    listTables, addTable, updateTable,
    getAvailability, createBooking, getBookingForCustomer, cancelByCustomer,
    getDay, setBookingStatus, addBlock, removeBlock,
    today: () => localNow(getSettings()),
    hoursOn,
    closure: date => closureOn.get(date) || null,
    occupancy,
    quote: (date, startMin, endMin, typeId) => priceFor(getSettings(), date, startMin, endMin, typeId),
  };
}

module.exports = { createService, ApiError, normalizePhone, safeEqual };
