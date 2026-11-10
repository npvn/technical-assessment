import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import { DATABASE } from '../../src/common/database.module.js';
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
import { SettableClock, bootApp, expectProblem, type BootOptions } from './app.js';

// Health, metrics and logs (AC-34 to AC-36) through the real
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

// bootApp with this file's clock. Every app here has the default pool size.
function boot(options: Omit<BootOptions, 'clock'>): Promise<INestApplication> {
  return bootApp({ ...options, clock });
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

  it('AC-36 the request line has only the method, the path, the id and the status, no headers or query string', async () => {
    // Free text a client chooses, which could hold anything. None of it may
    // reach the log, so the serializers keep a short list instead of
    // redacting a few headers.
    const markers = {
      idempotencyKey: 'secret-key-marker-123',
      userAgent: 'agent-marker-456',
      query: 'query-marker-789',
    };
    const car = await insertCustomerWithVehicle(testDb.db);
    const reqId = `ac36-${randomUUID()}`;
    logs.clear();

    await request(app.getHttpServer())
      .post(`/appointments?note=${markers.query}`)
      .set('X-Request-Id', reqId)
      .set('Idempotency-Key', markers.idempotencyKey)
      .set('User-Agent', markers.userAgent)
      .send(body(place, car, '2027-03-09T16:00:00Z'))
      .expect(201);

    const requestLine = await waitForLine(logs, isRequestLine(201));
    expect(requestLine?.req).toEqual({ id: reqId, method: 'POST', path: '/appointments' });
    expect(requestLine?.res).toEqual({ statusCode: 201 });

    const raw = logs.raw();
    expect(raw).not.toContain(markers.idempotencyKey);
    expect(raw).not.toContain(markers.userAgent);
    expect(raw).not.toContain(markers.query);
  });
});

// A port on this machine where nothing listens, so every connection the
// app tries is refused straight away. That's what a stopped or restarting
// Postgres looks like to the app.
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe('the database is gone', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const url = new URL(testDb.url);
    url.hostname = '127.0.0.1';
    url.port = String(await closedPort());
    app = await boot({ databaseUrl: url.toString() });
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  it('POST /appointments is 503 SERVICE_UNAVAILABLE with Retry-After, and counts as service_unavailable', async () => {
    const res = await http().post('/appointments').send({
      dealershipId: randomUUID(),
      serviceTypeId: randomUUID(),
      customerId: randomUUID(),
      vehicleId: randomUUID(),
      startTime: '2027-03-09T09:00:00Z',
    });

    expectProblem(res, 503, 'SERVICE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('1');
    expect(res.text).not.toContain('ECONNREFUSED');

    const metrics = (await http().get('/metrics')).text;
    expect(
      metricLine(metrics, 'booking_requests_total{outcome="service_unavailable"} 1'),
    ).toBeDefined();
  });

  it('GET /availability is 503 SERVICE_UNAVAILABLE with Retry-After', async () => {
    const res = await http()
      .get('/availability')
      .query({ dealershipId: randomUUID(), serviceTypeId: randomUUID(), date: '2027-03-09' });

    expectProblem(res, 503, 'SERVICE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('1');
  });
});

// Every connection in the pool is busy (here the only one, held by an open
// transaction). Without a connect timeout the request would queue forever,
// past every other budget. With one it gets a 503 and can try again.
describe('the pool has no free connection', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await boot({ databaseUrl: testDb.url, poolSize: 1, connectTimeoutMs: 300 });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('POST /appointments is 503 SERVICE_UNAVAILABLE with Retry-After, quickly', async () => {
    const place = await smallNorth();
    const car = await insertCustomerWithVehicle(testDb.db);
    const held = await app.get<Kysely<Database>>(DATABASE).startTransaction().execute();
    let post: Promise<unknown> = Promise.resolve();
    try {
      const started = performance.now();
      const sent = request(app.getHttpServer())
        .post('/appointments')
        .send(body(place, car, '2027-03-09T09:00:00Z'))
        .then((res) => res);
      post = sent.catch(() => {});
      // Without the timeout the request waits for the held connection, so
      // the test stops waiting after 3 s instead of hanging
      const res = await Promise.race([
        sent,
        new Promise<string>((resolve) => setTimeout(() => resolve('no answer after 3 s'), 3_000)),
      ]);

      expect(typeof res === 'string' ? res : { status: res.status, code: res.body?.code }).toEqual({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
      if (typeof res === 'string') return;
      expectProblem(res, 503, 'SERVICE_UNAVAILABLE');
      expect(res.headers['retry-after']).toBe('1');
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await held.rollback().execute();
      await post;
    }
  });
});

describe('AC-34 a database blip does not kill the process', () => {
  let app: INestApplication;
  // The app's connections carry this name, so the test can end exactly
  // those and not the ones its own pool holds.
  const applicationName = `blip_${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    const url = new URL(testDb.url);
    url.searchParams.set('application_name', applicationName);
    app = await boot({ databaseUrl: url.toString() });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AC-34 after Postgres ends the idle connections, live stays 200 and ready is 200 again', async () => {
    const http = () => request(app.getHttpServer());
    // Leaves one idle connection in the app's pool
    expect((await http().get('/health/ready')).status).toBe(200);

    // What a database restart or failover does to an idle connection
    const ended = await sql<{ ended: boolean }>`
      SELECT pg_terminate_backend(pid) AS ended
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
    `.execute(testDb.db);
    expect(ended.rows.length).toBeGreaterThan(0);
    // Gives pg time to see the dropped socket and emit its error
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect((await http().get('/health/live')).status).toBe(200);

    // The pool drops the dead connection and opens a new one, so ready
    // answers 200 again without a restart
    let ready = 0;
    for (let i = 0; i < 20 && ready !== 200; i++) {
      ready = (await http().get('/health/ready')).status;
      if (ready !== 200) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ready).toBe(200);
  });
});
