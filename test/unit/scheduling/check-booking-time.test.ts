import { checkBookingTime, type BookingTimeInput } from '../../../src/scheduling/index.js';
import {
  BERLIN,
  HARBOUR_HOURS,
  HORIZON_DAYS,
  LONDON,
  NORTH_HOURS,
  NOW,
  OIL_MINUTES,
  RHINE_HOURS,
  STEP_MINUTES,
  SYDNEY,
  at,
  range,
} from './fixtures.js';

// North with OIL and the shared clock, unless a test says otherwise.
function input(startIso: string, overrides: Partial<BookingTimeInput> = {}): BookingTimeInput {
  return {
    start: at(startIso),
    durationMinutes: OIL_MINUTES,
    timeZone: LONDON,
    openingHours: NORTH_HOURS,
    now: NOW,
    stepMinutes: STEP_MINUTES,
    horizonDays: HORIZON_DAYS,
    ...overrides,
  };
}

describe('checkBookingTime', () => {
  it('AC-01 a good start returns the range with the end from the duration', () => {
    expect(checkBookingTime(input('2027-03-09T09:00:00Z'))).toEqual({
      ok: true,
      range: range('2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z'),
    });
  });

  it('AC-12 ending exactly at closing is fine, running past it is not', () => {
    expect(checkBookingTime(input('2027-03-08T16:30:00Z'))).toEqual({
      ok: true,
      range: range('2027-03-08T16:30:00Z', '2027-03-08T17:30:00Z'),
    });
    for (const iso of [
      '2027-03-08T17:00:00Z',
      '2027-03-08T07:45:00Z',
      '2027-03-14T09:00:00Z',
      '2027-03-13T12:30:00Z',
    ]) {
      expect(checkBookingTime(input(iso))).toEqual({ ok: false, code: 'OUTSIDE_OPENING_HOURS' });
    }
  });

  it('AC-13 Harbour uses the Sydney weekday, whatever offset the request used', () => {
    const harbour = { timeZone: SYDNEY, openingHours: HARBOUR_HOURS };
    const expected = {
      ok: true,
      range: range('2027-03-07T21:00:00Z', '2027-03-07T22:00:00Z'),
    };
    expect(checkBookingTime(input('2027-03-08T08:00:00+11:00', harbour))).toEqual(expected);
    expect(checkBookingTime(input('2027-03-07T21:00:00Z', harbour))).toEqual(expected);
  });

  it('AC-13 Rhine checks opening hours in Berlin time', () => {
    const rhine = { timeZone: BERLIN, openingHours: RHINE_HOURS };
    expect(checkBookingTime(input('2027-03-09T08:30:00Z', rhine))).toEqual({
      ok: true,
      range: range('2027-03-09T08:30:00Z', '2027-03-09T09:30:00Z'),
    });
    expect(checkBookingTime(input('2027-03-09T08:30:00+01:00', rhine))).toEqual({
      ok: false,
      code: 'OUTSIDE_OPENING_HOURS',
    });
  });

  it('AC-14 opening hours follow local time across the spring change', () => {
    expect(checkBookingTime(input('2027-03-29T08:00:00+01:00'))).toEqual({
      ok: true,
      range: range('2027-03-29T07:00:00Z', '2027-03-29T08:00:00Z'),
    });
    expect(checkBookingTime(input('2027-03-29T07:30:00Z'))).toEqual({
      ok: true,
      range: range('2027-03-29T07:30:00Z', '2027-03-29T08:30:00Z'),
    });
    expect(checkBookingTime(input('2027-03-29T06:30:00Z'))).toEqual({
      ok: false,
      code: 'OUTSIDE_OPENING_HOURS',
    });
  });

  it('AC-15 starts off the grid are refused', () => {
    for (const iso of [
      '2027-03-09T09:07:00Z',
      '2027-03-09T09:00:30Z',
      '2027-03-09T09:00:00.001Z',
    ]) {
      expect(checkBookingTime(input(iso))).toEqual({ ok: false, code: 'START_NOT_ON_GRID' });
    }
  });

  it('AC-16 now and earlier are in the past, the next slot is fine', () => {
    expect(checkBookingTime(input('2027-03-01T09:00:00Z'))).toEqual({
      ok: false,
      code: 'START_IN_PAST',
    });
    expect(checkBookingTime(input('2027-03-01T08:45:00Z'))).toEqual({
      ok: false,
      code: 'START_IN_PAST',
    });
    expect(checkBookingTime(input('2027-03-01T09:15:00Z'))).toEqual({
      ok: true,
      range: range('2027-03-01T09:15:00Z', '2027-03-01T10:15:00Z'),
    });
  });

  it('AC-16 the horizon is exactly 90 x 24 hours from the clock', () => {
    // 31 May 2027 is a UK bank holiday. Closure days are out of scope, so this
    // start is a normal Monday here. Please don't "fix" it.
    const now = at('2027-03-02T09:00:00Z');
    expect(checkBookingTime(input('2027-05-31T09:00:00Z', { now }))).toEqual({
      ok: true,
      range: range('2027-05-31T09:00:00Z', '2027-05-31T10:00:00Z'),
    });
    expect(checkBookingTime(input('2027-05-31T09:15:00Z', { now }))).toEqual({
      ok: false,
      code: 'BEYOND_BOOKING_HORIZON',
    });
  });

  // The order is grid, then past, then horizon, then opening hours (SPEC "Order of checks").
  it('AC-37 off the grid and in the past gives START_NOT_ON_GRID', () => {
    expect(checkBookingTime(input('2027-03-01T08:07:00Z'))).toEqual({
      ok: false,
      code: 'START_NOT_ON_GRID',
    });
  });

  it('AC-37 in the past and before opening gives START_IN_PAST', () => {
    expect(checkBookingTime(input('2027-03-01T07:45:00Z'))).toEqual({
      ok: false,
      code: 'START_IN_PAST',
    });
  });

  it('AC-37 past the horizon and on a Sunday gives BEYOND_BOOKING_HORIZON', () => {
    expect(checkBookingTime(input('2027-06-06T09:00:00Z'))).toEqual({
      ok: false,
      code: 'BEYOND_BOOKING_HORIZON',
    });
  });

  it('off the grid and outside opening hours gives START_NOT_ON_GRID', () => {
    expect(checkBookingTime(input('2027-03-14T09:07:00Z'))).toEqual({
      ok: false,
      code: 'START_NOT_ON_GRID',
    });
  });

  it('throws on an unknown time zone instead of returning a code', () => {
    expect(() =>
      checkBookingTime(input('2027-03-09T09:00:00Z', { timeZone: 'Mars/Nowhere' })),
    ).toThrow(/Mars\/Nowhere/);
  });
});
