import { DateTime } from 'luxon';
import type { Problem } from '../common/problem.js';
import type { Appointment, BookingErrorCode, BookingResult } from './booking.types.js';

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

type ErrorEntry = Omit<Problem, 'code' | 'errors'>;

// One row per code. Typed as a Record, so a new code doesn't compile until it
// has a row here. 404 is "that id doesn't exist", 422 is "this can never work
// as asked", 409 is "not at this time, try another" (A20).
const BOOKING_ERRORS: Record<BookingErrorCode, ErrorEntry> = {
  DEALERSHIP_NOT_FOUND: {
    status: 404,
    title: 'Dealership not found',
    detail: 'There is no dealership with this dealershipId.',
  },
  SERVICE_TYPE_NOT_FOUND: {
    status: 404,
    title: 'Service type not found',
    detail: 'There is no service type with this serviceTypeId.',
  },
  CUSTOMER_NOT_FOUND: {
    status: 404,
    title: 'Customer not found',
    detail: 'There is no customer with this customerId.',
  },
  VEHICLE_NOT_FOUND: {
    status: 404,
    title: 'Vehicle not found',
    detail: 'There is no vehicle with this vehicleId.',
  },
  TECHNICIAN_NOT_FOUND: {
    status: 404,
    title: 'Technician not found',
    detail: 'There is no technician with this preferredTechnicianId.',
  },
  VEHICLE_NOT_OWNED_BY_CUSTOMER: {
    status: 422,
    title: 'Vehicle not owned by customer',
    detail: 'The vehicle does not belong to this customer.',
  },
  TECHNICIAN_NOT_ELIGIBLE: {
    status: 422,
    title: 'Technician not eligible',
    detail:
      'The preferred technician does not work at this dealership or does not have the skill this service needs.',
  },
  SERVICE_NOT_OFFERED: {
    status: 422,
    title: 'Service not offered',
    detail: 'This dealership has no bay or no technician with the skill this service needs.',
  },
  START_NOT_ON_GRID: {
    status: 422,
    title: 'Start not on the grid',
    detail: 'Appointments start on a 15 minute boundary in the dealership time zone.',
  },
  START_IN_PAST: {
    status: 422,
    title: 'Start in the past',
    detail: 'The start time has to be in the future.',
  },
  BEYOND_BOOKING_HORIZON: {
    status: 422,
    title: 'Beyond the booking horizon',
    detail: 'Appointments can be booked at most 90 days ahead.',
  },
  OUTSIDE_OPENING_HOURS: {
    status: 422,
    title: 'Outside opening hours',
    detail: 'The appointment has to start and end inside the dealership opening hours that day.',
  },
  VEHICLE_ALREADY_BOOKED: {
    status: 409,
    title: 'Vehicle already booked',
    detail: 'This vehicle already has an appointment that overlaps this time.',
  },
  TECHNICIAN_UNAVAILABLE: {
    status: 409,
    title: 'Technician unavailable',
    detail: 'The preferred technician is busy at this time. Try another time.',
  },
  SLOT_UNAVAILABLE: {
    status: 409,
    title: 'Slot unavailable',
    detail: 'No bay and qualified technician are free for the whole service at this time.',
  },
  // Step 8 red stub, the real row comes with green.
  IDEMPOTENCY_KEY_REUSED: {
    status: 500,
    title: 'not implemented',
    detail: 'not implemented',
  },
};

// The reason stays out of it on purpose. The client does the same thing
// every time (wait and retry), the logs and metrics keep the reasons apart.
const CONTENDED: Problem = {
  status: 503,
  code: 'BOOKING_CONTENDED',
  title: 'Booking contended',
  detail: 'The server could not settle this booking in time. Try again shortly.',
};

export function toHttpAnswer(result: BookingResult): BookingHttpAnswer {
  switch (result.kind) {
    case 'created':
      return { kind: 'success', status: 201, headers: {} };
    case 'replayed':
      return { kind: 'success', status: 201, headers: { 'Idempotent-Replayed': 'true' } };
    case 'rejected':
      return {
        kind: 'problem',
        problem: { ...BOOKING_ERRORS[result.code], code: result.code },
        headers: {},
      };
    case 'contended':
      return { kind: 'problem', problem: { ...CONTENDED }, headers: { 'Retry-After': '1' } };
  }
}

export function toAppointmentResponse(view: AppointmentView): AppointmentResponse {
  return {
    id: view.id,
    status: view.status,
    customerId: view.customerId,
    vehicleId: view.vehicleId,
    dealershipId: view.dealershipId,
    serviceTypeId: view.serviceTypeId,
    serviceBayId: view.serviceBayId,
    technicianId: view.technicianId,
    startsAt: formatUtc(view.startsAt),
    endsAt: formatUtc(view.endsAt),
    startsAtLocal: formatLocal(view.startsAt, view.timeZone),
    endsAtLocal: formatLocal(view.endsAt, view.timeZone),
    timeZone: view.timeZone,
    createdAt: formatUtc(view.createdAt),
  };
}

// 2027-03-09T09:00:00Z. Milliseconds are cut off, not rounded, so a
// created_at a little before a second never shows the next second.
function formatUtc(instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: 'utc' })
    .startOf('second')
    .toISO({ suppressMilliseconds: true })!;
}

// 2027-03-09T09:00:00+00:00. Luxon writes a numeric offset for a named zone,
// even when it is zero, which is what the SPEC wants (never Z here).
function formatLocal(instant: Date, timeZone: string): string {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  if (!local.isValid) {
    throw new Error(`Unknown time zone "${timeZone}"`);
  }
  return local.startOf('second').toISO({ suppressMilliseconds: true });
}
