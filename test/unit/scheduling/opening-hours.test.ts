import { fitsOpeningHours, rangeFromStart } from '../../../src/scheduling/index.js';
import {
  BERLIN,
  HARBOUR_HOURS,
  LONDON,
  NORTH_HOURS,
  OIL_MINUTES,
  RHINE_HOURS,
  SYDNEY,
  at,
  range,
} from './fixtures.js';

function oilAt(iso: string) {
  return rangeFromStart(at(iso), OIL_MINUTES);
}

describe('fitsOpeningHours', () => {
  it('AC-12 OIL Mon 8th at 16:30 fits, it ends exactly at closing', () => {
    expect(fitsOpeningHours(oilAt('2027-03-08T16:30:00Z'), LONDON, NORTH_HOURS)).toBe(true);
  });

  it('AC-12 OIL Mon 8th at 17:00 runs past closing', () => {
    expect(fitsOpeningHours(oilAt('2027-03-08T17:00:00Z'), LONDON, NORTH_HOURS)).toBe(false);
  });

  it('AC-12 OIL Mon 8th at 07:45 starts before opening', () => {
    expect(fitsOpeningHours(oilAt('2027-03-08T07:45:00Z'), LONDON, NORTH_HOURS)).toBe(false);
  });

  it('AC-12 OIL Mon 8th at 08:00 fits, it starts exactly at opening', () => {
    expect(fitsOpeningHours(oilAt('2027-03-08T08:00:00Z'), LONDON, NORTH_HOURS)).toBe(true);
  });

  it('AC-12 Sun 14th at 09:00 is refused, there is no Sunday window', () => {
    expect(fitsOpeningHours(oilAt('2027-03-14T09:00:00Z'), LONDON, NORTH_HOURS)).toBe(false);
  });

  it('AC-12 OIL Sat 13th at 12:30 ends 13:30, after Saturday closing', () => {
    expect(fitsOpeningHours(oilAt('2027-03-13T12:30:00Z'), LONDON, NORTH_HOURS)).toBe(false);
  });

  it('AC-12 OIL Sat 13th at 12:00 fits Saturday hours', () => {
    expect(fitsOpeningHours(oilAt('2027-03-13T12:00:00Z'), LONDON, NORTH_HOURS)).toBe(true);
  });

  it('AC-12 ending one millisecond past closing is refused', () => {
    const r = range('2027-03-08T16:30:00Z', '2027-03-08T17:30:00.001Z');
    expect(fitsOpeningHours(r, LONDON, NORTH_HOURS)).toBe(false);
  });

  it('accepts opening times written without seconds', () => {
    const hours = [{ isoWeekday: 1, opensAt: '08:00', closesAt: '17:30' }];
    expect(fitsOpeningHours(oilAt('2027-03-08T08:00:00Z'), LONDON, hours)).toBe(true);
    expect(fitsOpeningHours(oilAt('2027-03-08T16:30:00Z'), LONDON, hours)).toBe(true);
    expect(fitsOpeningHours(oilAt('2027-03-08T07:45:00Z'), LONDON, hours)).toBe(false);
    expect(
      fitsOpeningHours(range('2027-03-08T16:30:00Z', '2027-03-08T17:30:00.001Z'), LONDON, hours),
    ).toBe(false);
  });

  it('a range must end on the same local date it starts', () => {
    // Mon 09:00 to Tue 10:00. Both times of day are inside the weekday window,
    // but the job runs overnight.
    const r = range('2027-03-08T09:00:00Z', '2027-03-09T10:00:00Z');
    expect(fitsOpeningHours(r, LONDON, NORTH_HOURS)).toBe(false);
  });

  it('no windows at all means closed every day', () => {
    expect(fitsOpeningHours(oilAt('2027-03-09T09:00:00Z'), LONDON, [])).toBe(false);
  });

  it('AC-13 the weekday is Sydney local, not UTC', () => {
    // 2027-03-07T21:00Z is Sunday in UTC but Monday 08:00 in Sydney (+11:00).
    expect(fitsOpeningHours(oilAt('2027-03-07T21:00:00Z'), SYDNEY, HARBOUR_HOURS)).toBe(true);
    expect(fitsOpeningHours(oilAt('2027-03-08T08:00:00+11:00'), SYDNEY, HARBOUR_HOURS)).toBe(true);
  });

  it('AC-13 Sunday in Sydney is closed even when it is Saturday in UTC', () => {
    // 2027-03-06T22:00Z is Sunday 09:00 in Sydney.
    expect(fitsOpeningHours(oilAt('2027-03-06T22:00:00Z'), SYDNEY, HARBOUR_HOURS)).toBe(false);
  });

  it('AC-13 Berlin opening hours are Berlin local time', () => {
    // 08:30Z is 09:30 in Berlin, inside hours. 08:30+01:00 is 08:30 in Berlin, before opening.
    expect(fitsOpeningHours(oilAt('2027-03-09T08:30:00Z'), BERLIN, RHINE_HOURS)).toBe(true);
    expect(fitsOpeningHours(oilAt('2027-03-09T08:30:00+01:00'), BERLIN, RHINE_HOURS)).toBe(false);
  });

  it('AC-14 opening hours follow London local time in the spring-forward week', () => {
    // London is on BST from Sun 28 March 2027, so 08:00 local is 07:00Z.
    expect(fitsOpeningHours(oilAt('2027-03-29T08:00:00+01:00'), LONDON, NORTH_HOURS)).toBe(true);
    expect(fitsOpeningHours(oilAt('2027-03-29T07:30:00Z'), LONDON, NORTH_HOURS)).toBe(true);
    expect(fitsOpeningHours(oilAt('2027-03-29T06:30:00Z'), LONDON, NORTH_HOURS)).toBe(false);
    // 16:30 BST is 15:30Z and ends exactly at 17:30 BST. 16:30Z would be 17:30 BST.
    expect(fitsOpeningHours(oilAt('2027-03-29T15:30:00Z'), LONDON, NORTH_HOURS)).toBe(true);
    expect(fitsOpeningHours(oilAt('2027-03-29T16:30:00Z'), LONDON, NORTH_HOURS)).toBe(false);
  });

  it('throws on an unknown time zone, it is a data bug and not a booking answer', () => {
    expect(() =>
      fitsOpeningHours(oilAt('2027-03-09T09:00:00Z'), 'Mars/Nowhere', NORTH_HOURS),
    ).toThrow(/Mars\/Nowhere/);
  });

  // The tests below were added after mutation testing (PLAN step 10) showed
  // these cases had no test.

  it('opening and closing times with seconds are exact to the second', () => {
    // Postgres `time` can hold seconds, so 08:00:30 means 08:00:30 and not 08:00.
    const hours = [{ isoWeekday: 1, opensAt: '08:00:30', closesAt: '17:30:30' }];
    const fits = (startIso: string, endIso: string) =>
      fitsOpeningHours(range(startIso, endIso), LONDON, hours);
    expect(fits('2027-03-08T08:00:30Z', '2027-03-08T09:00:30Z')).toBe(true);
    expect(fits('2027-03-08T08:00:29Z', '2027-03-08T09:00:29Z')).toBe(false);
    expect(fits('2027-03-08T16:30:30Z', '2027-03-08T17:30:30Z')).toBe(true);
    expect(fits('2027-03-08T16:30:31Z', '2027-03-08T17:30:31Z')).toBe(false);
  });

  it('seconds in the range count against whole minute opening hours', () => {
    // One second short of 17:30 closing fits, 30 seconds past it doesn't.
    const early = range('2027-03-08T16:29:59Z', '2027-03-08T17:29:59Z');
    const late = range('2027-03-08T16:30:30Z', '2027-03-08T17:30:30Z');
    expect(fitsOpeningHours(early, LONDON, NORTH_HOURS)).toBe(true);
    expect(fitsOpeningHours(late, LONDON, NORTH_HOURS)).toBe(false);
  });

  it('throws on an opening or closing time that is not HH:MM or HH:MM:SS', () => {
    // The windows come from the database, so a bad one is a data bug and
    // throws, the same as an unknown zone.
    for (const bad of ['8:00', '108:00:00', '08:00:00x', '']) {
      const badOpening = [{ isoWeekday: 1, opensAt: bad, closesAt: '17:30:00' }];
      const badClosing = [{ isoWeekday: 1, opensAt: '08:00:00', closesAt: bad }];
      expect(() => fitsOpeningHours(oilAt('2027-03-08T09:00:00Z'), LONDON, badOpening)).toThrow(
        /Bad opening time/,
      );
      expect(() => fitsOpeningHours(oilAt('2027-03-08T09:00:00Z'), LONDON, badClosing)).toThrow(
        /Bad opening time/,
      );
    }
  });
});
