// Domain code asks the clock for "now" instead of calling new Date(), so
// tests can pin the time (ADR 002).
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now(): Date {
    throw new Error('not implemented');
  },
};

export class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    throw new Error('not implemented');
  }
}
