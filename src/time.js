// All booking times are stored as a local date (YYYY-MM-DD) plus minutes from
// midnight, in the center's time zone. These helpers convert between forms.

function parseHHMM(value) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(value ?? ''));
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

function formatHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// 0 = Sunday ... 6 = Saturday
function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayDiff(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// Current local date and minutes-from-midnight in the given IANA time zone.
function nowIn(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// Minutes from "now" until a local date + minute. Negative when in the past.
function minutesUntil(date, startMin, now) {
  return dayDiff(now.date, date) * 1440 + startMin - now.minutes;
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// A local date + minutes-from-midnight in a time zone → the UTC instant (ISO string).
// Handles daylight-saving offsets by checking the zone's offset at the guessed instant.
function zonedToUtc(date, minutes, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const offsetAt = instant => {
    const local = nowIn(timeZone, new Date(instant));
    const [ly, lm, ld] = local.date.split('-').map(Number);
    return Date.UTC(ly, lm - 1, ld) + local.minutes * 60000 - instant;
  };
  let utc = wanted - offsetAt(wanted);
  utc = wanted - offsetAt(utc);
  return new Date(utc).toISOString();
}

module.exports = { parseHHMM, formatHHMM, isValidDate, weekday, addDays, dayDiff, nowIn, minutesUntil, isValidTimeZone, zonedToUtc };
