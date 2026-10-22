// Fills the database with realistic random demo data: 5 tables, a mix of
// booking types and statuses from a few days ago to a week ahead.
const crypto = require('crypto');
const { parseHHMM, weekday, addDays } = require('./time');

const FIRST_NAMES = ['Noa', 'Itay', 'Maya', 'Omer', 'Yael', 'Daniel', 'Shira', 'Amit', 'Tamar', 'Yosef', 'Lior', 'Adi',
  'Eitan', 'Roni', 'Hadi', 'Lina', 'Karim', 'Nadia', 'Alex', 'Sofia', 'Ben', 'Mika', 'Gal', 'Dana'];
const LAST_NAMES = ['Cohen', 'Levi', 'Mizrahi', 'Peretz', 'Biton', 'Friedman', 'Haddad', 'Khoury', 'Azoulay', 'Katz',
  'Shapiro', 'Ben-David', 'Mansour', 'Golan', 'Avraham'];

// How often each type shows up, and the durations it tends to use.
const TYPE_MIX = [
  { id: 'casual', weight: 50, durations: [30, 60, 60, 90] },
  { id: 'training', weight: 15, durations: [30, 60] },
  { id: 'coaching', weight: 12, durations: [60, 60, 90] },
  { id: 'league', weight: 13, durations: [90, 120] },
  { id: 'party', weight: 10, durations: [120] },
];

// Small seeded PRNG (mulberry32) so a seed number reproduces the same data.
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedDemo(db, service, { seed = Date.now(), tableCount = 5, daysBack = 3, daysAhead = 7 } = {}) {
  const rng = createRng(seed);
  const pick = list => list[Math.floor(rng() * list.length)];
  const weighted = list => {
    let r = rng() * list.reduce((s, x) => s + x.weight, 0);
    return list.find(x => (r -= x.weight) < 0) || list[0];
  };

  const settings = service.getSettings();
  const today = service.today();
  const knownTypes = new Set(settings.bookingTypes.map(t => t.id));
  const mix = TYPE_MIX.filter(t => knownTypes.has(t.id));
  if (mix.length === 0) throw new Error('None of the demo booking types exist in settings');

  const tx = db.transaction(() => {
    db.exec('DELETE FROM bookings; DELETE FROM blocks;');

    // Exactly `tableCount` tables in service
    const tables = db.prepare('SELECT * FROM tables ORDER BY id').all();
    const insertTable = db.prepare('INSERT INTO tables (name) VALUES (?)');
    for (let i = tables.length; i < tableCount; i++) insertTable.run(`Table ${i + 1}`);
    db.prepare('UPDATE tables SET active = CASE WHEN id IN (SELECT id FROM tables ORDER BY id LIMIT ?) THEN 1 ELSE 0 END').run(tableCount);
    const active = db.prepare('SELECT * FROM tables WHERE active = 1 ORDER BY id').all();

    const insert = db.prepare(`INSERT INTO bookings
      (code, manageToken, tableId, date, startMin, endMin, name, phone, players, price, type, status, source, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const codes = new Set();
    const newCode = () => {
      let c;
      do { c = Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(rng() * 31)]).join(''); } while (codes.has(c));
      codes.add(c);
      return c;
    };

    let count = 0;
    for (let d = -daysBack; d <= daysAhead; d++) {
      const date = addDays(today.date, d);
      const hours = settings.hours[weekday(date)];
      if (!hours) continue;
      const open = parseHHMM(hours.open);
      const close = parseHHMM(hours.close);
      const busyDay = settings.pricing.peakDays.includes(weekday(date));

      for (const table of active) {
        let t = open;
        while (t < close) {
          // Evenings and peak days fill up more.
          const evening = t >= 17 * 60;
          const chance = (busyDay ? 0.4 : 0.22) + (evening ? 0.25 : 0);
          if (rng() > chance) { t += settings.slotMinutes; continue; }

          const type = weighted(mix);
          const typeSettings = settings.bookingTypes.find(x => x.id === type.id);
          let duration = pick(type.durations);
          if (typeSettings.minDuration) duration = Math.max(duration, typeSettings.minDuration);
          if (t + duration > close) { t += settings.slotMinutes; continue; }

          const end = t + duration;
          const isPast = d < 0 || (d === 0 && end <= today.minutes);
          const r = rng();
          let status = 'confirmed';
          if (isPast) status = r < 0.8 ? 'checked_in' : r < 0.9 ? 'no_show' : 'cancelled';
          else if (r < 0.08) status = 'cancelled';
          else if (d === 0 && t <= today.minutes) status = 'checked_in';

          const name = type.id === 'league' ? `${pick(LAST_NAMES)} vs ${pick(LAST_NAMES)}`
            : type.id === 'party' ? `${pick(FIRST_NAMES)}'s birthday`
              : `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
          const players = type.id === 'coaching' ? 1 + (rng() < 0.3 ? 1 : 0)
            : type.id === 'party' ? settings.maxPlayersPerTable
              : 2 + (rng() < 0.35 ? 2 : 0);
          const fromDesk = rng() < 0.2;
          const phone = fromDesk && rng() < 0.5 ? null : `05${Math.floor(rng() * 10)}${String(Math.floor(rng() * 1e7)).padStart(7, '0')}`;
          const createdAt = new Date(Date.now() - Math.floor(rng() * 7 * 86400000)).toISOString();

          insert.run(newCode(), crypto.randomBytes(24).toString('base64url'), table.id, date, t, end,
            name, phone, Math.min(players, settings.maxPlayersPerTable), service.quote(date, t, end, type.id),
            type.id, status, fromDesk ? 'desk' : 'online', createdAt, createdAt);
          count++;
          t = end;
        }
      }
    }

    // One maintenance block on the last table, two days out
    const blockDate = addDays(today.date, 2);
    const blockHours = settings.hours[weekday(blockDate)];
    if (blockHours && active.length) {
      const last = active[active.length - 1];
      const start = parseHHMM(blockHours.open);
      db.prepare(`DELETE FROM bookings WHERE tableId = ? AND date = ? AND startMin < ? AND endMin > ?`)
        .run(last.id, blockDate, start + 180, start);
      db.prepare('INSERT INTO blocks (tableId, date, startMin, endMin, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(last.id, blockDate, start, start + 180, 'Maintenance: new rubber & net', new Date().toISOString());
    }
    return { tables: active.length, bookings: db.prepare('SELECT COUNT(*) AS c FROM bookings').get().c, generated: count };
  });

  return tx.immediate();
}

module.exports = { seedDemo, createRng };
