import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'supertest';
import { AppModule } from '../../src/app.module.js';
import type { Kysely } from 'kysely';
import type { BookingConfig } from '../../src/appointments/booking.config.js';
import { PostgresBookingStore, type BookingStore } from '../../src/appointments/booking.store.js';
import { BOOKING_CONFIG, BOOKING_STORE, CLOCK } from '../../src/appointments/booking.tokens.js';
import { DATABASE } from '../../src/common/database.module.js';
import { configureApp } from '../../src/common/configure-app.js';
import type { Database } from '../../src/db/types.js';
import type { Clock } from '../../src/scheduling/index.js';

// Helpers for the e2e tests: the real AppModule, configured the same way as
// main.ts, on a test database.

// A clock a test can move. FixedClock can't, and AC-16's horizon rows need
// their own "now". Reset it after each test that moves it.
export class SettableClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }

  set(instant: Date): void {
    this.instant = instant;
  }
}

export interface BootOptions {
  databaseUrl: string;
  clock: Clock;
  // Swaps the Postgres store, for the cases a real database can't produce
  // on demand (a 503, an unexpected error).
  store?: BookingStore;
  // Wraps the real Postgres store instead of replacing it, so the wrapper
  // runs on the app's own pool and config. The HTTP race test puts its
  // barrier in here. Ignored when store is set.
  wrapStore?: (real: BookingStore) => BookingStore;
  // DB_POOL_SIZE for the app. 5 is plenty for one request at a time, a race
  // of N parallel requests needs more than N.
  poolSize?: number;
}

// The config comes from the environment like in production, so it has to be
// set before the module is compiled.
export async function bootApp(options: BootOptions): Promise<INestApplication> {
  process.env.DATABASE_URL = options.databaseUrl;
  process.env.DB_POOL_SIZE = String(options.poolSize ?? 5);

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(options.clock);
  if (options.store) {
    builder = builder.overrideProvider(BOOKING_STORE).useValue(options.store);
  } else if (options.wrapStore) {
    const wrap = options.wrapStore;
    builder = builder.overrideProvider(BOOKING_STORE).useFactory({
      inject: [DATABASE, BOOKING_CONFIG],
      factory: (db: Kysely<Database>, config: BookingConfig) =>
        wrap(new PostgresBookingStore(db, config)),
    });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

// Every error response, for any status, is problem+json with a stable code
// (AC-20, RFC 9457). Express adds a charset, so this only checks the start.
export function expectProblem(res: Response, status: number, code: string): void {
  expect({ status: res.status, code: res.body?.code }).toEqual({ status, code });
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.body).toEqual(
    expect.objectContaining({
      type: expect.any(String),
      title: expect.any(String),
      status,
      code,
      detail: expect.any(String),
    }),
  );
}

// The field names in a 400's errors list, in order.
export function errorFields(res: Response): string[] {
  const errors = (res.body?.errors ?? []) as { field: string; message: string }[];
  return errors.map((e) => e.field);
}
