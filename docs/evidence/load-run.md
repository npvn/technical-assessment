# Load run and overlap check

Everything here ran on one laptop with Docker: Postgres, one API process and the load generator on the same CPUs, no network in between. So it says the service holds up under this kind of traffic and how the latency looks here, it's not a capacity test.

## The tools

- `npm run load -- burst` - 100 `POST /appointments` at once, London OIL, three slots an hour apart, every request with a different car. Before it fires it works out the free bay and technician pairs per slot in SQL, and after it checks the status counts and the rows written against that number.
- `npm run load -- steady` - `GET /availability` and `POST /appointments` at 20 to 1 for 45 s (defaults 200 and 10 a second, the A23 peak). It prints p50, p95 and p99 per endpoint against A23.
- After each run the script waits for the API to go idle, runs `scripts/check-overlaps.sql`, and prints the `/metrics` counters. It exits 1 on a wrong burst count, any 5xx, an error or timeout, or an overlap row.
- `scripts/check-overlaps.sql` lists every pair of active appointments that overlap on the same bay, technician or vehicle, plus any appointment whose bay or technician belongs to another dealership. It doesn't use the constraints or `tstzrange`, just a self join on `a.starts_at < b.ends_at AND b.starts_at < a.ends_at`, so it checks them from the outside.

Proof the check finds things: in a scratch database I dropped the three exclusion constraints and the two composite foreign keys, then planted a bay overlap, a technician overlap, a vehicle overlap, two appointments on another dealership's bay (one of them cancelled) and one on another dealership's technician. I also planted two pairs that must not show: one touching at 18:00, and one overlapping where one side is cancelled. Empty, it gave `(0 rows)`. Planted (cut down to two columns):

```
              problem               |            appointment_id
------------------------------------+--------------------------------------
 bay from another dealership        | a0000000-0000-4000-8000-000000000011
 bay from another dealership        | a0000000-0000-4000-8000-000000000013
 bay overlap                        | a0000000-0000-4000-8000-000000000001
 technician from another dealership | a0000000-0000-4000-8000-000000000012
 technician overlap                 | a0000000-0000-4000-8000-000000000003
 vehicle overlap                    | a0000000-0000-4000-8000-000000000005
(6 rows)
```

Each planted case shows up once and neither negative does. Pointing the load script at that scratch database made it end with `FAIL: check-overlaps found rows` and `exit=1`.

## The first run missed the targets

`npm run load` at the A23 peak. The burst was right (6 created for 6 free pairs, 94 `SLOT_UNAVAILABLE`, 0 overlap rows), but the steady part wasn't close:

```
GET /availability: 3201 answers, 71.1/s (asked 200/s)
  p95 809.7 ms MISSES the A23 target of under 200 ms
POST /appointments: 420 answers, 9.3/s (asked 10/s)
  p95 1223.3 ms MISSES the A23 target of under 300 ms
```

`docker stats` 25 s in showed the API container at 98.24% CPU and Postgres at 13.41%. At a fifth of the rate (40 and 2 a second) both p95s were fine (32.1 ms and 93.6 ms), so this was queueing on CPU, not slow queries.

## The cause: computeSlots

`autocannon -c 20 -d 5` gave about 4,300 requests a second on `/health/live` and 72.8 on `/availability`, so the framework was fine and one availability read cost roughly 14 ms of CPU. Timing `computeSlots` on its own gave about 9 to 9.5 ms per call for an ordinary London day. It walked all 96 starts of the local day and sent each one through `checkBookingTime`, which does several Luxon zone conversions per start, even for 03:00 when the dealership opens at 08:00.

## The fix

- `src/availability/compute-slots.ts` works out once per day which starts can fall inside the opening window and only walks those. Every start it keeps still goes through `checkBookingTime`. On a clock change day the bounds use the biggest and smallest offset of the day, so they can let a start too many through but never leave one out. Odd cases (a badly formed opening time, a local date the zone skipped) fall back to the whole day.
- `src/scheduling/opening-hours.ts` compares `start.toISODate()` with `end.toISODate()` instead of Luxon's `hasSame(end, 'day')`. That was the most expensive thing done per start, and it was also wrong on one night in Havana: on Sat 31 October 2026 midnight happens twice, and a 23:45 booking got through. A unit test went red on it first.

`computeSlots` for the London day went from about 9.5 ms to 1.4 ms per call. The first part alone took the steady run to 165.5 reads a second with p95s of 333.0 ms and 467.1 ms, still a miss. To check the slot lists didn't change, I compared the old walk and the new one over every day of 2026 and 2027 in eight zones (23,360 inputs each) and the days around every offset change in all 418 zones, 0 differences.

## Final run, on the finished code

A fresh `docker compose up -d --build --wait`, then `npm run load -- burst` and `npm run load -- steady`, one run each.

Burst: 6 created, 94 `SLOT_UNAVAILABLE`, no 5xx, check-overlaps 0 rows.

Steady, 45 s at the A23 peak (200 reads and 10 bookings a second):

| Endpoint           | Achieved                       | p50     | p95     | p99     | max      | A23 target            |
| ------------------ | ------------------------------ | ------- | ------- | ------- | -------- | --------------------- |
| GET /availability  | 200.0/s, 9000 answers, all 200 | 6.3 ms  | 14.6 ms | 39.2 ms | 67.0 ms  | p95 under 200 ms, met |
| POST /appointments | 10.0/s, 450 answers, all 201   | 18.5 ms | 41.3 ms | 85.3 ms | 102.3 ms | p95 under 300 ms, met |

0 errors, 0 timeouts, check-overlaps 0 rows, `db_pool_waiting_clients` 0 when the load stopped, no `booking_contended_total` samples.

Limits: one laptop, one API process with the default pool of 10, one 45 s run, and load dates two weeks or more out, so most days are empty apart from what the run books. It says the design holds at the A23 envelope, not what a production box can take.
