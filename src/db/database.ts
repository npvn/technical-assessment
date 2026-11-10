import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

export interface DatabaseOptions {
  url: string;
  poolSize: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  // How long to wait for a pool connection. Unset means pg's default, which
  // is to wait forever. The app always sets it (DB_CONNECT_TIMEOUT_MS), the
  // test helpers and the migrate and seed CLIs leave it out.
  connectTimeoutMs?: number;
}

// Our own code for an error that came out of getting a connection and had no
// code of its own. pg gives none to its connect timeouts ("timeout exceeded
// when trying to connect" when the pool is full, "Connection terminated due
// to connection timeout" when the host doesn't answer). Anything that fails
// before a query has even run is a connection failure, so it gets this code
// and isDatabaseUnavailable can tell from the code alone.
export const DB_CONNECT_FAILED = 'DB_CONNECT_FAILED';

// One Kysely instance over a pg pool. The timeouts are set per session through
// the connection's startup options, so every connection in the pool gets them
// without an extra round trip. The booking transaction also sets its own with
// SET LOCAL (ADR 001), these are the fallback for everything else.
export function createDatabase(options: DatabaseOptions): Kysely<Database> {
  return createDatabaseWithPool(options).db;
}

// The same, plus the pg pool underneath, for the pool gauges at /metrics.
// Kysely keeps its pool to itself, so the counts have to come from here.
export function createDatabaseWithPool(options: DatabaseOptions): {
  db: Kysely<Database>;
  pool: pg.Pool;
} {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolSize,
    options: `-c statement_timeout=${options.statementTimeoutMs} -c lock_timeout=${options.lockTimeoutMs}`,
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectTimeoutMs }),
  });
  return {
    db: new Kysely<Database>({ dialect: new PostgresDialect({ pool: tagConnectErrors(pool) }) }),
    pool,
  };
}

// What Kysely gets instead of the pool itself: the same pool, but a failed
// connect comes out with a code. Kysely only calls connect and end, and
// reads Client and options for its cancel connection.
function tagConnectErrors(pool: pg.Pool): PostgresPool {
  // pg-pool sets Client at runtime, the pg types just don't list it
  const { Client } = pool as pg.Pool & Pick<PostgresPool, 'Client'>;
  return {
    Client,
    options: pool.options,
    end: () => pool.end(),
    connect: () =>
      pool.connect().catch((error: unknown) => {
        if (error instanceof Error && typeof (error as { code?: unknown }).code !== 'string') {
          Object.assign(error, { code: DB_CONNECT_FAILED });
        }
        throw error;
      }),
  };
}
