import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

// The .sql files sit next to this file, in src/db/migrations when running from
// source (tests) and in dist/db/migrations after nest build copies them.
export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

// Reads every .sql file in the folder and runs it as one raw statement batch.
// The file name (without .sql) is the migration name, and Kysely runs them in
// name order, so they are numbered 0001_, 0002_ and so on. There is no down
// migration, a mistake gets fixed with a new file.
export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly dir: string = MIGRATIONS_DIR) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.sql')).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const text = await readFile(join(this.dir, file), 'utf8');
      migrations[file.replace(/\.sql$/, '')] = {
        up: async (db) => {
          await sql.raw(text).execute(db);
        },
      };
    }
    return migrations;
  }
}

// Runs all pending migrations and throws if one fails, so callers can't
// forget to look at the result.
export async function migrateToLatest<DB>(db: Kysely<DB>, dir?: string): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new SqlFileMigrationProvider(dir) });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error !== undefined || failed) {
    const name = failed ? ` (${failed.migrationName})` : '';
    throw new Error(`migration failed${name}`, { cause: error });
  }
  return (results ?? []).map((r) => r.migrationName);
}
