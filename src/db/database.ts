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

// Our own code for an error from a query on a connection that has died, a
// session Postgres ended (restart, failover, pg_terminate_backend) or a socket
// that closed. pg reports that on the client as an 'error' event and fails
// the query after it with no code ("Connection terminated unexpectedly", or
// "Client has encountered a connection error and is not queryable" for the
// ROLLBACK that Kysely sends next). The client remembers the event, and every
// code-less error from it after that gets this code.
export const DB_CONNECTION_LOST = 'DB_CONNECTION_LOST';

export interface DatabaseEvents {
  // A connection died while a request had it checked out. Gets the code only
  // (a SQLSTATE like 57P01, or none), the message can carry connection
  // details. A connection that dies while idle in the pool is reported by
  // the pool's own 'error' event instead.
  onLostInUse?: (code: string) => void;
}

interface ClientState {
  lost: boolean;
  inUse: boolean;
}

// One Kysely instance over a pg pool. The timeouts are set per session through
// the connection's startup options, so every connection in the pool gets them
// without an extra round trip. The booking transaction also sets its own with
// SET LOCAL (ADR 001), these are the fallback for everything else.
export function createDatabase(options: DatabaseOptions): Kysely<Database> {
  return createDatabaseWithPool(options).db;
}

// The same, plus the pg pool underneath, for the pool gauges at /metrics.
// Kysely keeps its pool to itself, so the counts have to come from here.
export function createDatabaseWithPool(
  options: DatabaseOptions,
  events: DatabaseEvents = {},
): {
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
  const states = new WeakMap<pg.PoolClient, ClientState>();
  pool.on('connect', (client) => states.set(client, watchClient(client, events)));
  return {
    db: new Kysely<Database>({
      dialect: new PostgresDialect({ pool: tagConnectErrors(pool, states) }),
    }),
    pool,
  };
}

// Every new client gets its own 'error' listener, for as long as it lives.
// pg-pool only listens while a client sits idle and takes its listener off
// when the client is checked out. A session that died in the middle of a
// transaction then emitted 'error' with nobody listening, and Node ended the
// whole process. The listener also marks the client as lost, so the errors
// its queries fail with after that can be given DB_CONNECTION_LOST.
function watchClient(client: pg.PoolClient, events: DatabaseEvents): ClientState {
  const state: ClientState = { lost: false, inUse: false };
  client.on('error', (error: Error & { code?: unknown }) => {
    // pg can emit twice for one death (the FATAL message, then the closed
    // socket), once is enough to report
    if (state.lost) return;
    state.lost = true;
    if (state.inUse) events.onLostInUse?.(typeof error.code === 'string' ? error.code : 'none');
  });

  // pg fails the pending queries of a dead connection on the next tick and
  // emits 'error' right away, so state.lost is already set when the failed
  // query's error comes through here.
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  const tagged = (...args: unknown[]): unknown => {
    const result = query(...args);
    if (!(result instanceof Promise)) return result;
    return result.catch((error: unknown) => {
      if (state.lost) tagWithoutCode(error, DB_CONNECTION_LOST);
      throw error;
    });
  };
  Object.assign(client, { query: tagged });
  return state;
}

// What Kysely gets instead of the pool itself: the same pool, but a failed
// connect comes out with a code, and each client knows whether it is checked
// out. Kysely only calls connect and end, and reads Client and options for
// its cancel connection.
function tagConnectErrors(
  pool: pg.Pool,
  states: WeakMap<pg.PoolClient, ClientState>,
): PostgresPool {
  // pg-pool sets Client at runtime, the pg types just don't list it
  const { Client } = pool as pg.Pool & Pick<PostgresPool, 'Client'>;
  return {
    Client,
    options: pool.options,
    end: () => pool.end(),
    connect: async () => {
      const client = await pool.connect().catch((error: unknown) => {
        tagWithoutCode(error, DB_CONNECT_FAILED);
        throw error;
      });
      const state = states.get(client);
      if (state) {
        state.inUse = true;
        // pg-pool gives the client a new release function on every checkout
        const release = client.release.bind(client);
        client.release = (error?: Error | boolean) => {
          state.inUse = false;
          release(error);
        };
      }
      return client;
    },
  };
}

// Gives an error our code, unless it already has one of its own
function tagWithoutCode(error: unknown, code: string): void {
  if (error instanceof Error && typeof (error as { code?: unknown }).code !== 'string') {
    Object.assign(error, { code });
  }
}
