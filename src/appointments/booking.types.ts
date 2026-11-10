import type { AppointmentStatus } from '../db/types.js';

// What the booking service gets once the HTTP layer has validated the body.
// startTime is already an exact instant (the request always carries an
// offset, ADR 002).
export interface BookingRequest {
  dealershipId: string;
  serviceTypeId: string;
  customerId: string;
  vehicleId: string;
  startTime: Date;
  preferredTechnicianId?: string | null;
  // The Idempotency-Key header, already checked by the HTTP layer. Missing
  // and null both mean the request has no key. Same key and same request returns the
  // original appointment (A15).
  idempotencyKey?: string | null;
}

// A stored appointment, in the service's own words (camelCase, Dates).
export interface Appointment {
  id: string;
  status: AppointmentStatus;
  dealershipId: string;
  serviceTypeId: string;
  customerId: string;
  vehicleId: string;
  serviceBayId: string;
  technicianId: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

// The error codes the service can answer with, in the SPEC "Order of checks".
// The HTTP layer maps them to 404, 422 and 409.
// IDEMPOTENCY_KEY_REUSED comes first of all of them when it applies (step 2
// of the order), it only sits at the end of this list.
export type BookingErrorCode =
  | 'DEALERSHIP_NOT_FOUND'
  | 'SERVICE_TYPE_NOT_FOUND'
  | 'CUSTOMER_NOT_FOUND'
  | 'VEHICLE_NOT_FOUND'
  | 'TECHNICIAN_NOT_FOUND'
  | 'VEHICLE_NOT_OWNED_BY_CUSTOMER'
  | 'TECHNICIAN_NOT_ELIGIBLE'
  | 'SERVICE_NOT_OFFERED'
  | 'START_NOT_ON_GRID'
  | 'START_IN_PAST'
  | 'BEYOND_BOOKING_HORIZON'
  | 'OUTSIDE_OPENING_HOURS'
  | 'VEHICLE_ALREADY_BOOKED'
  | 'TECHNICIAN_UNAVAILABLE'
  | 'SLOT_UNAVAILABLE'
  | 'IDEMPOTENCY_KEY_REUSED';

// Why the loop gave up without an answer. All of them become 503
// BOOKING_CONTENDED for the client, the reason is for logs and metrics.
export type ContendedReason =
  'attempt_cap' | 'time_budget' | 'db_retries_exhausted' | 'statement_timeout';

// No HTTP status codes in here on purpose, the HTTP layer maps these.
// 'replayed' is produced by the idempotency lookup.
export type BookingResult =
  | { kind: 'created'; appointment: Appointment }
  | { kind: 'replayed'; appointment: Appointment }
  | { kind: 'rejected'; code: BookingErrorCode }
  | { kind: 'contended'; reason: ContendedReason };
