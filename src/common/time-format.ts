import { DateTime } from 'luxon';

// How times leave the API. Appointments and availability both use these, so
// the two bodies can't end up with different formats.

// 2027-03-09T09:00:00Z. Milliseconds are cut off, not rounded, so a
// created_at a little before a second never shows the next second.
export function formatUtc(instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: 'utc' })
    .startOf('second')
    .toISO({ suppressMilliseconds: true })!;
}

// 2027-03-09T09:00:00+00:00. Luxon writes a numeric offset for a named zone,
// even when it is zero, which is what the SPEC wants (never Z here).
export function formatLocal(instant: Date, timeZone: string): string {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  if (!local.isValid) {
    throw new Error(`Unknown time zone "${timeZone}"`);
  }
  return local.startOf('second').toISO({ suppressMilliseconds: true });
}
