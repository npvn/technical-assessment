import { DateTime } from 'luxon';

// Strict parsing of the startTime the API takes (AC-17, ADR 002).
// Returns the exact instant, or null when the text isn't a full ISO 8601 date
// and time with an explicit offset.
//
// Luxon's fromISO alone is too forgiving for this: it takes a time with no
// offset (and reads it in the server's zone), a date with no time, and
// offsets like +25:00. So the shape is checked with a regex first, and Luxon
// only does the calendar part (is 30 February a real day).
//
// What it takes: YYYY-MM-DDTHH:mm, optional :ss, optional fraction after the
// seconds, then Z or +HH:mm / -HH:mm between -12:00 and +14:00. Upper case T
// and Z only, nothing before or after.
const SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;

export function parseInstant(text: string): Date | null {
  const match = SHAPE.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHours, offsetMinutes] =
    match;

  // A Date only holds milliseconds. Digits past that have to be zero, because
  // rounding them away could put an off-grid start back on the grid.
  const digits = (fraction ?? '').padEnd(9, '0');
  if (!/^0*$/.test(digits.slice(3))) return null;

  let offset = 0;
  if (sign) {
    const mm = Number(offsetMinutes);
    if (mm > 59) return null;
    offset = (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + mm);
    if (offset < MIN_OFFSET_MINUTES || offset > MAX_OFFSET_MINUTES) return null;
  }

  // Luxon rolls hour 24 over into the next day, so the clock fields are
  // checked here. Second 60 (a leap second) is refused too, a Date can't
  // hold it.
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? '0') > 59) return null;

  // Luxon refuses days that don't exist, like 30 February.
  const wall = DateTime.fromObject(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second ?? '0'),
      millisecond: Number(digits.slice(0, 3)),
    },
    { zone: 'utc' },
  );
  if (!wall.isValid) return null;

  // The wall time was read as if it were UTC, so take the offset off to get
  // the real instant.
  return wall.minus({ minutes: offset }).toJSDate();
}
