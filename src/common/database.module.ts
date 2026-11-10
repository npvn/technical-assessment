import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { createDatabase } from '../db/database.js';
import type { Database } from '../db/types.js';
import { APP_CONFIG, ConfigModule } from './config.module.js';
import type { AppConfig } from './config.js';

export const DATABASE = Symbol('DATABASE');

// One Kysely instance over one pg pool for the whole app. The session
// timeouts are the booking ones, as the fallback for every other query (the
// booking transaction sets its own with SET LOCAL).
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createDatabase({
          url: config.databaseUrl,
          poolSize: config.dbPoolSize,
          statementTimeoutMs: config.booking.statementTimeoutMs,
          lockTimeoutMs: config.booking.lockTimeoutMs,
        }),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  // Closes the pool when the app shuts down, so the process can exit.
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
