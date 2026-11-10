import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';
import { createDatabase } from '../../src/db/database.js';
import type { Database } from '../../src/db/types.js';
import { databaseUrl } from './database-url.js';

export interface TestDatabase {
  db: Kysely<Database>;
  // Connection string for this test database, for code that opens its own pool
  // (the Nest app in e2e tests, for example).
  url: string;
  destroy: () => Promise<void>;
}

export interface TestDatabaseOptions {
  // Concurrency tests need more connections than parallel requests, or the
  // pool queues them and the race never happens.
  poolSize?: number;
}

// Clones the migrated template into a fresh database with a random name.
// Call it once per test file (in beforeAll) and call destroy in afterAll.
// Files never see each other's rows, so they can run in parallel.
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const adminUrl = inject('adminDatabaseUrl');
  const template = inject('templateDatabaseName');
  const name = `test_${randomBytes(6).toString('hex')}`;

  await withAdmin(adminUrl, async (admin) => {
    await createFromTemplate(admin, name, template);
  });

  const url = databaseUrl(adminUrl, name);
  const db = createDatabase({
    url,
    poolSize: options.poolSize ?? 5,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 10_000,
  });

  return {
    db,
    url,
    destroy: async () => {
      await db.destroy();
      await withAdmin(adminUrl, async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      });
    },
  };
}

async function withAdmin(url: string, work: (admin: pg.Client) => Promise<void>): Promise<void> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await work(admin);
  } finally {
    await admin.end();
  }
}

// Two files cloning at the same moment can trip over each other with
// "source database is being accessed by other users" (55006), because the
// copy briefly connects to the template. A short retry covers that.
async function createFromTemplate(admin: pg.Client, name: string, template: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== '55006' || attempt >= 10) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}
