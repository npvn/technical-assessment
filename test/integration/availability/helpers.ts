import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../src/db/types.js';
import { insertAppointment, type AppointmentRowInput } from '../../support/fixtures.js';

// Runs the work inside a transaction and always rolls it back. The tests use
// fixed UUIDs (bay 1 is ...0001 in every test), so nothing a test writes may
// stay behind for the next one. It also means findFreeResources gets called
// with a transaction, which is how the booking loop will call it.
export async function inRolledBackTransaction(
  db: Kysely<Database>,
  work: (trx: Transaction<Database>) => Promise<void>,
): Promise<void> {
  const trx = await db.startTransaction().execute();
  try {
    await work(trx);
  } finally {
    await trx.rollback().execute();
  }
}

export type InsertOutcome =
  { ok: true } | { ok: false; code: string; constraint: string | undefined };

// Tries one raw appointment insert inside a savepoint. A refused insert would
// otherwise abort the whole transaction. With keep false the row is always
// rolled back, so one probe can never get in the way of the next.
export async function tryInsertAppointment(
  trx: Transaction<Database>,
  row: AppointmentRowInput,
  options: { keep: boolean },
): Promise<InsertOutcome> {
  await sql`savepoint probe`.execute(trx);
  try {
    await insertAppointment(trx, row);
  } catch (error) {
    await sql`rollback to savepoint probe`.execute(trx);
    const e = error as { code?: string; constraint?: string };
    if (e.code === undefined) {
      throw error;
    }
    return { ok: false, code: e.code, constraint: e.constraint };
  }
  if (options.keep) {
    await sql`release savepoint probe`.execute(trx);
  } else {
    await sql`rollback to savepoint probe`.execute(trx);
  }
  return { ok: true };
}
