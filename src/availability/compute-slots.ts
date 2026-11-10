import { DateTime } from 'luxon';
import {
  checkBookingTime,
  overlaps,
  type OpeningWindow,
  type TimeRange,
} from '../scheduling/index.js';

// An active (not cancelled) appointment at the dealership that day, as the
// day query loads it.
export interface BusyAppointment {
  serviceBayId: string;
  technicianId: string;
  start: Date;
  end: Date;
}

export interface SlotInput {
  // A local date in the dealership's zone, YYYY-MM-DD, already validated
  date: string;
  timeZone: string;
  openingHours: readonly OpeningWindow[];
  durationMinutes: number;
  now: Date;
  stepMinutes: number;
  horizonDays: number;
  // Every bay at the dealership
  bayIds: readonly string[];
  // Every technician at the dealership with the skill the service needs
  technicianIds: readonly string[];
  appointments: readonly BusyAppointment[];
}

// The starts that day where a bay and a qualified technician are both free
// for the whole job. Resources only, no vehicle or preferred technician, so
// it's a hint and the booking call is still the real check (DESIGN.md
// section 5).
//
// The candidates are the starts the booking grid allows that day, local
// midnight plus whole steps of real minutes, but only the ones that can fall
// inside the opening window (see openingStretch). Each one goes through
// checkBookingTime, the same rules the booking path uses. That way the grid,
// the past and horizon limits and the opening hours can't drift between the
// two. Any bay works with any qualified technician, so a start is free when
// at least one of each has nothing overlapping it.
export function computeSlots(input: SlotInput): Date[] {
  const day = localDayRange(input.date, input.timeZone);
  const stepMs = input.stepMinutes * 60_000;
  const stretch = openingStretch(input, day);

  // Skip whole steps up to the stretch, so the walk lands on the same starts
  // a walk from midnight would.
  const dayStart = day.start.getTime();
  const skipped = Math.max(0, Math.ceil((stretch.first - dayStart) / stepMs));

  const slots: Date[] = [];
  for (
    let t = dayStart + skipped * stepMs;
    t < day.end.getTime() && t <= stretch.last;
    t += stepMs
  ) {
    const time = checkBookingTime({
      start: new Date(t),
      durationMinutes: input.durationMinutes,
      timeZone: input.timeZone,
      openingHours: input.openingHours,
      now: input.now,
      stepMinutes: input.stepMinutes,
      horizonDays: input.horizonDays,
    });
    if (!time.ok) continue;

    const clashing = input.appointments.filter((a) => overlaps(a, time.range));
    const busyBays = new Set(clashing.map((a) => a.serviceBayId));
    const busyTechnicians = new Set(clashing.map((a) => a.technicianId));
    if (
      input.bayIds.some((id) => !busyBays.has(id)) &&
      input.technicianIds.some((id) => !busyTechnicians.has(id))
    ) {
      slots.push(time.range.start);
    }
  }
  return slots;
}

// The wall time forms the opening hours check accepts, HH:MM or HH:MM:SS.
const WALL_TIME = /^\d{2}:\d{2}(?::\d{2})?$/;

// Walking the whole day was the cost. Every start goes through several Luxon
// zone conversions, and at the A23 peak that one loop was most of the CPU a
// read took. Only starts from opening time to closing time minus the job can
// pass the opening hours check, so this works out that stretch once for the
// day, in ms since the epoch.
//
// The wall time of an instant on this local date is the instant plus the
// zone offset at that moment, minus the date's midnight read as if it were
// UTC. On a clock change day the offset isn't the same all day, so the first
// start uses the biggest offset of the day and the last start the smallest.
// That can let a start or two too many through but it never leaves one out,
// and checkBookingTime still decides each of them. The offsets are read at
// the first and the last moment of the day, which is enough for a day with
// one clock change (I don't know of a zone with two in one day).
//
// A closed day gives an empty stretch. A wall time that isn't HH:MM or
// HH:MM:SS (the same test the opening hours check uses, so '08:00:00.5'
// counts as bad) gives the whole day, so checkBookingTime throws on it the
// way it did before. So does a local date the zone skipped entirely, since
// then the day starts on another date and the bounds above don't hold.
function openingStretch(input: SlotInput, day: TimeRange): { first: number; last: number } {
  const wholeDay = { first: day.start.getTime(), last: day.end.getTime() - 1 };
  const firstMoment = DateTime.fromMillis(wholeDay.first, { zone: input.timeZone });
  if (firstMoment.toISODate() !== input.date) return wholeDay;

  const midnightAsUtc = DateTime.fromISO(input.date, { zone: 'utc' });
  const window = input.openingHours.find((w) => w.isoWeekday === midnightAsUtc.weekday);
  if (!window) return { first: wholeDay.first, last: wholeDay.first - 1 };

  if (!WALL_TIME.test(window.opensAt) || !WALL_TIME.test(window.closesAt)) return wholeDay;
  const opens = DateTime.fromISO(`${input.date}T${window.opensAt}`, { zone: 'utc' });
  const closes = DateTime.fromISO(`${input.date}T${window.closesAt}`, { zone: 'utc' });
  if (!opens.isValid || !closes.isValid) return wholeDay;

  const lastMoment = DateTime.fromMillis(wholeDay.last, { zone: input.timeZone });
  const offsets = [firstMoment.offset * 60_000, lastMoment.offset * 60_000];
  return {
    first: opens.toMillis() - Math.max(...offsets),
    last: closes.toMillis() - input.durationMinutes * 60_000 - Math.min(...offsets),
  };
}

// The span of the local day in UTC, for the day query. On a clock change day
// it's 23 or 25 hours long. The end is the start of the next local day, not
// "start plus one day". In a zone that skips midnight the day starts at
// 01:00, and plus one day would land on 01:00 the next day.
export function localDayRange(date: string, timeZone: string): TimeRange {
  const start = DateTime.fromISO(date, { zone: timeZone }).startOf('day');
  if (!start.isValid) {
    throw new Error(`Bad date "${date}" or time zone "${timeZone}"`);
  }
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).startOf('day').toJSDate() };
}
