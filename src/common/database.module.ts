import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { createDatabaseWithPool } from '../db/database.js';
import type { Database } from '../db/types.js';
import { APP_CONFIG, ConfigModule } from './config.module.js';
import type { AppConfig } from './config.js';

export const DATABASE = Symbol('DATABASE');
// The pg pool under DATABASE, only for the pool gauges at /metrics.
export const DB_POOL = Symbol('DB_POOL');
const DATABASE_WITH_POOL = Symbol('DATABASE_WITH_POOL');

// One Kysely instance over one pg pool for the whole app. The session
// timeouts are the booking ones, as the fallback for every other query (the
// booking transaction sets its own with SET LOCAL).
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE_WITH_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const lostLogger = new Logger('DatabasePool');
        const both = createDatabaseWithPool(
          {
            url: config.databaseUrl,
            poolSize: config.dbPoolSize,
            statementTimeoutMs: config.booking.statementTimeoutMs,
            lockTimeoutMs: config.booking.lockTimeoutMs,
            connectTimeoutMs: config.dbConnectTimeoutMs,
          },
          {
            // The request using it gets a 503, this is the line for the
            // operator. Code only, like the idle handler below.
            onLostInUse: (code) =>
              lostLogger.warn(`database connection lost while in use, code ${code}`),
          },
        );
        keepRunningOnIdleErrors(both.pool);
        return both;
      },
    },
    {
      provide: DATABASE,
      inject: [DATABASE_WITH_POOL],
      useFactory: (both: { db: Kysely<Database> }) => both.db,
    },
    {
      provide: DB_POOL,
      inject: [DATABASE_WITH_POOL],
      useFactory: (both: { pool: pg.Pool }) => both.pool,
    },
  ],
  exports: [DATABASE, DB_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  // Closes the pool when the app shuts down, so the process can exit.
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

// When Postgres ends a connection that is sitting idle in the pool (a
// restart, a failover, pg_terminate_backend), pg emits 'error' on the pool.
// (A connection that is checked out has its own listener, see watchClient in
// src/db/database.ts.)
// With no listener Node treats that as an uncaught error and the whole
// process dies, and every instance would go down with one database blip.
// The pool has already thrown the dead connection away and opens a new one
// on the next query, so logging it is all there is to do. Only the SQLSTATE
// or system code goes in the log, the message text can carry connection
// details.
function keepRunningOnIdleErrors(pool: pg.Pool): void {
  const logger = new Logger('DatabasePool');
  pool.on('error', (error: Error & { code?: unknown }) => {
    const code = typeof error.code === 'string' ? error.code : 'unknown';
    logger.warn(`idle database connection failed, code ${code}`);
  });
}
