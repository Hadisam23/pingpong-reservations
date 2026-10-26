const { parseHHMM, isValidTimeZone } = require('./time');

// Opening hours are indexed by weekday: 0 = Sunday ... 6 = Saturday. null = closed.
const DEFAULT_SETTINGS = {
  centerName: 'Rally Club',
  timezone: 'Asia/Jerusalem',
  currency: 'ILS',
  slotMinutes: 30,
  durations: [30, 60, 90, 120],
  maxAdvanceDays: 14,
  minNoticeMinutes: 0,
  cancelCutoffMinutes: 1440,   // free cancellation (and refund) until 24 h before
  maxActiveBookingsPerPhone: 3,
  maxPlayersPerTable: 4,
  hours: [
    { open: '10:00', close: '23:00' },
    { open: '10:00', close: '23:00' },
    { open: '10:00', close: '23:00' },
    { open: '10:00', close: '23:00' },
    { open: '10:00', close: '23:00' },
    { open: '09:00', close: '16:00' },
    { open: '12:00', close: '23:00' },
  ],
  pricing: {
    offPeakPerHour: 40,
    peakPerHour: 60,
    peakStart: '17:00',
    peakDays: [5, 6],
  },
  // Kinds of reservation. extraPerHour is added on top of the table rate;
  // minDuration (optional) forces a longer booking, e.g. for parties.
  bookingTypes: [
    { id: 'casual', label: 'Casual play', extraPerHour: 0 },
    { id: 'training', label: 'Training with robot', extraPerHour: 30 },
    { id: 'coaching', label: 'Private coaching', extraPerHour: 120 },
    { id: 'league', label: 'League match', extraPerHour: 0 },
    { id: 'party', label: 'Birthday / event', extraPerHour: 50, minDuration: 120 },
  ],
};

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Returns an error message, or null when the settings are valid.
function validateSettings(s) {
  if (typeof s.centerName !== 'string' || !s.centerName.trim() || s.centerName.length > 80) {
    return 'centerName must be 1-80 characters';
  }
  if (typeof s.timezone !== 'string' || !isValidTimeZone(s.timezone)) return 'timezone is not a valid IANA time zone';
  if (typeof s.currency !== 'string' || !/^[A-Z]{3}$/.test(s.currency)) return 'currency must be a 3-letter code';
  if (![15, 30, 60].includes(s.slotMinutes)) return 'slotMinutes must be 15, 30 or 60';
  if (!Array.isArray(s.durations) || s.durations.length === 0) return 'durations must be a non-empty list';
  for (const d of s.durations) {
    if (!isInt(d, 1, 480) || d % s.slotMinutes !== 0) return 'each duration must be a multiple of slotMinutes, up to 480';
  }
  if (!isInt(s.maxAdvanceDays, 0, 365)) return 'maxAdvanceDays must be 0-365';
  if (!isInt(s.minNoticeMinutes, 0, 1440)) return 'minNoticeMinutes must be 0-1440';
  if (!isInt(s.cancelCutoffMinutes, 0, 10080)) return 'cancelCutoffMinutes must be 0-10080';
  if (!isInt(s.maxActiveBookingsPerPhone, 1, 100)) return 'maxActiveBookingsPerPhone must be 1-100';
  if (!isInt(s.maxPlayersPerTable, 1, 8)) return 'maxPlayersPerTable must be 1-8';

  if (!Array.isArray(s.hours) || s.hours.length !== 7) return 'hours must have 7 entries (Sunday first)';
  for (const day of s.hours) {
    if (day === null) continue;
    const open = parseHHMM(day && day.open);
    const close = parseHHMM(day && day.close);
    if (open === null || close === null || open >= close) return 'each day needs open < close (HH:MM), or null for closed';
    if (open % s.slotMinutes !== 0 || close % s.slotMinutes !== 0) return 'opening hours must line up with slotMinutes';
  }

  const p = s.pricing;
  if (!p || typeof p !== 'object') return 'pricing is required';
  if (typeof p.offPeakPerHour !== 'number' || p.offPeakPerHour < 0) return 'offPeakPerHour must be >= 0';
  if (typeof p.peakPerHour !== 'number' || p.peakPerHour < 0) return 'peakPerHour must be >= 0';
  if (p.peakStart !== null && parseHHMM(p.peakStart) === null) return 'peakStart must be HH:MM or null';
  if (!Array.isArray(p.peakDays) || !p.peakDays.every(d => isInt(d, 0, 6))) return 'peakDays must be weekday numbers 0-6';

  if (!Array.isArray(s.bookingTypes) || s.bookingTypes.length === 0) return 'bookingTypes must be a non-empty list';
  const ids = new Set();
  for (const t of s.bookingTypes) {
    if (!t || typeof t.id !== 'string' || !/^[a-z0-9_-]{1,30}$/.test(t.id)) return 'each booking type needs an id (a-z, 0-9, - or _)';
    if (ids.has(t.id)) return `duplicate booking type id: ${t.id}`;
    ids.add(t.id);
    if (typeof t.label !== 'string' || !t.label.trim() || t.label.length > 40) return 'each booking type needs a label (1-40 characters)';
    if (typeof t.extraPerHour !== 'number' || t.extraPerHour < 0) return 'booking type extraPerHour must be >= 0';
    if (t.minDuration !== undefined && t.minDuration !== null && (!isInt(t.minDuration, 1, 480) || t.minDuration % s.slotMinutes !== 0)) {
      return 'booking type minDuration must be a multiple of slotMinutes';
    }
  }
  return null;
}

module.exports = { DEFAULT_SETTINGS, validateSettings };
