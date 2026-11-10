import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import type { Database } from '../db/types.js';
import type { TimeRange } from '../scheduling/index.js';

export interface FreeResourcesQuery {
  dealershipId: string;
  skillCode: string;
  range: TimeRange;
}

export interface FreeResources {
  // Lowest id first
  bayIds: string[];
  // Fewest skills first, then lowest id (A16)
  technicianIds: string[];
}

// A Kysely instance or a transaction (a Transaction is a Kysely too).
type Db = Kysely<Database>;

// True for a row of the appointments table that holds its bay, technician and
// vehicle during the range. This has to be the exact same range expression
// and the exact same status filter as the three exclusion constraints in
// src/db/migrations/0002_booking_constraints.sql. If the read were stricter
// the booking loop would say "no slot" while a pair is free, and if it were
// looser the loop would keep offering a bay the constraint keeps refusing
// (ADR 001 decision 2). Matching them also lets the read use the constraints'
// GiST indexes. Change one, change the other.
//
// It refers to the appointments table by name, so use it where that table is
// in scope without an alias.
export function overlapsActiveAppointment(range: TimeRange): RawBuilder<SqlBool> {
  return sql<SqlBool>`(appointments.status <> 'cancelled' and tstzrange(appointments.starts_at, appointments.ends_at, '[)') && tstzrange(${range.start}::timestamptz, ${range.end}::timestamptz, '[)'))`;
}

// Bays at the dealership with no active appointment overlapping the range.
export function freeBaysQuery(db: Db, query: FreeResourcesQuery) {
  return db
    .selectFrom('service_bays')
    .select('service_bays.id')
    .where('service_bays.dealership_id', '=', query.dealershipId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('appointments')
            .select(sql`1`.as('one'))
            .whereRef('appointments.service_bay_id', '=', 'service_bays.id')
            .where(overlapsActiveAppointment(query.range)),
        ),
      ),
    )
    .orderBy('service_bays.id');
}

// Technicians at the dealership who have the skill and no active appointment
// overlapping the range. The ones with the fewest skills come first, so the
// more flexible ones stay free for jobs only they can do (A16).
export function freeTechniciansQuery(db: Db, query: FreeResourcesQuery) {
  return db
    .selectFrom('technicians')
    .select('technicians.id')
    .where('technicians.dealership_id', '=', query.dealershipId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('technician_skills')
          .select(sql`1`.as('one'))
          .whereRef('technician_skills.technician_id', '=', 'technicians.id')
          .where('technician_skills.skill_code', '=', query.skillCode),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('appointments')
            .select(sql`1`.as('one'))
            .whereRef('appointments.technician_id', '=', 'technicians.id')
            .where(overlapsActiveAppointment(query.range)),
        ),
      ),
    )
    .orderBy((eb) =>
      eb
        .selectFrom('technician_skills as all_skills')
        .select((inner) => inner.fn.countAll().as('skill_count'))
        .whereRef('all_skills.technician_id', '=', 'technicians.id'),
    )
    .orderBy('technicians.id');
}

// Two plain queries, one for bays and one for technicians. The booking loop
// pairs them up itself, a cross join here would only multiply rows.
export async function findFreeResources(db: Db, query: FreeResourcesQuery): Promise<FreeResources> {
  const bays = await freeBaysQuery(db, query).execute();
  const technicians = await freeTechniciansQuery(db, query).execute();
  return {
    bayIds: bays.map((b) => b.id),
    technicianIds: technicians.map((t) => t.id),
  };
}
