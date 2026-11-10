import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

export interface DatabaseOptions {
  url: string;
  poolSize: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}

// One Kysely instance over a pg pool. The timeouts are set per session through
// the connection's startup options, so every connection in the pool gets them
// without an extra round trip. The booking transaction also sets its own with
// SET LOCAL (ADR 001), these are the fallback for everything else.
export function createDatabase(options: DatabaseOptions): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolSize,
    options: `-c statement_timeout=${options.statementTimeoutMs} -c lock_timeout=${options.lockTimeoutMs}`,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
