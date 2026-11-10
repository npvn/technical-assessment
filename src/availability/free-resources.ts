import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import type { Database } from '../db/types.js';
import type { TimeRange } from '../scheduling/index.js';

// Red step stub. The tests import these names, the real queries come in the
// green step. Every function here returns a wrong value on purpose.

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

// The overlap test for a row of the appointments table, the same one the
// exclusion constraints use. Step 4 needs it for the vehicle and the
// preferred technician checks too.
export function overlapsActiveAppointment(_range: TimeRange): RawBuilder<SqlBool> {
  return sql<SqlBool>`false`;
}

export function freeBaysQuery(db: Db, _query: FreeResourcesQuery) {
  return db.selectFrom('service_bays').select('service_bays.id');
}

export function freeTechniciansQuery(db: Db, _query: FreeResourcesQuery) {
  return db.selectFrom('technicians').select('technicians.id');
}

export function findFreeResources(_db: Db, _query: FreeResourcesQuery): Promise<FreeResources> {
  return Promise.resolve({ bayIds: [], technicianIds: [] });
}
