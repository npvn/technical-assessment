import type { OpeningWindow } from '../scheduling/index.js';

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
// for the whole job. Red step stub, the real thing comes in the green half.
export function computeSlots(_input: SlotInput): Date[] {
  throw new Error('not implemented');
}
