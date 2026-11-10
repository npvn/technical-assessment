import { toZone } from './zone.js';

// On the grid when the local minutes since midnight divide by the step and
// there are no stray seconds or milliseconds.
export function isOnGrid(start: Date, timeZone: string, stepMinutes: number): boolean {
  const local = toZone(start, timeZone);
  return (
    local.second === 0 &&
    local.millisecond === 0 &&
    (local.hour * 60 + local.minute) % stepMinutes === 0
  );
}
