import { checkBookingWindow } from '../../../src/scheduling/index.js';
import { HORIZON_DAYS, NOW, at } from './fixtures.js';

describe('checkBookingWindow', () => {
  it('AC-16 a start equal to now is in the past', () => {
    expect(checkBookingWindow(at('2027-03-01T09:00:00Z'), NOW, HORIZON_DAYS)).toBe('START_IN_PAST');
  });

  it('AC-16 a start before now is in the past', () => {
    expect(checkBookingWindow(at('2027-03-01T08:45:00Z'), NOW, HORIZON_DAYS)).toBe('START_IN_PAST');
  });

  it('AC-16 a start one slot after now is fine', () => {
    expect(checkBookingWindow(at('2027-03-01T09:15:00Z'), NOW, HORIZON_DAYS)).toBeNull();
  });

  it('AC-16 the horizon is 90 x 24 hours, not 90 local days', () => {
    // The spec's own clock for this case: Tue 2 March, before the clocks go forward.
    // 90 x 24 hours later is 2027-05-31T09:00Z (10:00 BST). Adding 90 local days
    // would put the limit at 08:00Z and refuse the first start.
    // 31 May 2027 is a UK bank holiday. Closure days are out of scope, so that
    // doesn't matter here. Please don't "fix" it.
    const now = at('2027-03-02T09:00:00Z');
    expect(checkBookingWindow(at('2027-05-31T09:00:00Z'), now, HORIZON_DAYS)).toBeNull();
    expect(checkBookingWindow(at('2027-05-31T09:15:00Z'), now, HORIZON_DAYS)).toBe(
      'BEYOND_BOOKING_HORIZON',
    );
  });

  it('AC-16 one millisecond past the horizon is beyond it', () => {
    const now = at('2027-03-02T09:00:00Z');
    expect(checkBookingWindow(at('2027-05-31T09:00:00.001Z'), now, HORIZON_DAYS)).toBe(
      'BEYOND_BOOKING_HORIZON',
    );
  });
});
