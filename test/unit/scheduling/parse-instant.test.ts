import fc from 'fast-check';
import { parseInstant } from '../../../src/scheduling/index.js';

// parseInstant is the strict reader behind the startTime field (ADR 002).
// Luxon's fromISO on its own is too forgiving here: it takes a time with no
// offset (and reads it in the server's zone), a date with no time, and an
// offset like +25:00. Each of those has a row below.

describe('parseInstant', () => {
  describe('AC-17 refuses anything that is not a full date and time with an offset', () => {
    it.each([
      ['no offset', '2027-03-09T09:00:00'],
      ['date only', '2027-03-09'],
      ['an impossible date', '2027-02-30T09:00:00Z'],
      ['an offset past +14:00', '2027-03-09T09:00:00+25:00'],
      ['an offset just past +14:00', '2027-03-09T09:00:00+14:30'],
      ['a space instead of T', '2027-03-09 09:00:00Z'],
      ['not a date at all', 'tomorrow'],
    ])('AC-17 %s (%s)', (_label, text) => {
      expect(parseInstant(text)).toBeNull();
    });
  });

  it('AC-17 takes a time with no seconds, same as with :00', () => {
    expect(parseInstant('2027-03-09T09:00Z')).toEqual(new Date('2027-03-09T09:00:00.000Z'));
  });

  describe('accepts exact instants and keeps every part of them', () => {
    it.each([
      ['UTC with Z', '2027-03-09T09:00:00Z', '2027-03-09T09:00:00.000Z'],
      ['a positive offset', '2027-03-09T10:00:00+01:00', '2027-03-09T09:00:00.000Z'],
      ['a negative offset', '2027-03-09T04:00:00-05:00', '2027-03-09T09:00:00.000Z'],
      ['a zero offset written out', '2027-03-09T09:00:00+00:00', '2027-03-09T09:00:00.000Z'],
      ['a 45 minute offset', '2027-03-09T14:45:00+05:45', '2027-03-09T09:00:00.000Z'],
      ['the lowest offset, -12:00', '2027-03-09T21:00:00-12:00', '2027-03-10T09:00:00.000Z'],
      ['the highest offset, +14:00', '2027-03-09T23:00:00+14:00', '2027-03-09T09:00:00.000Z'],
      [
        'a local date that is a day after the UTC one',
        '2027-03-08T08:00:00+11:00',
        '2027-03-07T21:00:00.000Z',
      ],
      ['29 February in a leap year', '2028-02-29T09:00:00Z', '2028-02-29T09:00:00.000Z'],
      ['one fraction digit', '2027-03-09T09:00:00.5Z', '2027-03-09T09:00:00.500Z'],
      ['six zero fraction digits', '2027-03-09T09:00:00.000000Z', '2027-03-09T09:00:00.000Z'],
    ])('%s (%s)', (_label, text, iso) => {
      expect(parseInstant(text)).toEqual(new Date(iso));
    });

    // AC-15 needs these to reach the grid rule as they are, so 09:00:30 and
    // 09:00:00.001 get 422 START_NOT_ON_GRID and not a 400 or a silent round.
    it('AC-15 keeps the seconds', () => {
      expect(parseInstant('2027-03-09T09:00:30Z')).toEqual(new Date('2027-03-09T09:00:30.000Z'));
    });

    it('AC-15 keeps the milliseconds', () => {
      expect(parseInstant('2027-03-09T09:00:00.001Z')).toEqual(
        new Date('2027-03-09T09:00:00.001Z'),
      );
    });
  });

  describe('refuses the near misses too', () => {
    it.each([
      ['29 February in a year that is not a leap year', '2027-02-29T09:00:00Z'],
      ['31 April', '2027-04-31T09:00:00Z'],
      ['month 13', '2027-13-01T09:00:00Z'],
      ['day 0', '2027-03-00T09:00:00Z'],
      ['hour 24', '2027-03-09T24:00:00Z'],
      ['minute 60', '2027-03-09T09:60:00Z'],
      // A Date can't hold a leap second, so it would turn into the next minute
      ['second 60', '2027-03-09T09:00:60Z'],
      ['an offset just below -12:00', '2027-03-09T09:00:00-12:30'],
      ['offset minutes of 60', '2027-03-09T09:00:00+01:60'],
      ['an offset with no colon', '2027-03-09T09:00:00+0100'],
      ['an offset with hours only', '2027-03-09T09:00:00+01'],
      ['the hour only', '2027-03-09T09Z'],
      ['lower case t and z', '2027-03-09t09:00:00z'],
      ['a month and day with one digit', '2027-3-9T09:00:00Z'],
      ['a year with more than 4 digits', '+002027-03-09T09:00:00Z'],
      ['a dot with no fraction digits', '2027-03-09T09:00:00.Z'],
      ['a comma before the fraction', '2027-03-09T09:00:00,5Z'],
      // A Date only holds milliseconds. Rounding this one away would put it
      // back on the grid, so it is refused instead.
      ['a fraction finer than a millisecond', '2027-03-09T09:00:00.0001Z'],
      ['a space in front', ' 2027-03-09T09:00:00Z'],
      ['a new line at the end', '2027-03-09T09:00:00Z\n'],
      ['the empty string', ''],
    ])('%s (%j)', (_label, text) => {
      expect(parseInstant(text)).toBeNull();
    });
  });

  // Any instant written as UTC, or with any whole-minute offset in range,
  // reads back as the same instant.
  it('reads back any instant, whatever offset it is written with', () => {
    const instant = fc.date({
      min: new Date('2000-01-01T00:00:00Z'),
      max: new Date('2099-12-31T23:59:59Z'),
      noInvalidDate: true,
    });
    const offsetMinutes = fc.integer({ min: -12 * 60, max: 14 * 60 });

    fc.assert(
      fc.property(instant, offsetMinutes, (date, offset) => {
        expect(parseInstant(date.toISOString())).toEqual(date);
        expect(parseInstant(withOffset(date, offset))).toEqual(date);
      }),
    );
  });
});

// Writes the instant as local wall time at the given offset, for example
// 2027-03-09T10:00:00.000+01:00. Built by hand so the test doesn't share code
// with what it checks.
function withOffset(date: Date, offsetMinutes: number): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const wall = local.toISOString().slice(0, -1);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${wall}${sign}${hh}:${mm}`;
}
