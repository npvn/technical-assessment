# Teeth checks on the concurrency tests

The question: do the race tests actually prove anything? A concurrency test can pass by luck if the race never really happens. So I broke the code on purpose in three ways and checked that the tests go red. Each check ran in a separate git worktree, so the sabotage never touched the main tree, and none of it was committed.

- (a) and (b) ran at commit 32bcf02 (step 4 green), on `test/integration/appointments/concurrency.test.ts`.
- (c) ran at commit 5f576b9 (step 8 green), on the idempotency tests.

## (a) Drop the three exclusion constraints

What I changed: in `concurrency.test.ts`, right after the test database is created,

```ts
await sql
  .raw(
    `ALTER TABLE appointments DROP CONSTRAINT appointments_no_bay_overlap,
  DROP CONSTRAINT appointments_no_technician_overlap,
  DROP CONSTRAINT appointments_no_vehicle_overlap`,
  )
  .execute(tdb.db);
```

What should happen: every race test goes red, because nothing stops a double booking any more.

What happened, three runs in a row:

```
== run 1 (constraints dropped)
     × AC-24 3 bays and 5 technicians, 20 parallel requests for one slot ...
     × AC-39 10 parallel requests all preferring T1 ...
     × AC-40 the same vehicle at North and at South at the same instant ...
      Tests  3 failed | 1 passed | 3 skipped (7)
== run 2 (constraints dropped)
      Tests  3 failed | 1 passed | 3 skipped (7)
== run 3 (constraints dropped)
      Tests  3 failed | 1 passed | 3 skipped (7)
```

The failures show the database without its constraints doing exactly what the design is there to stop:

```
AC-24   - "created": 3, "SLOT_UNAVAILABLE": 17
        + "created": 20          (20 bookings for 3 bays)
AC-40   - "created": 1, "VEHICLE_ALREADY_BOOKED": 1
        + "created": 2           (one car at two dealerships at once)
```

### The catch: AC-23 passed every time without the constraints

AC-23 is the "20 parallel requests for the last free slot" test, the one the whole design is built around. It was the one test that passed in all three runs above. It's the first test in the file, so it runs on a cold pool. Opening fresh connections and the lookups before the loop spread the 20 requests out in time, the first booking commits before most of the others read, and they honestly see "no slot". The race never opens, so the test proved nothing about the constraint. I had read and approved that test and didn't see it. The teeth check found it, not my reading.

The fix: `test/integration/appointments/race-barrier.ts`, a test-only wrapper an agent added around the real store. It holds each request's first read until all N requests have read, then lets them all insert at once. Later reads (after a lost race) go straight through. It has a 10 s timeout so a mistake can't hang the suite. No production code changed and no assertion changed (the diff removes 0 `expect` lines).

## (b) Remove the re-read after a lost race

What I changed, in `booking.service.ts`:

```ts
// before
return appointment ? answer({ kind: 'created', appointment }) : { kind: 'lost' };
// after (sabotage): a lost race answers "no slot" straight away
return appointment
  ? answer({ kind: 'created', appointment })
  : answer(rejected('SLOT_UNAVAILABLE'));
```

What should happen: this is the "false fully booked" bug that A19 forbids. AC-24 has 3 bays and 5 technicians, so a correct loop books 3. The broken one should book fewer and refuse people while bays are still free.

What happened, two runs:

```
== run 1 (lost race returns 409, no re-read)
     × AC-24 ...   - "created": 3, "SLOT_UNAVAILABLE": 17
                   + "created": 2, "SLOT_UNAVAILABLE": 18
== run 2
     × AC-24 ...   - "created": 3, "SLOT_UNAVAILABLE": 17
                   + "created": 1, "SLOT_UNAVAILABLE": 19
```

So AC-24 catches it. AC-23 can't, by design (with one bay there is no second pair to fall back to), which is why both tests exist.

## (a) and (b) again, with the barrier

I re-ran both checks myself on the new test code, in the same worktree.

(a) constraints dropped, three runs, the same every time:

```
     × AC-23 1 bay and 1 technician, 20 parallel requests ...   - "created": 1   + "created": 20
     × AC-24 3 bays and 5 technicians, 20 parallel requests ... - "created": 3   + "created": 20
     × AC-39 10 parallel requests all preferring T1 ...         - "created": 1   + "created": 10
     × AC-40 the same vehicle at North and at South ...         - "created": 1   + "created": 2
      Tests  4 failed | 3 skipped (7)
```

AC-23 now fails without the constraints, every time. Before the barrier it passed every time.

(b) re-read removed:

```
     × AC-24 ...  - "created": 3   + "created": 1
     × AC-39 ...  (wrong code: SLOT_UNAVAILABLE instead of TECHNICIAN_UNAVAILABLE)
     × AC-40 ...  (wrong code: SLOT_UNAVAILABLE instead of VEHICLE_ALREADY_BOOKED)
      Tests  3 failed | 1 passed | 3 skipped (7)
```

With the real code back, the concurrency file passed 3 runs out of 3 (`Tests 7 passed (7)` each time).

## The HTTP race test

`test/e2e/race.test.ts` is AC-23 over real HTTP, behind the same barrier. It got the same check when it was written: with the constraints dropped it went red every run, with 20 x 201 for the one slot, and with them in place it passed 3 runs out of 3. I don't have that output saved, only those numbers. A later review of the finished code dropped the constraints again and saw AC-23, AC-24, AC-39, AC-40 and the HTTP race all fail. That output isn't saved either.

## (c) Idempotency: remove the key check inside the attempt

The question: AC-30 (two parallel requests with the same key) and AC-45 (same key, different start) are races, so they count only if they fail without the thing they protect. That thing is the key check inside each attempt, the one that catches a twin which committed after the check at the start of the request.

What I changed, at commit 5f576b9: deleted the one line in `booking.service.ts` that answers from `read.keyed`.

What should happen: AC-30's loser no longer sees the twin's key, its vehicle check sees the twin's booking, and it gets a false 409. AC-45's loser keeps losing the insert on the unique index.

What happened, three runs, the same every time:

```
     × AC-30 two parallel requests with the same key: one created, one replayed, same id, one row
     × AC-45 two parallel requests, same customer and key, different startTime: one created, one IDEMPOTENCY_KEY_REUSED, one row
+   "VEHICLE_ALREADY_BOOKED": 1,
-   "replayed": 1,
-   "IDEMPOTENCY_KEY_REUSED": 1,
+   "contended:attempt_cap": 1,
      Tests  2 failed | 13 skipped (15)
```

AC-30 gets exactly the false 409 the check exists to stop. AC-45 ends in a 503 because the loser hits the attempt cap. With the real code both pass (3 runs each, then the whole idempotency file and the full suite twice: 406 out of 406).

What the tests can't pin: where the key check sits inside the read. It has to run after the vehicle check (each READ COMMITTED statement gets its own snapshot), but the barrier holds requests before the read, not between its statements, so no test fails if the order is swapped. A comment in `readSlot` says why.

## What this shows

- The exclusion constraints are what stops double booking under a real race. Without them AC-23, AC-24, AC-39, AC-40 and the HTTP race all double book.
- The re-read after a lost race is what stops a false "fully booked". Without it AC-24 books 1 or 2 of 3.
- The key check inside the attempt is what makes a parallel retry come back as a replay.
- A race test that hasn't been seen failing without the thing it protects is not evidence. AC-23 passed for the wrong reason until the barrier went in.
