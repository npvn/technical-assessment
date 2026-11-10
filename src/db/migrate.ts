import { createDatabase } from './database.js';
import { migrateToLatest } from './migrator.js';

// CLI entry: node dist/db/migrate.js, with DATABASE_URL set.
// Exits with 1 when anything goes wrong, so Docker Compose stops before the
// API starts on a half migrated database.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  // Migrations can take a while on a big table, so no statement timeout here.
  const db = createDatabase({ url, poolSize: 1, statementTimeoutMs: 0, lockTimeoutMs: 10_000 });
  try {
    const applied = await migrateToLatest(db);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
