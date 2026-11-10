import { DateTime } from 'luxon';

// Domain code asks the clock for "now" instead of calling new Date(), so
// tests can pin the time (ADR 002).
export interface Clock {
  now(): Date;
}

// The only place in the app that reads the real time.
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

export class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  // A fresh copy each time, so a caller changing the Date it got back
  // can't move the clock.
  now(): Date {
    return DateTime.fromJSDate(this.instant).toJSDate();
  }
}
