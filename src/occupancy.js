// What keeps a table busy on a day: confirmed and checked-in bookings, holds that haven't
// expired, maintenance blocks and class sessions. Every booking path (website, app, front
// desk, lessons) asks this one module, so they can never disagree about a free table.
const { nowIn, addDays, zonedToUtc } = require('./time');

// SQL for "this booking still occupies its table" (needs the @now parameter)
const OCCUPYING = "(status IN ('confirmed', 'checked_in') OR (status = 'held' AND holdExpiresAt > @now))";

function createOccupancy(db, { now = () => new Date(), timezone }) {
  const stmts = {
    bookings: db.prepare(`SELECT id, tableId, startMin, endMin FROM bookings
      WHERE date = @date AND tableId IS NOT NULL AND ${OCCUPYING}`),
    blocks: db.prepare('SELECT tableId, startMin, endMin FROM blocks WHERE date = ?'),
    classes: db.prepare('SELECT id, tableIds, startsAt, endsAt FROM class_sessions WHERE startsAt < ? AND endsAt > ?'),
    tables: db.prepare('SELECT id FROM tables'),
  };

  // Class sessions are stored in UTC; turn them into club-time minutes on `date`.
  function classesOn(date) {
    const tz = timezone();
    const from = zonedToUtc(date, 0, tz);
    const to = zonedToUtc(addDays(date, 1), 0, tz);
    return stmts.classes.all(to, from).map(c => {
      const s = nowIn(tz, new Date(c.startsAt));
      const e = nowIn(tz, new Date(c.endsAt));
      return {
        classSessionId: c.id,
        tableIds: JSON.parse(c.tableIds),
        start: s.date < date ? 0 : s.minutes,
        end: e.date > date ? 1440 : e.minutes,
      };
    });
  }

  // { tableId: [{ start, end, kind }] } for every table, sorted by start.
  // excludeBookingId leaves one booking out (a hold checking itself, a reschedule).
  function busyOn(date, { excludeBookingId = null } = {}) {
    const busy = new Map(stmts.tables.all().map(t => [t.id, []]));
    const add = (tableId, start, end, kind) => { if (busy.has(tableId)) busy.get(tableId).push({ start, end, kind }); };
    for (const b of stmts.bookings.all({ date, now: now().toISOString() })) {
      if (b.id !== excludeBookingId) add(b.tableId, b.startMin, b.endMin, 'booking');
    }
    for (const b of stmts.blocks.all(date)) {
      if (b.tableId === null) for (const id of busy.keys()) add(id, b.startMin, b.endMin, 'block');
      else add(b.tableId, b.startMin, b.endMin, 'block');
    }
    for (const c of classesOn(date)) for (const id of c.tableIds) add(id, c.start, c.end, 'class');
    for (const list of busy.values()) list.sort((a, b) => a.start - b.start);
    return busy;
  }

  // The first thing in the way of [start, end) on a table, or null when it's free.
  function conflict(tableId, date, start, end, opts) {
    return (busyOn(date, opts).get(tableId) || []).find(i => i.start < end && i.end > start) || null;
  }

  return { busyOn, conflict, classesOn };
}

module.exports = { createOccupancy, OCCUPYING };
