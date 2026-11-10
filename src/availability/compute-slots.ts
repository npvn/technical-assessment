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
// It walks the local day from midnight in steps of real minutes and hands
// each candidate to checkBookingTime, the same rules the booking path uses.
// That way the grid, the past and horizon limits and the opening hours can't
// drift between the two. Any bay works with any qualified technician, so a
// start is free when at least one of each has nothing overlapping it.
export function computeSlots(input: SlotInput): Date[] {
  const day = localDayRange(input.date, input.timeZone);
  const stepMs = input.stepMinutes * 60_000;

  const slots: Date[] = [];
  for (let t = day.start.getTime(); t < day.end.getTime(); t += stepMs) {
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

// The span of the local day in UTC, for the day query. On a clock change day
// it's 23 or 25 hours long.
export function localDayRange(date: string, timeZone: string): TimeRange {
  const start = DateTime.fromISO(date, { zone: timeZone }).startOf('day');
  if (!start.isValid) {
    throw new Error(`Bad date "${date}" or time zone "${timeZone}"`);
  }
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}
