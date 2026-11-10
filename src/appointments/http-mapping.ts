import type { Problem } from '../common/problem.js';
import type { Appointment, BookingResult } from './booking.types.js';

// An appointment together with its dealership's time zone, which the
// response needs for the local times.
export interface AppointmentView extends Appointment {
  timeZone: string;
}

// The body of a 201 from POST /appointments and a 200 from GET (AC-01, AC-32).
export interface AppointmentResponse {
  id: string;
  status: string;
  customerId: string;
  vehicleId: string;
  dealershipId: string;
  serviceTypeId: string;
  serviceBayId: string;
  technicianId: string;
  startsAt: string;
  endsAt: string;
  startsAtLocal: string;
  endsAtLocal: string;
  timeZone: string;
  createdAt: string;
}

// What a booking result becomes over HTTP. A success carries the status and
// headers and the controller adds the body. A problem goes to the exception
// filter.
export type BookingHttpAnswer =
  | { kind: 'success'; status: 201; headers: Record<string, string> }
  | { kind: 'problem'; problem: Problem; headers: Record<string, string> };

export function toHttpAnswer(_result: BookingResult): BookingHttpAnswer {
  throw new Error('not implemented');
}

export function toAppointmentResponse(_view: AppointmentView): AppointmentResponse {
  throw new Error('not implemented');
}
