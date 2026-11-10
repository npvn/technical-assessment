import { DateTime } from 'luxon';

// Converts an instant into the dealership's zone. An unknown zone is bad data
// in the dealerships table, not something a customer did, so it throws
// instead of turning into a booking answer.
export function toZone(instant: Date, timeZone: string): DateTime {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  if (!local.isValid) {
    throw new Error(`Unknown time zone "${timeZone}": ${local.invalidExplanation ?? 'invalid'}`);
  }
  return local;
}
