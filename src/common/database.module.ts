import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
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
      useFactory: (config: AppConfig) =>
        createDatabaseWithPool({
          url: config.databaseUrl,
          poolSize: config.dbPoolSize,
          statementTimeoutMs: config.booking.statementTimeoutMs,
          lockTimeoutMs: config.booking.lockTimeoutMs,
        }),
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
