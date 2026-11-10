import { FixedClock, systemClock } from '../../../src/scheduling/index.js';
import { NOW } from './fixtures.js';

describe('Clock', () => {
  it('a fixed clock always returns the instant it was given', () => {
    const clock = new FixedClock(NOW);
    expect(clock.now()).toEqual(new Date('2027-03-01T09:00:00Z'));
    expect(clock.now()).toEqual(new Date('2027-03-01T09:00:00Z'));
  });

  it('the system clock returns the current time', () => {
    // Tests may read the real time. Only domain code must not.
    const before = Date.now();
    const now = systemClock.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
