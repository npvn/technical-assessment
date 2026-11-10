import { sql, type Kysely, type Transaction } from 'kysely';
import { findFreeResources, overlapsActiveAppointment } from '../availability/free-resources.js';
import type { AppointmentRow, Database } from '../db/types.js';
import type { OpeningWindow, TimeRange } from '../scheduling/index.js';
import type { BookingConfig } from './booking.config.js';
import type { Appointment, BookingRequest } from './booking.types.js';

// Everything the booking service needs from the database, behind one
// interface. The service only talks to this, so the loop can be unit tested
// with a fake store (AC-25, AC-41) and the Postgres version below is the only
// place that knows about transactions and SQL.

// An appointment that was booked with an idempotency key, and the hash of
// the request that booked it. The service compares the hash with its own to
// tell a replay from a reused key.
export interface KeyedAppointment {
  appointment: Appointment;
  requestHash: string;
}

// The facts behind the 404 and 422 checks, read once before the loop. The
// store only reports what it found. The service decides which code wins, in
// the SPEC "Order of checks".
export interface BookingLookup {
  dealership: { id: string; timeZone: string; openingHours: OpeningWindow[] } | null;
  serviceType: { id: string; durationMinutes: number; requiredSkillCode: string } | null;
  customerFound: boolean;
  vehicle: { id: string; customerId: string } | null;
  // null when the request has no preferred technician, and also when the id
  // is unknown. The service knows which one it asked for.
  preferredTechnician: { id: string; dealershipId: string; skillCodes: string[] } | null;
  // The dealership has at least one bay and at least one technician with the
  // required skill, busy or not. False if the dealership or service type is
  // unknown.
  offersService: boolean;
  // The appointment this customer already booked with the request's
  // idempotency key. Missing or null when the request has no key or nothing
  // was booked with it yet.
  keyed?: KeyedAppointment | null;
}

// What one attempt asks the classifying read about.
export interface SlotQuery {
  dealershipId: string;
  vehicleId: string;
  skillCode: string;
  range: TimeRange;
  preferredTechnicianId: string | null;
  // Set when the request has an idempotency key. A key is scoped to one customer (A15).
  idempotency?: { customerId: string; key: string } | null;
}

// What the classifying read found, as plain facts. The service turns them
// into an answer in the ADR 001 order (vehicle, preferred technician, slot).
// bayIds and technicianIds are the ordered free lists (bays by id,
// technicians by fewest skills then id (A16)). The first attempt's list
// lengths give the hard cap.
export interface SlotRead {
  vehicleBusy: boolean;
  preferredTechnicianBusy: boolean;
  bayIds: string[];
  technicianIds: string[];
  // The appointment already booked with the request's key, if any. Only
  // looked for when the query has a key.
  keyed?: KeyedAppointment | null;
}

export interface NewBooking {
  dealershipId: string;
  serviceTypeId: string;
  customerId: string;
  vehicleId: string;
  serviceBayId: string;
  technicianId: string;
  range: TimeRange;
  // Stored on the row in the same insert, so the partial unique index on
  // (customer_id, idempotency_key) lets only one of two twins in.
  idempotency?: { key: string; requestHash: string } | null;
}

// One attempt's view of the database. Both calls run inside the attempt's
// transaction.
export interface BookingAttempt {
  readSlot(query: SlotQuery): Promise<SlotRead>;
  // The stored appointment, or null when the insert hit a conflict and
  // inserted nothing (somebody got in first).
  tryInsert(booking: NewBooking): Promise<Appointment | null>;
}

export interface BookingStore {
  lookup(request: BookingRequest): Promise<BookingLookup>;
  // Runs work in one short transaction. Whatever work throws is thrown out of
  // here unchanged, after the rollback.
  runAttempt<T>(work: (attempt: BookingAttempt) => Promise<T>): Promise<T>;
}

// The Postgres store.
export class PostgresBookingStore implements BookingStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: BookingConfig,
  ) {}

  // A handful of small reads by primary key, outside any booking
  // transaction. Nothing here decides "free or not", that is the loop's job
  // inside its own transaction.
  async lookup(request: BookingRequest): Promise<BookingLookup> {
    const { db } = this;

    const dealershipRow = await db
      .selectFrom('dealerships')
      .select(['id', 'time_zone'])
      .where('id', '=', request.dealershipId)
      .executeTakeFirst();
    const hours = dealershipRow
      ? await db
          .selectFrom('opening_hours')
          .select(['iso_weekday', 'opens_at', 'closes_at'])
          .where('dealership_id', '=', dealershipRow.id)
          .execute()
      : [];

    const serviceTypeRow = await db
      .selectFrom('service_types')
      .select(['id', 'duration_minutes', 'required_skill_code'])
      .where('id', '=', request.serviceTypeId)
      .executeTakeFirst();

    const customerRow = await db
      .selectFrom('customers')
      .select('id')
      .where('id', '=', request.customerId)
      .executeTakeFirst();

    const vehicleRow = await db
      .selectFrom('vehicles')
      .select(['id', 'customer_id'])
      .where('id', '=', request.vehicleId)
      .executeTakeFirst();

    let preferredTechnician: BookingLookup['preferredTechnician'] = null;
    if (request.preferredTechnicianId != null) {
      const technicianRow = await db
        .selectFrom('technicians')
        .select(['id', 'dealership_id'])
        .where('id', '=', request.preferredTechnicianId)
        .executeTakeFirst();
      if (technicianRow) {
        const skills = await db
          .selectFrom('technician_skills')
          .select('skill_code')
          .where('technician_id', '=', technicianRow.id)
          .execute();
        preferredTechnician = {
          id: technicianRow.id,
          dealershipId: technicianRow.dealership_id,
          skillCodes: skills.map((s) => s.skill_code),
        };
      }
    }

    // Does the dealership have a bay and a technician with the skill at all,
    // busy or not? If not, the request can never work (SERVICE_NOT_OFFERED).
    let offersService = false;
    if (dealershipRow && serviceTypeRow) {
      const offer = await db
        .selectNoFrom((eb) => [
          eb
            .exists(
              eb
                .selectFrom('service_bays')
                .select('service_bays.id')
                .where('service_bays.dealership_id', '=', dealershipRow.id),
            )
            .as('has_bay'),
          eb
            .exists(
              eb
                .selectFrom('technicians')
                .innerJoin('technician_skills', 'technician_skills.technician_id', 'technicians.id')
                .select('technicians.id')
                .where('technicians.dealership_id', '=', dealershipRow.id)
                .where('technician_skills.skill_code', '=', serviceTypeRow.required_skill_code),
            )
            .as('has_technician'),
        ])
        .executeTakeFirstOrThrow();
      offersService = Boolean(offer.has_bay) && Boolean(offer.has_technician);
    }

    // The booking already made with this key, if any. The service checks
    // this before anything else above (ADR 001 decision 3).
    const keyed = request.idempotencyKey
      ? await findKeyed(db, { customerId: request.customerId, key: request.idempotencyKey })
      : null;

    return {
      dealership: dealershipRow
        ? {
            id: dealershipRow.id,
            timeZone: dealershipRow.time_zone,
            openingHours: hours.map((h) => ({
              isoWeekday: h.iso_weekday,
              opensAt: h.opens_at,
              closesAt: h.closes_at,
            })),
          }
        : null,
      serviceType: serviceTypeRow
        ? {
            id: serviceTypeRow.id,
            durationMinutes: serviceTypeRow.duration_minutes,
            requiredSkillCode: serviceTypeRow.required_skill_code,
          }
        : null,
      customerFound: customerRow !== undefined,
      vehicle: vehicleRow ? { id: vehicleRow.id, customerId: vehicleRow.customer_id } : null,
      preferredTechnician,
      offersService,
      keyed,
    };
  }

  // One attempt is one short transaction (ADR 001 decision 4).
  // - The isolation level is set here, not left to the database default. At
  //   REPEATABLE READ a lost race in ON CONFLICT DO NOTHING raises 40001
  //   instead of returning zero rows, and every lost race would become a 503
  //   (AC-38).
  // - The timeouts are set with set_config(..., true), which is SET LOCAL.
  //   They end with the transaction, so they still work behind PgBouncer in
  //   transaction mode, where a session SET would stick to whichever server
  //   connection ran it (ADR 001 decision 7).
  // Kysely rolls back and throws the original error if work throws, so the
  // SQLSTATE reaches the loop unchanged.
  runAttempt<T>(work: (attempt: BookingAttempt) => Promise<T>): Promise<T> {
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await sql`
          SELECT
            set_config('lock_timeout', ${String(this.config.lockTimeoutMs)}, true),
            set_config('statement_timeout', ${String(this.config.statementTimeoutMs)}, true)
        `.execute(trx);
        return work(new PostgresBookingAttempt(trx));
      });
  }
}

class PostgresBookingAttempt implements BookingAttempt {
  constructor(private readonly trx: Transaction<Database>) {}

  // The classifying read. Every overlap test here goes through
  // overlapsActiveAppointment, the same range expression and status filter as
  // the exclusion constraints, so the read and the constraints agree on what
  // "busy" means (ADR 001 decision 2). At READ COMMITTED each statement sees
  // the latest commits, so a booking that just beat us shows up here.
  //
  // These are separate statements, so each one has its own snapshot. The
  // free lists go first and the vehicle and preferred technician checks go
  // last on purpose. Without cancellations a busy resource never turns free,
  // so the checks that win in the ADR order see the newest data. Read the
  // other way round, a car booked in between could come back as
  // SLOT_UNAVAILABLE instead of VEHICLE_ALREADY_BOOKED. Stale free lists are
  // harmless, they can only be too hopeful, and the insert has the last word.
  async readSlot(query: SlotQuery): Promise<SlotRead> {
    const { trx } = this;
    const { range, preferredTechnicianId } = query;

    const free = await findFreeResources(trx, {
      dealershipId: query.dealershipId,
      skillCode: query.skillCode,
      range,
    });

    const busy = await trx
      .selectNoFrom((eb) => [
        // The vehicle at any dealership, a car can't be in two places at once (A13)
        eb
          .exists(
            eb
              .selectFrom('appointments')
              .select('appointments.id')
              .where('appointments.vehicle_id', '=', query.vehicleId)
              .where(overlapsActiveAppointment(range)),
          )
          .as('vehicle_busy'),
        preferredTechnicianId
          ? eb
              .exists(
                eb
                  .selectFrom('appointments')
                  .select('appointments.id')
                  .where('appointments.technician_id', '=', preferredTechnicianId)
                  .where(overlapsActiveAppointment(range)),
              )
              .as('technician_busy')
          : sql<boolean>`false`.as('technician_busy'),
      ])
      .executeTakeFirstOrThrow();

    // The idempotency key goes last, as its own statement after the busy
    // checks. At READ COMMITTED a later statement sees everything an earlier
    // one saw and maybe more. So if a twin with our key committed in time
    // for the vehicle check to see its booking, this one sees the twin's key
    // too, and the service answers with a replay instead of a false
    // VEHICLE_ALREADY_BOOKED (AC-30). Run first, it could miss a twin that
    // commits in between.
    const keyed = query.idempotency ? await findKeyed(trx, query.idempotency) : null;

    return {
      keyed,
      vehicleBusy: Boolean(busy.vehicle_busy),
      preferredTechnicianBusy: Boolean(busy.technician_busy),
      bayIds: free.bayIds,
      technicianIds: free.technicianIds,
    };
  }

  // ON CONFLICT DO NOTHING with no conflict target covers all three exclusion
  // constraints (and the idempotency index). When two inserts meet, one backs
  // off with zero rows instead of both waiting into a deadlock, and the
  // transaction stays usable. Zero rows doesn't say which constraint was in
  // the way, the next attempt's read works that out (ADR 001).
  async tryInsert(booking: NewBooking): Promise<Appointment | null> {
    const row = await this.trx
      .insertInto('appointments')
      .values({
        dealership_id: booking.dealershipId,
        service_type_id: booking.serviceTypeId,
        customer_id: booking.customerId,
        vehicle_id: booking.vehicleId,
        service_bay_id: booking.serviceBayId,
        technician_id: booking.technicianId,
        starts_at: booking.range.start,
        ends_at: booking.range.end,
        status: 'confirmed',
        idempotency_key: booking.idempotency?.key ?? null,
        request_hash: booking.idempotency?.requestHash ?? null,
      })
      .onConflict((oc) => oc.doNothing())
      .returningAll()
      .executeTakeFirst();
    return row ? toAppointment(row) : null;
  }
}

// The appointment booked with this customer's key. No status filter, on
// purpose: the unique index has none either, so a cancelled booking still
// owns its key. Filtering it out here would let the loop keep trying an
// insert the index keeps refusing.
async function findKeyed(
  db: Kysely<Database>,
  where: { customerId: string; key: string },
): Promise<KeyedAppointment | null> {
  const row = await db
    .selectFrom('appointments')
    .selectAll()
    .where('customer_id', '=', where.customerId)
    .where('idempotency_key', '=', where.key)
    .executeTakeFirst();
  if (!row?.request_hash) return null;
  return { appointment: toAppointment(row), requestHash: row.request_hash };
}

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    status: row.status,
    dealershipId: row.dealership_id,
    serviceTypeId: row.service_type_id,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    serviceBayId: row.service_bay_id,
    technicianId: row.technician_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
  };
}
