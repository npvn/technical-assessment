import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import { AppModule } from '../../src/app.module.js';
import type { BookingConfig } from '../../src/appointments/booking.config.js';
import { PostgresBookingStore, type BookingStore } from '../../src/appointments/booking.store.js';
import { BOOKING_CONFIG, BOOKING_STORE, CLOCK } from '../../src/appointments/booking.tokens.js';
import { configureApp } from '../../src/common/configure-app.js';
import { DATABASE } from '../../src/common/database.module.js';
import { LOG_DESTINATION } from '../../src/common/logging.module.js';
import type { Database } from '../../src/db/types.js';
import { databaseUrl } from '../support/database-url.js';
import { insertCustomerWithVehicle } from '../support/fixtures.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import {
  NORTH,
  NOW,
  insertServiceTypes,
  newWorld,
  type Car,
  type Place,
  type ServiceTypes,
} from '../integration/appointments/world.js';
import { SettableClock, expectProblem } from './app.js';

// Health, metrics and logs (step 7, AC-34 to AC-36) through the real
// AppModule. Each describe boots its own app, so the counters start at zero
// and "exactly 1" really means one request. That also only works if every
// app has its own metrics registry, not the process wide default one.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let testDb: TestDatabase;
let types: ServiceTypes;
const clock = new SettableClock(NOW);

beforeAll(async () => {
  testDb = await createTestDatabase();
  types = await insertServiceTypes(testDb.db);
});

afterAll(async () => {
  await testDb?.destroy();
});

// Collects everything the app logs, one parsed JSON object per line.
class LogCapture extends Writable {
  private text = '';

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.text += chunk.toString();
    done();
  }

  raw(): string {
    return this.text;
  }

  lines(): Record<string, unknown>[] {
    return this.text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  clear(): void {
    this.text = '';
  }
}

interface ObservedBoot {
  databaseUrl: string;
  logs?: LogCapture;
  wrapStore?: (real: BookingStore) => BookingStore;
}

// Same as bootApp in app.ts, plus a way to swap the log destination, which
// AC-36 needs to read the log lines back.
async function boot(options: ObservedBoot): Promise<INestApplication> {
  process.env.DATABASE_URL = options.databaseUrl;
  process.env.DB_POOL_SIZE = '5';

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock);
  if (options.logs) {
    builder = builder.overrideProvider(LOG_DESTINATION).useValue(options.logs);
  }
  if (options.wrapStore) {
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

// North with one bay and one OIL technician, so a second booking at the
// same time is a 409 SLOT_UNAVAILABLE.
async function smallNorth(): Promise<Place> {
  return newWorld(testDb.db, types).place(NORTH, {
    name: 'North',
    bays: 1,
    technicians: [['OIL_SERVICE']],
  });
}

function body(place: Place, car: Car, startTime: string) {
  return {
    dealershipId: place.id,
    serviceTypeId: types.oil,
    customerId: car.customerId,
    vehicleId: car.vehicleId,
    startTime,
  };
}

// The whole exposition line, so `booking_requests_total{outcome="created"} 1`
// can't match a 10 or a line with more labels. prom-client prints labels in
// the order the code passed them, so both sides get their labels sorted
// first and the order doesn't matter.
function metricLine(text: string, line: string): string | undefined {
  const wanted = sortLabels(line);
  return text.split('\n').find((l) => sortLabels(l) === wanted);
}

function sortLabels(line: string): string {
  const match = /^([^{\s]+)\{(.*)\} (\S+)$/.exec(line);
  if (!match) return line;
  const [, name, labels = '', value] = match;
  const pairs = [...labels.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((m) => m[0]).sort();
  return `${name}{${pairs.join(',')}} ${value}`;
}

function sample(text: string, name: string): string | undefined {
  return text.split('\n').find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
}

// pino-http writes the request line when the response finishes, which can be
// a moment after supertest has the response. Polls briefly for it.
async function waitForLine(
  logs: LogCapture,
  match: (line: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 50; i++) {
    const found = logs.lines().find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

describe('AC-34 health', () => {
  let app: INestApplication;
  let broken: INestApplication;

  beforeAll(async () => {
    app = await boot({ databaseUrl: testDb.url });
    // The same server, but a database that doesn't exist. Every query on
    // this app's pool fails, like a database that has gone away.
    broken = await boot({
      databaseUrl: databaseUrl(testDb.url, `missing_${randomBytes(6).toString('hex')}`),
    });
  });

  afterAll(async () => {
    await app?.close();
    await broken?.close();
  });

  it('AC-34 GET /health/ready is 200 when the database answers', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(200);
  });

  it('AC-34 GET /health/ready is 503 problem+json when the database does not answer', async () => {
    const res = await request(broken.getHttpServer()).get('/health/ready');

    expectProblem(res, 503, 'SERVICE_UNAVAILABLE');
  });

  it('AC-34 GET /health/live is 200', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');

    expect(res.status).toBe(200);
  });

  it('AC-34 GET /health/live is 200 even when the database is gone, it never touches it', async () => {
    const res = await request(broken.getHttpServer()).get('/health/live');

    expect(res.status).toBe(200);
  });
});

describe('AC-35 metrics', () => {
  let app: INestApplication;
  let metricsResponse: Response;
  let metrics: string;

  beforeAll(async () => {
    app = await boot({ databaseUrl: testDb.url });
    const http = () => request(app.getHttpServer());
    const place = await smallNorth();
    const first = await insertCustomerWithVehicle(testDb.db);
    const second = await insertCustomerWithVehicle(testDb.db);

    const created = await http()
      .post('/appointments')
      .send(body(place, first, '2027-03-09T09:00:00Z'))
      .expect(201);
    const taken = await http()
      .post('/appointments')
      .send(body(place, second, '2027-03-09T09:00:00Z'));
    expectProblem(taken, 409, 'SLOT_UNAVAILABLE');
    // One GET too, to see the route label use the route and not the id
    await http().get(`/appointments/${created.body.id}`).expect(200);

    metricsResponse = await http().get('/metrics');
    metrics = metricsResponse.text;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AC-35 GET /metrics is 200 in the Prometheus text format', () => {
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('AC-35 booking_requests_total is exactly 1 for created and 1 for slot_unavailable', () => {
    expect(metricLine(metrics, 'booking_requests_total{outcome="created"} 1')).toBeDefined();
    expect(
      metricLine(metrics, 'booking_requests_total{outcome="slot_unavailable"} 1'),
    ).toBeDefined();
  });

  it('AC-35 has booking_contended_total, the booking_attempts histogram, booking_lost_races_total and the booking_duration_seconds histogram', () => {
    // No 503 yet, so the labelled counter has its TYPE line but no sample
    expect(metricLine(metrics, '# TYPE booking_contended_total counter')).toBeDefined();
    expect(metricLine(metrics, '# TYPE booking_attempts histogram')).toBeDefined();
    expect(metricLine(metrics, 'booking_attempts_count 2')).toBeDefined();
    expect(metricLine(metrics, '# TYPE booking_lost_races_total counter')).toBeDefined();
    expect(metricLine(metrics, 'booking_lost_races_total 0')).toBeDefined();
    expect(metricLine(metrics, '# TYPE booking_duration_seconds histogram')).toBeDefined();
    expect(metricLine(metrics, 'booking_duration_seconds_count 2')).toBeDefined();
  });

  it('counts HTTP requests by method, route and status, and has a duration histogram', () => {
    expect(
      metricLine(
        metrics,
        'http_requests_total{method="POST",route="/appointments",status="201"} 1',
      ),
    ).toBeDefined();
    expect(
      metricLine(
        metrics,
        'http_requests_total{method="POST",route="/appointments",status="409"} 1',
      ),
    ).toBeDefined();
    expect(
      metricLine(
        metrics,
        'http_requests_total{method="GET",route="/appointments/:id",status="200"} 1',
      ),
    ).toBeDefined();
    expect(metricLine(metrics, '# TYPE http_request_duration_seconds histogram')).toBeDefined();
  });

  it('has the connection pool gauges: total, idle and waiting', () => {
    for (const name of [
      'db_pool_total_connections',
      'db_pool_idle_connections',
      'db_pool_waiting_clients',
    ]) {
      expect(metricLine(metrics, `# TYPE ${name} gauge`)).toBeDefined();
      expect(sample(metrics, name)).toMatch(new RegExp(`^${name} \\d+$`));
    }
  });

  it('has the default Node process metrics', () => {
    expect(metricLine(metrics, '# TYPE process_cpu_user_seconds_total counter')).toBeDefined();
    expect(metricLine(metrics, '# TYPE nodejs_eventloop_lag_seconds gauge')).toBeDefined();
  });
});

describe('AC-35 a 503 counts its reason', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // The real lookups, so the request gets past the 404s and 422s, then
    // every attempt fails the way an overloaded database does.
    app = await boot({
      databaseUrl: testDb.url,
      wrapStore: (real) => ({
        lookup: (req) => real.lookup(req),
        runAttempt: () =>
          Promise.reject(
            Object.assign(new Error('canceling statement due to statement timeout'), {
              code: '57014',
            }),
          ),
      }),
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AC-35 booking_contended_total{reason="statement_timeout"} is 1 and the outcome is booking_contended', async () => {
    const http = () => request(app.getHttpServer());
    const place = await smallNorth();
    const car = await insertCustomerWithVehicle(testDb.db);

    const res = await http()
      .post('/appointments')
      .send(body(place, car, '2027-03-09T09:00:00Z'));
    expectProblem(res, 503, 'BOOKING_CONTENDED');

    const metrics = (await http().get('/metrics')).text;
    expect(
      metricLine(metrics, 'booking_contended_total{reason="statement_timeout"} 1'),
    ).toBeDefined();
    expect(
      metricLine(metrics, 'booking_requests_total{outcome="booking_contended"} 1'),
    ).toBeDefined();
  });
});

describe('AC-36 request id and logs', () => {
  let app: INestApplication;
  const logs = new LogCapture();
  let place: Place;

  // Made up, but distinctive, so a leak can't hide behind a common value
  const CUSTOMER = {
    name: 'Ottoline Quarrington',
    email: 'ottoline.quarrington@example.test',
    vin: 'WVWZZZ1JZXW361742',
  };

  beforeAll(async () => {
    app = await boot({ databaseUrl: testDb.url, logs });
    place = await smallNorth();
  });

  afterAll(async () => {
    await app?.close();
  });

  const isRequestLine = (status: number) => (line: Record<string, unknown>) =>
    (line.res as { statusCode?: number } | undefined)?.statusCode === status;
  const isBookingLine = (line: Record<string, unknown>) => 'outcome' in line;

  it('AC-36 the sent X-Request-Id is echoed and is reqId on every line, with one booking line and no name, email or VIN', async () => {
    const car = await insertCustomerWithVehicle(testDb.db, CUSTOMER);
    const reqId = `ac36-${randomUUID()}`;
    logs.clear();

    const res = await request(app.getHttpServer())
      .post('/appointments')
      .set('X-Request-Id', reqId)
      .send(body(place, car, '2027-03-09T11:00:00Z'))
      .expect(201);

    expect(res.headers['x-request-id']).toBe(reqId);

    const requestLine = await waitForLine(logs, isRequestLine(201));
    expect(requestLine?.reqId).toBe(reqId);

    const bookingLines = logs.lines().filter(isBookingLine);
    expect(bookingLines).toEqual([
      expect.objectContaining({
        reqId,
        dealershipId: place.id,
        serviceTypeId: types.oil,
        outcome: 'created',
        attempts: 1,
        lostRaces: 0,
        durationMs: expect.any(Number),
      }),
    ]);
    // Nothing logged during the request is missing the id
    expect(logs.lines().map((line) => line.reqId)).toEqual(logs.lines().map(() => reqId));

    // The lines above prove something was captured, so this can't pass on
    // an empty log
    const raw = logs.raw();
    expect(raw).not.toContain(CUSTOMER.name);
    expect(raw).not.toContain(CUSTOMER.email);
    expect(raw).not.toContain(CUSTOMER.vin);
  });

  it('AC-36 with no X-Request-Id a generated UUID is in the response and on the log lines', async () => {
    const car = await insertCustomerWithVehicle(testDb.db);
    logs.clear();

    const res = await request(app.getHttpServer())
      .post('/appointments')
      .send(body(place, car, '2027-03-09T13:00:00Z'))
      .expect(201);

    const generated = res.headers['x-request-id'];
    expect(generated).toEqual(expect.stringMatching(UUID));

    const requestLine = await waitForLine(logs, isRequestLine(201));
    expect(requestLine?.reqId).toBe(generated);
    expect(logs.lines().filter(isBookingLine)).toEqual([
      expect.objectContaining({ reqId: generated, outcome: 'created' }),
    ]);
  });

  it.each([
    ['too long', 'x'.repeat(300)],
    ['has spaces and quotes', 'not "a" sane id'],
  ])('AC-36 an X-Request-Id that %s is replaced with a generated UUID', async (_why, sent) => {
    logs.clear();

    // Any route that exists will do. This one is a 404 for an unknown id.
    const res = await request(app.getHttpServer())
      .get(`/appointments/${randomUUID()}`)
      .set('X-Request-Id', sent);
    expect(res.status).toBe(404);

    const generated = res.headers['x-request-id'];
    expect(generated).toEqual(expect.stringMatching(UUID));
    const requestLine = await waitForLine(logs, isRequestLine(404));
    expect(requestLine?.reqId).toBe(generated);
  });

  it('AC-36 a 409 logs its error code as the outcome', async () => {
    // The first car takes the only bay and technician at 15:00, then a
    // second car asks for the same time
    const first = await insertCustomerWithVehicle(testDb.db);
    const second = await insertCustomerWithVehicle(testDb.db);
    await request(app.getHttpServer())
      .post('/appointments')
      .send(body(place, first, '2027-03-09T15:00:00Z'))
      .expect(201);
    await waitForLine(logs, isRequestLine(201));
    const reqId = `ac36-${randomUUID()}`;
    logs.clear();

    const res = await request(app.getHttpServer())
      .post('/appointments')
      .set('X-Request-Id', reqId)
      .send(body(place, second, '2027-03-09T15:00:00Z'));
    expectProblem(res, 409, 'SLOT_UNAVAILABLE');

    await waitForLine(logs, isRequestLine(409));
    expect(logs.lines().filter(isBookingLine)).toEqual([
      expect.objectContaining({
        reqId,
        outcome: 'SLOT_UNAVAILABLE',
        attempts: 1,
        lostRaces: 0,
      }),
    ]);
  });
});
