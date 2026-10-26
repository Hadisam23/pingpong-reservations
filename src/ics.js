// A one-event iCalendar file (Add to calendar). Times are UTC.
const stamp = isoString => isoString.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const text = v => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => `\\${m}`);

function toIcs({ uid, start, end, now, title, location, description }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rally Club//Bookings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${text(title)}`, `LOCATION:${text(location)}`, `DESCRIPTION:${text(description)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${text(title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

module.exports = { toIcs };
