// Load script for PLAN.md step 11, run with `npm run load` against the API
// from `docker compose up`. Node runs this file directly (Node 24 strips the
// types), so it imports nothing from src/ and sticks to syntax Node can strip
// (no enums, no parameter properties).
//
// What it does, in order:
// 1. setup: loads scripts/load-fixtures.sql (a load customer with 500 cars)
//    and cancels whatever that customer still has booked from an earlier run,
//    so the burst starts on empty slots every time.
// 2. burst: many POST /appointments at once for the same few slots at London,
//    every request with a different car. Exactly as many 201s as there are
//    free bay and technician pairs, the rest 409, no 5xx.
// 3. steady: GET /availability and POST /appointments at about 20 to 1, at a
//    steady rate, then p50, p95 and p99 per endpoint against the A23 targets.
// 4. checks: scripts/check-overlaps.sql, and the booking and pool metrics.
//
// `npm run load -- burst` or `npm run load -- steady` runs one scenario.
// The env vars below change the target and the sizes. The exit code is 1 when
// the burst count is off, anything came back 5xx, a request errored or timed
// out, or the overlap check found a row. Missing a latency target is reported
// but doesn't fail the run, since one laptop says little about that.

import { readFile } from 'node:fs/promises';
import autocannon from 'autocannon';
import { DateTime } from 'luxon';
import pg from 'pg';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler';
const BURST_REQUESTS = intFromEnv('BURST_REQUESTS', 100);
const STEADY_SECONDS = intFromEnv('STEADY_SECONDS', 45);
// A23 peak: about 200 availability reads and 10 bookings a second
const STEADY_GET_RATE = intFromEnv('STEADY_GET_RATE', 200);
const STEADY_POST_RATE = intFromEnv('STEADY_POST_RATE', 10);

// A23 targets in milliseconds
const BOOKING_P95_TARGET_MS = 300;
const AVAILABILITY_P95_TARGET_MS = 200;

// Fixed ids from src/db/seed.ts and scripts/load-fixtures.sql
const LONDON = '11111111-1111-4111-8111-111111111111';
const OIL = '5e000000-0000-4000-8000-000000000001';
const OIL_SKILL = 'OIL_SERVICE';
const OIL_MINUTES = 60;
const SERVICE_TYPES = [1, 2, 3, 4, 5].map((n) => `5e000000-0000-4000-8000-00000000000${n}`);
const LOAD_CUSTOMER = '10ad0000-0000-4000-8000-000000000001';
const LOAD_VEHICLES = 500;
const loadVehicle = (n: number) =>
  `10ad0e00-0000-4000-8000-${String((n % LOAD_VEHICLES) + 1).padStart(12, '0')}`;

// Burst: three London OIL slots an hour apart, so they don't overlap each
// other, a week out so they miss the seed's busy day. Steady: weekdays from
// two weeks out to day 80, well inside the 90 day horizon.
const BURST_DAYS_AHEAD = 7;
const BURST_SLOTS = ['09:00', '10:00', '11:00'];
const STEADY_FIRST_DAY = 14;
const STEADY_LAST_DAY = 80;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a whole number of 1 or more, got "${raw}"`);
  }
  return value;
}

type Tally = Map<string, number>;

function bump(tally: Tally, key: string): void {
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

function printTally(label: string, tally: Tally): void {
  const keys = [...tally.keys()].sort();
  console.log(`${label}:`);
  for (const key of keys) console.log(`  ${key}: ${tally.get(key)}`);
}

// The problem body's code, so a 409 can be told apart from another 409
function problemCode(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'code' in parsed) {
      return String(parsed.code);
    }
  } catch {
    // not JSON, fall through
  }
  return 'no code';
}

function isoUtc(time: DateTime): string {
  return time.toUTC().toISO({ suppressMilliseconds: true }) ?? '';
}

// Nearest rank percentile. The list has to be sorted already.
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

function ms(value: number): string {
  return Number.isNaN(value) ? '-' : `${value.toFixed(1)} ms`;
}

let failed = false;
function fail(reason: string): void {
  failed = true;
  console.log(`FAIL: ${reason}`);
}

// Setup

async function setup(db: pg.Client): Promise<void> {
  console.log('== setup: load fixtures');
  await db.query(await readFile(new URL('./load-fixtures.sql', import.meta.url), 'utf8'));
  const vehicles = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM vehicles WHERE customer_id = $1',
    [LOAD_CUSTOMER],
  );
  console.log(`load customer ${LOAD_CUSTOMER} has ${vehicles.rows[0]?.n} vehicles`);

  // Cancel rather than delete, so the rows from earlier runs are still there
  // to look at. Cancelled rows hold nothing, for the constraints and for the
  // overlap check.
  const reset = await db.query(
    "UPDATE appointments SET status = 'cancelled' WHERE customer_id = $1 AND status <> 'cancelled'",
    [LOAD_CUSTOMER],
  );
  console.log(`cancelled ${reset.rowCount} active appointments left from an earlier load run`);
}

// Burst

// Free bays and free OIL technicians at London for one slot, worked out in
// SQL the same way as check-overlaps.sql. The expected number of 201s for the
// slot is the smaller of the two.
async function freePairs(db: pg.Client, start: DateTime): Promise<number> {
  const end = start.plus({ minutes: OIL_MINUTES });
  const result = await db.query<{ bays: string; techs: string }>(
    `SELECT
       (SELECT count(*) FROM service_bays sb
         WHERE sb.dealership_id = $1
           AND NOT EXISTS (SELECT 1 FROM appointments a
                            WHERE a.service_bay_id = sb.id AND a.status <> 'cancelled'
                              AND a.starts_at < $3 AND $2 < a.ends_at)) AS bays,
       (SELECT count(*) FROM technicians t
         WHERE t.dealership_id = $1
           AND EXISTS (SELECT 1 FROM technician_skills ts
                        WHERE ts.technician_id = t.id AND ts.skill_code = $4)
           AND NOT EXISTS (SELECT 1 FROM appointments a
                            WHERE a.technician_id = t.id AND a.status <> 'cancelled'
                              AND a.starts_at < $3 AND $2 < a.ends_at)) AS techs`,
    [LONDON, isoUtc(start), isoUtc(end), OIL_SKILL],
  );
  const row = result.rows[0]!;
  return Math.min(Number(row.bays), Number(row.techs));
}

function nextWeekdayFrom(zone: string, daysAhead: number): DateTime {
  let day = DateTime.now().setZone(zone).startOf('day').plus({ days: daysAhead });
  while (day.weekday > 5) day = day.plus({ days: 1 });
  return day;
}

async function burst(db: pg.Client): Promise<void> {
  console.log(`\n== burst: ${BURST_REQUESTS} parallel POST /appointments, London OIL`);
  const day = nextWeekdayFrom('Europe/London', BURST_DAYS_AHEAD);
  const slots = BURST_SLOTS.map((hhmm) => {
    const [hour, minute] = hhmm.split(':').map(Number);
    return day.set({ hour, minute });
  });

  let expected = 0;
  for (const slot of slots) {
    const pairs = await freePairs(db, slot);
    console.log(`slot ${isoUtc(slot)}: ${pairs} free bay and technician pairs`);
    expected += pairs;
  }

  // One connection per request and one request per connection, so they all
  // go out together. The shared counter gives every request its own car.
  let sent = 0;
  const statuses: Tally = new Map();
  const result = await autocannon({
    url: API_URL,
    connections: BURST_REQUESTS,
    amount: BURST_REQUESTS,
    timeout: 30,
    requests: [
      {
        method: 'POST',
        path: '/appointments',
        setupRequest: (request) => {
          const n = sent++;
          return {
            ...request,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              customerId: LOAD_CUSTOMER,
              vehicleId: loadVehicle(n),
              dealershipId: LONDON,
              serviceTypeId: OIL,
              startTime: isoUtc(slots[n % slots.length]!),
            }),
          };
        },
        onResponse: (status, body) => {
          bump(statuses, status < 300 ? String(status) : `${status} ${problemCode(body)}`);
        },
      },
    ],
  });

  printTally('status counts', statuses);
  console.log(`errors: ${result.errors}, timeouts: ${result.timeouts}`);
  console.log(`latency: p50 ${result.latency.p50} ms, max ${result.latency.max} ms`);

  // The status tally says what the API answered. The table says what got
  // written. Both have to match the free pairs.
  const rows = await db.query<{ starts_at: Date; n: string }>(
    `SELECT starts_at, count(*) AS n FROM appointments
      WHERE customer_id = $1 AND status <> 'cancelled' AND starts_at = ANY($2::timestamptz[])
      GROUP BY starts_at ORDER BY starts_at`,
    [LOAD_CUSTOMER, slots.map(isoUtc)],
  );
  let written = 0;
  for (const row of rows.rows) {
    console.log(`rows in the table at ${row.starts_at.toISOString()}: ${row.n}`);
    written += Number(row.n);
  }

  const created = statuses.get('201') ?? 0;
  const fiveHundreds = [...statuses].filter(([key]) => key.startsWith('5'));
  const answered = [...statuses.values()].reduce((sum, n) => sum + n, 0);
  console.log(
    `expected 201: ${expected}, got 201: ${created}, rows written: ${written}, answered: ${answered}`,
  );
  if (created !== expected) fail(`burst got ${created} 201s, expected ${expected}`);
  if (written !== expected) fail(`burst wrote ${written} rows, expected ${expected}`);
  if (fiveHundreds.length > 0) fail('burst got 5xx answers');
  if (answered !== BURST_REQUESTS) fail(`burst got ${answered} answers for ${BURST_REQUESTS}`);
  if (result.errors > 0 || result.timeouts > 0) fail('burst had errors or timeouts');
}

// Steady

interface Dealership {
  id: string;
  zone: string;
  // iso weekday to [opens, closes] in minutes since local midnight
  hours: Map<number, [number, number]>;
}

async function loadDealerships(db: pg.Client): Promise<Dealership[]> {
  const result = await db.query<{
    id: string;
    time_zone: string;
    iso_weekday: number;
    opens: number;
    closes: number;
  }>(
    `SELECT d.id, d.time_zone, oh.iso_weekday,
            extract(epoch FROM oh.opens_at)::int / 60 AS opens,
            extract(epoch FROM oh.closes_at)::int / 60 AS closes
       FROM dealerships d JOIN opening_hours oh ON oh.dealership_id = d.id
      ORDER BY d.id, oh.iso_weekday`,
  );
  const byId = new Map<string, Dealership>();
  for (const row of result.rows) {
    const dealership = byId.get(row.id) ?? { id: row.id, zone: row.time_zone, hours: new Map() };
    dealership.hours.set(row.iso_weekday, [row.opens, row.closes]);
    byId.set(row.id, dealership);
  }
  return [...byId.values()];
}

// Monday to Friday local dates for one dealership in the steady window
function steadyDays(dealership: Dealership): DateTime[] {
  const today = DateTime.now().setZone(dealership.zone).startOf('day');
  const days: DateTime[] = [];
  for (let offset = STEADY_FIRST_DAY; offset <= STEADY_LAST_DAY; offset++) {
    const day = today.plus({ days: offset });
    if (day.weekday <= 5 && dealership.hours.has(day.weekday)) days.push(day);
  }
  return days;
}

interface Booking {
  dealershipId: string;
  startTime: string;
}

// Every dealership has two OIL technicians, so every full hour OIL slot takes
// two bookings. The list goes slot of the day, then day, then dealership, so
// requests next to each other land on different days and mostly don't race.
// The first pass takes one technician per slot and the second pass the other.
// About 50 weekdays, 3 dealerships and 8 or 9 slots a day is over 2,000
// targets, plenty for 450 bookings with most of them a 201.
function steadyBookings(dealerships: Dealership[]): Booking[] {
  // per dealership, per day, the OIL starts that fit before closing
  const grid = dealerships.map((dealership) =>
    steadyDays(dealership).map((day) => {
      const [opens, closes] = dealership.hours.get(day.weekday)!;
      const starts: string[] = [];
      for (let minute = opens; minute + OIL_MINUTES <= closes; minute += 60) {
        starts.push(isoUtc(day.set({ hour: Math.floor(minute / 60), minute: minute % 60 })));
      }
      return starts;
    }),
  );
  const maxDays = Math.max(...grid.map((days) => days.length));
  const maxSlots = Math.max(...grid.flat().map((starts) => starts.length));

  const onePass: Booking[] = [];
  for (let slot = 0; slot < maxSlots; slot++) {
    for (let day = 0; day < maxDays; day++) {
      grid.forEach((days, i) => {
        const startTime = days[day]?.[slot];
        if (startTime) onePass.push({ dealershipId: dealerships[i]!.id, startTime });
      });
    }
  }
  return [...onePass, ...onePass];
}

interface Endpoint {
  latencies: Map<number, number[]>;
  statuses: Tally;
}

function endpoint(): Endpoint {
  return { latencies: new Map(), statuses: new Map() };
}

// Hooks every connection of an autocannon run up to one Endpoint, so the two
// runs that go at the same time keep their numbers apart. The response event
// carries the status and the time, the body comes through onResponse.
function recordInto(target: Endpoint) {
  return (client: autocannon.Client) => {
    client.on('response', (status, _bytes, time) => {
      const list = target.latencies.get(status) ?? [];
      list.push(time);
      target.latencies.set(status, list);
    });
  };
}

function report(name: string, target: Endpoint, seconds: number, rate: number, goal: number) {
  const all = [...target.latencies.values()].flat().sort((a, b) => a - b);
  const p95 = percentile(all, 95);
  console.log(
    `\n${name}: ${all.length} answers, ${(all.length / seconds).toFixed(1)}/s (asked ${rate}/s)`,
  );
  console.log(
    `  all:  p50 ${ms(percentile(all, 50))}, p95 ${ms(p95)}, p99 ${ms(percentile(all, 99))}, max ${ms(all.at(-1) ?? Number.NaN)}`,
  );
  for (const [status, list] of [...target.latencies].sort(([a], [b]) => a - b)) {
    const sorted = [...list].sort((a, b) => a - b);
    console.log(
      `  ${status}: ${sorted.length} answers, p50 ${ms(percentile(sorted, 50))}, p95 ${ms(percentile(sorted, 95))}, p99 ${ms(percentile(sorted, 99))}`,
    );
  }
  printTally('  status counts', target.statuses);
  const verdict = p95 < goal ? 'meets' : 'MISSES';
  console.log(`  p95 ${ms(p95)} ${verdict} the A23 target of under ${goal} ms`);
}

// autocannon's rate limit works per connection and per second: when a new
// second starts the connection sends its quota back to back, then waits. With
// many connections on one instance those seconds line up, so the "steady"
// load really arrives as one burst at the top of every second (I saw that in
// a first try, 40 reads a second gave a p50 over 200 ms on a server that
// answers one read in about 16 ms). So this runs several one connection
// instances instead and starts them spread over the first second. Each one
// sends a small train every second, and the trains are spread out.
interface PacedRun {
  seconds: number;
  errors: number;
  timeouts: number;
}

async function paced(
  rate: number,
  target: Endpoint,
  request: autocannon.Request,
): Promise<PacedRun> {
  const instances = Math.min(rate, 50);
  const runs: Promise<autocannon.Result>[] = [];
  for (let i = 0; i < instances; i++) {
    // Share out the rate as whole numbers, the first few take one more
    const connectionRate = Math.floor(rate / instances) + (i < rate % instances ? 1 : 0);
    runs.push(
      new Promise((resolve) => setTimeout(resolve, (i * 1000) / instances)).then(() =>
        autocannon({
          url: API_URL,
          connections: 1,
          connectionRate,
          duration: STEADY_SECONDS,
          timeout: 10,
          setupClient: recordInto(target),
          requests: [request],
        }),
      ),
    );
  }
  const results = await Promise.all(runs);
  return {
    seconds: STEADY_SECONDS,
    errors: results.reduce((sum, r) => sum + r.errors, 0),
    timeouts: results.reduce((sum, r) => sum + r.timeouts, 0),
  };
}

async function steady(db: pg.Client): Promise<void> {
  console.log(
    `\n== steady: ${STEADY_GET_RATE} GET /availability and ${STEADY_POST_RATE} POST /appointments a second for ${STEADY_SECONDS} s`,
  );
  const dealerships = await loadDealerships(db);
  const bookings = steadyBookings(dealerships);
  const dates = dealerships.map((d) => steadyDays(d).map((day) => day.toISODate() ?? ''));
  console.log(`${bookings.length} booking targets over ${dates.flat().length} dealership days`);

  // GETs walk through every dealership, service type and date in turn.
  // POSTs walk through the booking list, with the cars after the burst's.
  let gets = 0;
  let posts = 0;
  const availability = endpoint();
  const booking = endpoint();

  const getRun = paced(STEADY_GET_RATE, availability, {
    method: 'GET',
    setupRequest: (request) => {
      const n = gets++;
      const d = n % dealerships.length;
      const days = dates[d]!;
      const service = SERVICE_TYPES[Math.floor(n / dealerships.length) % SERVICE_TYPES.length];
      const date = days[Math.floor(n / (dealerships.length * SERVICE_TYPES.length)) % days.length];
      const query = new URLSearchParams({
        dealershipId: dealerships[d]!.id,
        serviceTypeId: service!,
        date: date!,
      });
      return { ...request, path: `/availability?${query.toString()}` };
    },
    onResponse: (status, body) => {
      bump(availability.statuses, status < 300 ? String(status) : `${status} ${problemCode(body)}`);
    },
  });

  const postRun = paced(STEADY_POST_RATE, booking, {
    method: 'POST',
    path: '/appointments',
    setupRequest: (request) => {
      const n = posts++;
      const target = bookings[n % bookings.length]!;
      return {
        ...request,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: LOAD_CUSTOMER,
          vehicleId: loadVehicle(BURST_REQUESTS + n),
          dealershipId: target.dealershipId,
          serviceTypeId: OIL,
          startTime: target.startTime,
        }),
      };
    },
    onResponse: (status, body) => {
      bump(booking.statuses, status < 300 ? String(status) : `${status} ${problemCode(body)}`);
    },
  });

  const [getResult, postResult] = await Promise.all([getRun, postRun]);
  report(
    'GET /availability',
    availability,
    getResult.seconds,
    STEADY_GET_RATE,
    AVAILABILITY_P95_TARGET_MS,
  );
  console.log(`  errors: ${getResult.errors}, timeouts: ${getResult.timeouts}`);
  report(
    'POST /appointments',
    booking,
    postResult.seconds,
    STEADY_POST_RATE,
    BOOKING_P95_TARGET_MS,
  );
  console.log(`  errors: ${postResult.errors}, timeouts: ${postResult.timeouts}`);

  for (const [name, target] of [
    ['availability', availability],
    ['booking', booking],
  ] as const) {
    if ([...target.statuses.keys()].some((key) => key.startsWith('5'))) {
      fail(`steady ${name} got 5xx answers`);
    }
  }
  if (getResult.errors + getResult.timeouts + postResult.errors + postResult.timeouts > 0) {
    fail('steady had errors or timeouts');
  }
}

// Checks at the end

async function checkOverlaps(db: pg.Client): Promise<void> {
  console.log('\n== check-overlaps.sql');
  const sql = await readFile(new URL('./check-overlaps.sql', import.meta.url), 'utf8');
  const result = await db.query<Record<string, unknown>>(sql);
  console.log(`${result.rows.length} rows`);
  for (const row of result.rows) console.log(JSON.stringify(row));
  if (result.rows.length > 0) fail('check-overlaps found rows');
}

const METRIC_PREFIXES = [
  'booking_requests_total',
  'booking_contended_total',
  'db_pool_total_connections',
  'db_pool_idle_connections',
  'db_pool_waiting_clients',
];

// The metric lines we care about, as "name{labels}" to value
async function scrapeMetrics(): Promise<Map<string, number>> {
  const response = await fetch(`${API_URL}/metrics`);
  const text = await response.text();
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !METRIC_PREFIXES.some((p) => line.startsWith(p))) continue;
    const space = line.lastIndexOf(' ');
    values.set(line.slice(0, space), Number(line.slice(space + 1)));
  }
  return values;
}

// Counters only go up for the life of the API process, so the run's share is
// after minus before. The pool gauges come from two scrapes: one the moment
// the load stops, while the API is still busy with what it had in flight, and
// one after it has gone idle.
function printMetrics(
  before: Map<string, number>,
  atStop: Map<string, number>,
  after: Map<string, number>,
): void {
  console.log('\n== /metrics');
  for (const [key, value] of after) {
    if (!key.startsWith('db_pool_')) {
      console.log(`${key} ${value} (this run: ${value - (before.get(key) ?? 0)})`);
    }
  }
  for (const [key, value] of after) {
    if (key.startsWith('db_pool_')) {
      console.log(`${key} ${atStop.get(key) ?? '-'} when the load stopped, ${value} after`);
    }
  }
  // A labelled counter has no line at all until something counts, so say so
  // instead of leaving it out without a word
  for (const prefix of METRIC_PREFIXES) {
    if (![...after.keys()].some((key) => key.startsWith(prefix))) {
      console.log(`${prefix}: no samples, nothing counted since the API started`);
    }
  }
}

// When a timed autocannon run stops it closes its sockets, but the API still
// finishes the requests it had in flight, and a booking among them still gets
// written. Without this wait the overlap check could run before those rows
// land. Done means every pool connection idle and nobody waiting, twice in a
// row half a second apart. It gives up after 15 s and says so.
async function waitForApiToSettle(): Promise<void> {
  const deadline = Date.now() + 15_000;
  let quietReadings = 0;
  while (Date.now() < deadline) {
    const gauges = await scrapeMetrics();
    const total = gauges.get('db_pool_total_connections');
    const idle = gauges.get('db_pool_idle_connections');
    const waiting = gauges.get('db_pool_waiting_clients');
    quietReadings = total === idle && waiting === 0 ? quietReadings + 1 : 0;
    if (quietReadings >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log('the API was still busy after 15 s, checking anyway');
}

async function main(): Promise<void> {
  const scenario = process.argv[2] ?? 'all';
  if (!['all', 'burst', 'steady'].includes(scenario)) {
    throw new Error(`unknown scenario "${scenario}", use all, burst or steady`);
  }
  const db = new pg.Client({ connectionString: DATABASE_URL });
  // Without a listener, the database going away (someone stops it mid burst
  // to see what happens) would crash the script on an unhandled error event.
  // This way the query that was running fails and says why.
  db.on('error', (error) => {
    console.log(`database connection error: ${error.message}`);
  });
  await db.connect();
  try {
    await setup(db);
    const before = await scrapeMetrics();
    if (scenario !== 'steady') await burst(db);
    if (scenario !== 'burst') await steady(db);
    const atStop = await scrapeMetrics();
    await waitForApiToSettle();
    await checkOverlaps(db);
    printMetrics(before, atStop, await scrapeMetrics());
  } finally {
    await db.end();
  }
  console.log(failed ? '\nload run: FAILED' : '\nload run: OK');
  process.exitCode = failed ? 1 : 0;
}

await main();
