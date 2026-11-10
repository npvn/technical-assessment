# Unified Service Scheduler

A backend that books a service appointment for a car. You ask for a vehicle, a service type, a dealership and a start time. It books only if a service bay and a technician with the right skill are both free for the whole length of the job, and then saves the appointment.

The hard part is not the CRUD. It's two customers asking for the last free slot at the same moment, opening hours in the dealership's own time zone, and retries that must not book twice. Most of the work went there.

- NestJS 12 and TypeScript on Node 24, PostgreSQL 16, Kysely for queries, plain SQL migrations
- The database is the guarantee against double booking (three exclusion constraints). The service only gives a friendly answer before the database would say no.
- REST API with OpenAPI at `/docs`, errors as `application/problem+json` with a stable `code`

## Where to look (reviewer's guide)

If you only have 15 minutes, this is the order I'd read things in:

1. [docs/DESIGN.md](docs/DESIGN.md) - the system design: architecture diagram, components, data flow, tech choices, observability, and section 12 on how agents helped in the design phase.
2. [docs/adr/001-no-double-booking.md](docs/adr/001-no-double-booking.md) - how double bookings are stopped, and why the database does it and not the code.
3. [src/db/migrations/0002_booking_constraints.sql](src/db/migrations/0002_booking_constraints.sql) - the rules that actually stop double bookings, in under 100 lines of SQL.
4. [src/appointments/booking.service.ts](src/appointments/booking.service.ts) - the booking loop.
5. [test/integration/appointments/concurrency.test.ts](test/integration/appointments/concurrency.test.ts) - the race tests, and [docs/evidence/teeth-checks.md](docs/evidence/teeth-checks.md) for the proof they fail without the constraints.
6. The AI collaboration narrative at the end of this file, and the evidence in [docs/evidence/](docs/evidence/).

The rest of the docs:

- [docs/BRIEF.md](docs/BRIEF.md) - the task as I understood it
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) - A1 to A23, every guess I made where the brief was open
- [docs/SPEC.md](docs/SPEC.md) - acceptance criteria AC-01 to AC-45 with concrete examples. Test names carry the AC id, so `grep -r "AC-23" test` finds the test for a rule.
- [docs/PLAN.md](docs/PLAN.md) - the build steps in priority order, with a cut line
- [docs/adr/](docs/adr/) - three decision records (double booking, time, the stack)

## Run it

You need Docker. Nothing else.

```bash
docker compose up --build
```

That starts Postgres, runs the migrations, loads the seed data and starts the API on http://localhost:3000. It keeps the terminal, so run the cURL examples below in a second one, or start it in the background with `docker compose up --build -d --wait`. Compose waits until `/health/ready` says the database answers. `docker compose down -v` throws the data away, so the next `up` starts fresh.

- OpenAPI UI: http://localhost:3000/docs (JSON at `/docs-json`). The same spec is committed as [docs/openapi.json](docs/openapi.json), so you can read the API without running anything.
- Health: `/health/live` and `/health/ready`
- Metrics: `/metrics` (Prometheus format)

### Seed data

Three dealerships in different time zones, so the time zone rules show up in real answers:

| Dealership             | id                                     | Zone             | Hours (Mon to Fri, Sat)        |
| ---------------------- | -------------------------------------- | ---------------- | ------------------------------ |
| London Central Service | `11111111-1111-4111-8111-111111111111` | Europe/London    | 08:00 to 17:30, 09:00 to 13:00 |
| Sydney Harbour Motors  | `22222222-2222-4222-8222-222222222222` | Australia/Sydney | 08:00 to 17:00, 08:00 to 12:00 |
| Tokyo Bay Auto         | `33333333-3333-4333-8333-333333333333` | Asia/Tokyo       | 09:00 to 18:00, 09:00 to 14:00 |

Service types: oil and filter change (`5e000000-0000-4000-8000-000000000001`, 60 minutes), brakes (`...0002`), diagnostics (`...0003`), tyres (`...0004`) and air conditioning (`...0005`). Six customers with one car each: customer `c0000000-0000-4000-8000-00000000000N` owns vehicle `0e000000-0000-4000-8000-00000000000N`, N from 1 to 6. All names, emails and VINs are made up.

The seed also books a busy day at London on the next weekday after the day you first run it (9 appointments, about half the bay time). Its date is fixed on the first run, so after a few days `docker compose down -v` gives you a fresh one.

### cURL examples

Set the day you want first. The examples use the seeded busy day, which is the first Monday to Friday after the day you first ran compose, so change `DAY` to that date (2026-11-11 is only right if you started it on Tue 10 Nov 2026):

```bash
DAY=2026-11-11   # the next weekday after you ran docker compose up
API=http://localhost:3000
LONDON=11111111-1111-4111-8111-111111111111
OIL=5e000000-0000-4000-8000-000000000001
```

The outputs below are real, from a fresh `docker compose up` on Tue 10 Nov 2026, with the busy day on Wed 11 Nov.

**1. What's free?** `GET /availability` lists the starts where a bay and a qualified technician are free for the whole job. It's a hint, the booking call is the real check.

```bash
curl -s "$API/availability?dealershipId=$LONDON&serviceTypeId=$OIL&date=$DAY"
```

```json
{"dealershipId":"11111111-1111-4111-8111-111111111111","serviceTypeId":"5e000000-0000-4000-8000-000000000001","date":"2026-11-11","timeZone":"Europe/London",
 "slots":[{"startsAt":"2026-11-11T10:00:00Z","startsAtLocal":"2026-11-11T10:00:00+00:00"},{"startsAt":"2026-11-11T10:15:00Z","startsAtLocal":"2026-11-11T10:15:00+00:00"}, ...]}
```

27 starts that day. The first one is 10:00, not 08:00, because both technicians who can do an oil service are booked until 10:00 on the busy day, even though bays are free earlier.

**2. Book it.** `startTime` must carry an offset (`Z` or `+01:00`). A time without one is a 400, because the server never guesses a zone.

```bash
curl -s -i -X POST "$API/appointments" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-first-booking' \
  -d '{
    "dealershipId": "'$LONDON'",
    "serviceTypeId": "'$OIL'",
    "customerId": "c0000000-0000-4000-8000-000000000006",
    "vehicleId": "0e000000-0000-4000-8000-000000000006",
    "startTime": "'$DAY'T11:00:00Z"
  }'
```

```
HTTP/1.1 201 Created
X-Request-Id: bdab05e8-c42f-41f9-acdd-7c2746d16b1d
Content-Type: application/json; charset=utf-8

{"id":"d03a2532-e41e-4b3f-9240-b6a3d842d8da","status":"confirmed","customerId":"c0000000-0000-4000-8000-000000000006","vehicleId":"0e000000-0000-4000-8000-000000000006","dealershipId":"11111111-1111-4111-8111-111111111111","serviceTypeId":"5e000000-0000-4000-8000-000000000001","serviceBayId":"ba000000-0000-4000-8000-000000000101","technicianId":"7e000000-0000-4000-8000-000000000101","startsAt":"2026-11-11T11:00:00Z","endsAt":"2026-11-11T12:00:00Z","startsAtLocal":"2026-11-11T11:00:00+00:00","endsAtLocal":"2026-11-11T12:00:00+00:00","timeZone":"Europe/London","createdAt":"2026-11-10T13:17:18Z"}
```

It picked bay 1 and the technician with the fewest skills who can do the job (A16), so the more flexible people stay free for other work. Send your own `X-Request-Id` and it comes back and shows up on every log line for that request.

**3. Retry it** (the same command again, same key, same body). You get the same appointment back with `Idempotent-Replayed: true`, and no second booking:

```
HTTP/1.1 201 Created
Idempotent-Replayed: true
```

Without the key, the same request is a 409, because that car is now booked at that time:

```json
{
  "type": "about:blank",
  "status": 409,
  "title": "Vehicle already booked",
  "detail": "This vehicle already has an appointment that overlaps this time.",
  "code": "VEHICLE_ALREADY_BOOKED"
}
```

**4. Errors.** Every error is problem+json with a `code` you can switch on. A start outside opening hours:

```bash
curl -s -X POST "$API/appointments" -H 'Content-Type: application/json' -d '{
  "dealershipId": "'$LONDON'", "serviceTypeId": "'$OIL'",
  "customerId": "c0000000-0000-4000-8000-000000000005",
  "vehicleId": "0e000000-0000-4000-8000-000000000005",
  "startTime": "'$DAY'T17:00:00Z" }'
```

```json
{
  "type": "about:blank",
  "status": 422,
  "title": "Outside opening hours",
  "detail": "The appointment has to start and end inside the dealership opening hours that day.",
  "code": "OUTSIDE_OPENING_HOURS"
}
```

And the same request with `"startTime": "2026-11-11T12:00:00"` (no offset):

```json
{
  "type": "about:blank",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "title": "Validation failed",
  "detail": "The request is not valid. The errors list says what is wrong with each field.",
  "errors": [
    {
      "field": "startTime",
      "message": "startTime must be an ISO 8601 date and time with an offset, for example 2027-03-09T09:00:00Z or 2027-03-09T10:00:00+01:00"
    }
  ]
}
```

404 means an id doesn't exist, 422 means it can never work as asked, 409 means not at this time (try another), 503 means try again in a moment (with `Retry-After`).

**5. Read it back.** `GET /appointments/{id}` returns the same body as the 201.

## Build and test

You need Node 24 and Docker (the integration and e2e tests start a throwaway Postgres with Testcontainers).

```bash
npm ci
npm test              # everything: unit, integration, e2e
npm run test:unit     # unit tests only, no database needed, a few seconds
npm run ci            # the full gate: format, lint, typecheck, build, all tests
npm run test:mutation # Stryker on src/scheduling, not part of ci
npm run load          # the load script, against a running docker compose
```

What the tests cover, 553 in all on the last run (320 unit, 117 integration, 116 e2e):

- **unit** - the scheduling rules (overlap, opening hours in the dealership's zone, the 15 minute grid, the 90 day window, strict time parsing), with property tests for the overlap rules. The booking loop against a fake store, for every branch. The error mapping, with one row per error code.
- **integration** - against a real Postgres: the schema refuses bad rows on its own (raw SQL, no service in the way), the availability queries, the booking service, the race tests, idempotency.
- **e2e** - through HTTP on the real app: the API contract, the race over HTTP, availability, idempotency, health, metrics and the log line.

The race tests hold every request at a barrier just before the write, so all of them read "free" before any of them inserts. Without that, a race test passes by luck (see the narrative below for how I found that out).

## What's done and what isn't

Everything in [PLAN.md](docs/PLAN.md) is done, including the steps after the cut line (observability, idempotency, availability, mutation testing, the load script).

Not done, on purpose (DESIGN.md section 11 has the list of what production needs next): cancel and reschedule endpoints, auth, staff blocks, notifications, a front end. The schema already allows for cancellation (the constraints ignore cancelled rows), so adding it doesn't need a migration.

Known limits, stated plainly:

- A skill removed from a technician in the few milliseconds between the read and the insert can still get booked once. I accept that (ADR 001 explains why a foreign key for it is worse).
- No test can catch the order of the statements inside the booking read being swapped. A comment says why the order matters.
- The load numbers come from one laptop with one API process. At the A23 peak (200 availability reads and 10 bookings a second for 45 s) the p95s were 14.6 ms and 41.3 ms against targets of 200 and 300, with 0 errors and 0 overlaps ([load-run.md](docs/evidence/load-run.md)). That shows the design holds at my own estimate, not what a production box can take.
- If Postgres is down when the api container starts, the migrate step fails and the container restarts until the database is back (`restart: on-failure`). Once it's running, a database outage gives 503s and the process stays up.
- A replay of a booking that was cancelled (only possible with raw SQL today) comes back as a 201 with status `cancelled`. That needs its own answer once a cancel endpoint exists.

## AI Collaboration Narrative

I built this as the engineer directing AI agents. I made the decisions, wrote down what "right" means before code existed, and checked what came back. The agents explored, wrote most of the code and tests, and reviewed. Every commit is one I read and made myself.

### Strategy for guiding the agents

- **Rules before code.** [CLAUDE.md](CLAUDE.md) is the rulebook every agent reads first. The ones that did the most work: never edit a test to make it pass (stop and tell me instead), nothing beyond the current PLAN step, test first with the failing run shown, and agents never commit.
- **A hook that won't take "done" on trust.** [.claude/hooks/tests-on-stop.sh](.claude/hooks/tests-on-stop.sh) runs the whole suite every time an agent says it's finished, and sends it back once if anything is red.
- **The right model for the job.** Opus to build (at high effort for the booking loop and idempotency), Fable to explore the concurrency options and as the fresh-eyes reviewer, Sonnet for small mechanical edits.

How a piece of work went, from start to finish:

1. **Assumptions, attacked.** I listed my assumptions from the brief, then had an agent with no design to defend attack them. Three of its points changed the design: an appointment stores its own end time, a car can't be booked at two dealerships at once, and "always pick the lowest id technician" refuses work a smarter pick would take.
2. **Design from experiments, not opinions.** For the hardest question, how to stop double bookings, an agent ran real experiments on Postgres instead of writing an essay. Its key claim was that a plain insert with a retry deadlocks under load. I reproduced that myself before building on it: 1 commit and 26 deadlocks with a plain insert, 8,819 commits with `ON CONFLICT DO NOTHING` ([evidence](docs/evidence/deadlock-repro-output.txt)). That became [ADR 001](docs/adr/001-no-double-booking.md).
3. **Spec and plan.** I planned the main points for the SPEC myself (the acceptance criteria with concrete examples), then worked with an agent to fine-tune it and design a PLAN. I told the reviewing agent to hunt for tests that could pass for the wrong reason, and it found some.
4. **Build, test first, one step at a time.** For each step an agent wrote the failing tests and stopped. I read the tests (most of my review time went there, a wrong test is worse than none), answered its questions, then said "go green", read the diff and committed. Red and green are separate commits.
5. **Verify from every side.** Break the code on purpose and watch the tests fail, mutation testing on the rules (91% to 97%), a two-reviewer review of the whole build, a load run, and an agent trying to break the running system.

The two-reviewer review was my pattern for anything important. One reviewer knows every decision, the other only has the brief and the code. The first catches "this contradicts what you decided". The second catches "this is just wrong", because it doesn't know what I meant.

### Verifying and refining what came back

My own biggest mistake first. AC-23 is the headline test: 20 parallel requests for the last free slot, exactly one wins. I had read it and approved it. Then I dropped the database constraints on purpose, and it still passed. The requests were spread out in time, so the race never happened. An agent added a barrier that holds every request until all of them have read "free", and now it fails every time without the constraints ([teeth checks](docs/evidence/teeth-checks.md)). Since then a race test only counts once I've seen it fail, and that's a rule in CLAUDE.md.

Things the agents caught that I had missed:

- A retry with the same idempotency key but a different body could have handed back someone else's booking. The fresh-eyes design reviewer found it, the full-context one had traced that path and missed it.
- Both build reviewers found, on their own, that an upper case customer id got a wrong 422 for the customer's own car.
- A Postgres restart could crash the whole process. One agent found it for idle connections, and the break-it run later found a second path, a connection lost in the middle of a booking. Both are fixed with tests that end a real database session.
- The first load run missed my own latency targets by a lot. Timing it pointed at the slot list. After the fix, one process meets them at my peak estimate (p95 14.6 ms and 41.3 ms against 200 and 300, [load run](docs/evidence/load-run.md)). The fix's own check over every time zone turned up a real bug: in Havana, on the one night a year when midnight happens twice, a 23:45 booking got through.

What held: no agent and no load run ever got a double booking past the database. That was checked after every burst by a query that doesn't trust the constraints.

### How I made sure of the final quality

- **One gate for everything.** `npm run ci` (format, lint, typecheck, build, 553 tests on a real Postgres) passes on a fresh clone. The hook ran the suite every time an agent said it was done.
- **Tests that are proven to fail.** Every race test was seen red with the constraint it protects dropped, and Stryker shows the scheduling rules' tests kill 97% of mutants.
- **The database as the last line.** Double bookings are refused by exclusion constraints, so even a bug in the service can't create one. After every load and break-it run, an independent SQL check found 0 overlaps.
- **Measured, not assumed.** The latency targets were checked with a real load run, and the deadlock claim behind the core design was reproduced by hand before I built on it.
- **Nothing merged unread.** Agents never committed. I read every diff, ran the suite myself and made every commit.

### What I'd do differently

- Run the "break it on purpose" check in the same step as each race test, not later. That's how I approved a test that couldn't fail.
- Run a load test as soon as the read path exists. The slot list's CPU cost was there from the start.
