import {
  toAppointmentResponse,
  toHttpAnswer,
  type AppointmentView,
} from '../../../src/appointments/http-mapping.js';
import type {
  Appointment,
  BookingErrorCode,
  ContendedReason,
} from '../../../src/appointments/booking.types.js';

// The one place that turns a booking result into an HTTP status (DESIGN.md
// section 5). The table is typed as a Record over every code, so a new code
// in booking.types.ts doesn't compile here until it has a row.
const STATUS_BY_CODE: Record<BookingErrorCode, number> = {
  DEALERSHIP_NOT_FOUND: 404,
  SERVICE_TYPE_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  VEHICLE_NOT_FOUND: 404,
  TECHNICIAN_NOT_FOUND: 404,
  VEHICLE_NOT_OWNED_BY_CUSTOMER: 422,
  TECHNICIAN_NOT_ELIGIBLE: 422,
  SERVICE_NOT_OFFERED: 422,
  START_NOT_ON_GRID: 422,
  START_IN_PAST: 422,
  BEYOND_BOOKING_HORIZON: 422,
  OUTSIDE_OPENING_HOURS: 422,
  VEHICLE_ALREADY_BOOKED: 409,
  TECHNICIAN_UNAVAILABLE: 409,
  SLOT_UNAVAILABLE: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
};

// Same trick for the reasons. Every one of them is a 503 for the client.
const REASONS: Record<ContendedReason, true> = {
  attempt_cap: true,
  time_budget: true,
  db_retries_exhausted: true,
  statement_timeout: true,
};

const APPOINTMENT: Appointment = {
  id: 'a0000000-0000-4000-8000-000000000001',
  status: 'confirmed',
  customerId: 'c0000000-0000-4000-8000-000000000001',
  vehicleId: '0e000000-0000-4000-8000-000000000001',
  dealershipId: 'de000000-0000-4000-8000-000000000001',
  serviceTypeId: '5e000000-0000-4000-8000-000000000001',
  serviceBayId: 'ba000000-0000-4000-8000-000000000001',
  technicianId: '7e000000-0000-4000-8000-000000000001',
  startsAt: new Date('2027-03-09T09:00:00Z'),
  endsAt: new Date('2027-03-09T10:00:00Z'),
  createdAt: new Date('2027-03-01T09:00:00Z'),
};

function view(overrides: Partial<AppointmentView> = {}): AppointmentView {
  return { ...APPOINTMENT, timeZone: 'Europe/London', ...overrides };
}

describe('toHttpAnswer', () => {
  it.each(Object.entries(STATUS_BY_CODE))('%s is a %i problem', (code, status) => {
    const answer = toHttpAnswer({ kind: 'rejected', code: code as BookingErrorCode });

    expect(answer).toEqual({
      kind: 'problem',
      problem: { status, code, title: expect.any(String), detail: expect.any(String) },
      headers: {},
    });
    if (answer.kind !== 'problem') throw new Error('expected a problem');
    expect(answer.problem.title).not.toBe('');
    expect(answer.problem.detail).not.toBe('');
  });

  it.each(Object.keys(REASONS))(
    'contended (%s) is a 503 BOOKING_CONTENDED with Retry-After: 1',
    (reason) => {
      const answer = toHttpAnswer({ kind: 'contended', reason: reason as ContendedReason });

      expect(answer).toEqual({
        kind: 'problem',
        problem: {
          status: 503,
          code: 'BOOKING_CONTENDED',
          title: expect.any(String),
          detail: expect.any(String),
        },
        headers: { 'Retry-After': '1' },
      });
      // The reason is for logs and metrics only (DESIGN.md section 7)
      expect(JSON.stringify(answer)).not.toContain(reason);
    },
  );

  it('gives the client the same 503 whatever the reason', () => {
    const answers = Object.keys(REASONS).map((reason) =>
      toHttpAnswer({ kind: 'contended', reason: reason as ContendedReason }),
    );
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
  });

  it('created is a 201 with no extra headers', () => {
    expect(toHttpAnswer({ kind: 'created', appointment: APPOINTMENT })).toEqual({
      kind: 'success',
      status: 201,
      headers: {},
    });
  });

  // Nothing produces 'replayed' until step 8, but the type has it, so the
  // mapping has to say what it is (DESIGN.md section 5).
  it('replayed is a 201 with Idempotent-Replayed: true', () => {
    expect(toHttpAnswer({ kind: 'replayed', appointment: APPOINTMENT })).toEqual({
      kind: 'success',
      status: 201,
      headers: { 'Idempotent-Replayed': 'true' },
    });
  });
});

describe('toAppointmentResponse', () => {
  it('AC-01 gives the body with UTC times in Z and local times with a numeric offset', () => {
    expect(toAppointmentResponse(view())).toEqual({
      id: APPOINTMENT.id,
      status: 'confirmed',
      customerId: APPOINTMENT.customerId,
      vehicleId: APPOINTMENT.vehicleId,
      dealershipId: APPOINTMENT.dealershipId,
      serviceTypeId: APPOINTMENT.serviceTypeId,
      serviceBayId: APPOINTMENT.serviceBayId,
      technicianId: APPOINTMENT.technicianId,
      startsAt: '2027-03-09T09:00:00Z',
      endsAt: '2027-03-09T10:00:00Z',
      // +00:00 and never Z, even when the offset is zero
      startsAtLocal: '2027-03-09T09:00:00+00:00',
      endsAtLocal: '2027-03-09T10:00:00+00:00',
      timeZone: 'Europe/London',
      createdAt: '2027-03-01T09:00:00Z',
    });
  });

  it('AC-14 shows London summer time as +01:00', () => {
    const body = toAppointmentResponse(
      view({
        startsAt: new Date('2027-03-29T07:00:00Z'),
        endsAt: new Date('2027-03-29T08:00:00Z'),
      }),
    );
    expect(body).toMatchObject({
      startsAt: '2027-03-29T07:00:00Z',
      endsAt: '2027-03-29T08:00:00Z',
      startsAtLocal: '2027-03-29T08:00:00+01:00',
      endsAtLocal: '2027-03-29T09:00:00+01:00',
    });
  });

  it('AC-13 shows Sydney local time, a day ahead of UTC', () => {
    const body = toAppointmentResponse(
      view({
        timeZone: 'Australia/Sydney',
        startsAt: new Date('2027-03-07T21:00:00Z'),
        endsAt: new Date('2027-03-07T22:00:00Z'),
      }),
    );
    expect(body).toMatchObject({
      startsAt: '2027-03-07T21:00:00Z',
      startsAtLocal: '2027-03-08T08:00:00+11:00',
      endsAtLocal: '2027-03-08T09:00:00+11:00',
      timeZone: 'Australia/Sydney',
    });
  });

  // created_at comes from the database's now(), which has microseconds. The
  // SPEC format has no milliseconds, so they are cut off.
  it('drops the milliseconds from createdAt', () => {
    const body = toAppointmentResponse(view({ createdAt: new Date('2027-03-01T09:00:00.987Z') }));
    expect(body.createdAt).toBe('2027-03-01T09:00:00Z');
  });
});
