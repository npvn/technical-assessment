import type { Kysely } from 'kysely';
import { createDatabase } from './database.js';
import type { Database } from './types.js';

// Fixed ids, so the cURL examples in the README work on any fresh install.
export const SEED_DEALERSHIP_IDS = {
  london: '11111111-1111-4111-8111-111111111111',
  sydney: '22222222-2222-4222-8222-222222222222',
  tokyo: '33333333-3333-4333-8333-333333333333',
} as const;

// Red step stub. The real seed comes in the green step.
export async function seed(_db: Kysely<Database>, _now: Date): Promise<void> {}

// CLI entry: node dist/db/seed.js, with DATABASE_URL set.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  const db = createDatabase({
    url,
    poolSize: 1,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 10_000,
  });
  try {
    // The seed is not domain code, it runs once at start up, so the real
    // clock is fine here.
    await seed(db, new Date());
  } finally {
    await db.destroy();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
