# Concurrency experiments

The experiments behind [ADR 001](../adr/001-no-double-booking.md): how each way of stopping a double booking behaves on a real PostgreSQL 16 under parallel load. An agent ran them in a throwaway container and wrote up the results. I reproduced the key one myself (the plain insert deadlock, [deadlock-repro.sh](deadlock-repro.sh)) before building on it. This file keeps the measured parts: how the claims were checked, the comparison, the numbers for bounding the retry loop, and every command with its raw output. The numbers quoted in DESIGN.md and ADR 001 (attempts per booking under a burst, lost races under spread out load, the share of SERIALIZABLE retries) come from here.

## 1. How the claims were checked

The agent ran the claims that decide the comparison against PostgreSQL 16.15 in a throwaway Docker container, with `psql` and `pgbench` from the same image.

- **Tested.** A claim with an experiment number next to it (E1 to E10) was run here. The command and output are in section 4 under that number.
- **Not tested.** A claim without an experiment number comes from the PostgreSQL documentation, its source comments or general knowledge.

Three limits of the tests, so the numbers are not read for more than they are:

- The load numbers come from a laptop with Postgres in Docker, 32 clients with no think time. That is far harsher than a real dealership, which takes a few bookings a minute at most. The same test run twice gave throughput figures up to a factor of two apart. Read them for the shape (what stalls, what retries, what gets refused), not for the absolute figures.
- The whole booking flow ran inside one PL/pgSQL function call per request, so there are no network round trips between statements. A retry in that harness is a new attempt inside the same function call, with the failed insert rolled back as a savepoint would do it. A real API would more likely start a new transaction per attempt. What other sessions see is the same in both cases.
- Redis (option 5) was not tested. Everything about it is from general knowledge.

## 2. Side by side

| Point                                | 1. Constraint + retry                                                       | 2. Row locks                                                     | 3. SERIALIZABLE                                           | 4. Advisory lock                                             | 5. Redis lock                                                 | 6a. Constraint + advisory lock                                       |
| ------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| Prevents double booking by           | The database refusing the second row                                        | Making bookings on the same rows take turns                      | The database aborting one of two conflicting transactions | Making bookings with the same key take turns                 | Making requests take turns, as long as the lock is still held | Refusing the second row. The lock only orders requests               |
| False rejections                     | Only from a badly bounded loop. Plain INSERT can use up a deadlock cap (E9) | From SKIP LOCKED, NOWAIT, or a timeout mapped to 409             | Only from a badly bounded loop                            | From try-lock used as skip, or a timeout mapped to 409       | From fail fast on a held lock                                 | As option 4                                                          |
| Deadlocks                            | Plain INSERT: yes. ON CONFLICT DO NOTHING: none seen                        | None with a fixed lock order                                     | None                                                      | None with one key                                            | None in Postgres                                              | None seen                                                            |
| Retries                              | Lost races, at most free bays plus free technicians                         | None                                                             | Frequent, and unrelated to real overlap                   | None                                                         | Depends                                                       | Rare                                                                 |
| Several instances                    | Yes                                                                         | Yes                                                              | Yes                                                       | Yes                                                          | Yes                                                           | Yes                                                                  |
| Hot path (E9 and E5, laptop numbers) | About 1 ms. 3,000 to 4,600 per second spread out                            | About 65 ms at 32 clients. About 480 per second                  | 440 to 2,500 per second depending on table size           | About 62 ms at 32 clients. 480 to 900 per second across runs | Not tested. Two more network hops                             | As option 4                                                          |
| Operational cost                     | One extension. No partitioning on 16. Log noise with plain INSERT           | None, but the rule is invisible                                  | Watch the abort rate. Every writer must use the level     | None, but the rule is invisible                              | A new service                                                 | One extension plus a key scheme                                      |
| Testing                              | Strong and deterministic                                                    | Needs a second connection holding the lock. Several traps to pin | End state only                                            | Needs a second connection holding the lock. One trap to pin  | Failure cases are very hard to reproduce                      | Constraint tests are strong. The rare retry path needs a forced test |
| Explaining                           | One sentence, plus four details                                             | Easy idea, subtle rules                                          | Easy idea, confusing aborts                               | Easiest                                                      | Familiar idea, long list of what ifs                          | Two short sentences                                                  |

## 3. Bounding the retry loop when the guarantee is an exclusion constraint

The question was how to make sure the loop never says "no slot" while a free pair exists. These are the rules that get there.

**Rule 1. Only a read may say "no slot".** The 409 for "nothing free" comes from one place: a fresh availability read that finds no free bay or no free qualified technician. A counter running out is never a 409. This one rule is what makes A19 true.

**Rule 2. Every attempt reads again with a fresh snapshot.** At READ COMMITTED every statement sees the latest committed data, so both a new transaction and a second try inside the same transaction see the booking that just beat you. At REPEATABLE READ or SERIALIZABLE the retry must be a new transaction, or the read will offer the same taken bay again.

**Rule 3. Sort the conflict by constraint before deciding.** The 23P01 error carries the constraint name (shown in E1a). node-postgres exposes it as `err.constraint` next to `err.code`, and Kysely passes driver errors through as far as the agent knew.

| Conflict on                                          | Meaning                                                | Action              |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------- |
| Bay constraint                                       | Somebody took that bay                                 | Read again          |
| Technician constraint, system picked the technician  | Somebody took that technician                          | Read again          |
| Technician constraint, customer named the technician | The preferred technician is taken                      | Final 409 (A5, A19) |
| Vehicle constraint                                   | This vehicle is already booked for an overlapping time | Final 409           |

With `ON CONFLICT DO NOTHING` there is no constraint name. The next read has to answer the same questions: is the vehicle busy, is the preferred technician busy, is a pair still free.

The idempotency key (A15) has to be looked up before any of that, at the start of every attempt. A second request with the same key will find the vehicle busy, because of its own first booking. If the vehicle check came first, a replay would get 409 instead of the original appointment. Two in-flight requests with the same key also aim at the same bay under A16, so the loser may see a bay or vehicle conflict and not a key conflict. Looking the key up first on each attempt covers all of these.

**Rule 4. The loop has a natural bound, and it is small.** Every bay or technician conflict proves that a competing appointment for that bay or technician was committed. A competitor that rolled back does not produce a conflict (E1b). So the next read will not offer that bay or technician again. Each lost race removes at least one bay or one technician from what the request can still use. If the first read saw `B` free bays and `T` free qualified technicians, the request can lose at most `B + T - 1` races before a read comes back with no pair, which is then an honest 409. In E9 with 10 bays and 10 technicians the largest number of attempts seen was 11, against a bound of 20.

This argument assumes nothing is given back while the loop runs. Once cancel and reschedule exist, a freed bay can come back and add a turn. That does not break safety or rule 1. It only means the bound is no longer strict.

**Rule 5. Errors that prove nothing get their own small budget.** A deadlock (40P01), a serialization failure (40001) or a lock timeout (55P03) does not mean a resource was taken. They cannot be counted towards "no slot". They need a separate, small cap (say 3) and a different answer when the cap is hit. E9 shows what that cap costs with plain INSERT: 31 requests ran out of deadlock retries with free pairs left. A random pause before the next try is the usual advice. For deadlocks it did not help here: with a pause of up to 100 ms, the same 7 requests out of the 8 client run gave up and the stall was just as long (E9d). Each deadlock costs `deadlock_timeout` whatever the client does afterwards. A pause for 40001 was not tested.

**Rule 6. A hard cap exists, and hitting it is a 503, not a 409.** Set it above `B + T`, or as a time budget for the whole request, or both. Reaching it means something unusual: heavy churn from cancellations, or a bug. The honest answer is "try again shortly" (503 with Retry-After), plus a log line and a metric. A20 already separates temporary from permanent refusals. This is a third kind: the server could not find out.

**Rule 7. The read and the constraint must agree on what "free" means.** Same `[)` bounds, same status filter. If the read is stricter than the constraint, for example it treats cancelled rows as busy, it says "no slot" while a pair is free, with no concurrency involved at all. If the read is looser, it keeps offering a bay the constraint keeps refusing, and the loop spins until the hard cap. A test that compares the two on generated data would pin this.

**Rule 8. The retry wraps the whole transaction, commit included.** Some errors only show up at COMMIT (40001 in E3f, deferred constraints in E10d). With Kysely that means the loop goes around the `db.transaction().execute(...)` call, not inside the callback.

**Rule 9. Waiting is not failing.** An insert that waits behind an open competitor is working as designed (E1). A `lock_timeout` keeps a stuck competitor from holding the request for good (E1d). The resulting 55P03 falls under rule 5.

**Rule 10. The insert form decides how much rules 5 and 6 matter.** Given E2 and E9, `ON CONFLICT DO NOTHING` removes the one error that made the loop misbehave in the tests. With plain INSERT, kept for its named constraint in the error, rules 5 and 6 carry more weight, and so does a lock in front (6a).

A sketch, to show where each rule sits. Names are made up.

```ts
// Sketch only.
async function book(req: BookingRequest): Promise<BookingResult> {
  let lostRaces = 0; // each one proves a competitor took a bay or a technician
  let transient = 0; // deadlock, serialization failure, lock timeout
  const deadline = clock.now() + REQUEST_BUDGET_MS;

  while (true) {
    try {
      // The retry goes around the whole transaction, commit included (rule 8).
      const result = await db.transaction().execute(async (trx) => {
        // Same idempotency key stored already? Then answer from that appointment (A15).
        // Checked on every attempt, before the vehicle check (rule 3).
        const earlier = await findByIdempotencyKey(trx, req);
        if (earlier) return replay(earlier, req);

        const view = await readAvailability(trx, req); // fresh read every time (rule 2)
        if (view.vehicleBusy) return conflict('vehicle'); // final (rule 3)
        if (view.preferredTechnicianBusy) return conflict('technician');
        if (!view.bayId || !view.technicianId) return conflict('no_slot'); // the only "no slot" (rule 1)

        const row = await insertAppointment(trx, req, view); // ON CONFLICT DO NOTHING form
        return row ? created(row) : LOST_RACE;
      });
      if (result !== LOST_RACE) return result;
      lostRaces++;
    } catch (err) {
      // 23505 on the key can only happen with a plain INSERT. Go around, the lookup at the top finds the original.
      if (isDuplicateIdempotencyKey(err)) continue;
      if (!isTransient(err)) throw err; // only 40P01, 40001, 55P03 go on
      transient++; // rule 5
    }
    if (lostRaces > HARD_CAP || transient > 3 || clock.now() > deadline) {
      return unavailable503(); // never a 409 (rule 6)
    }
  }
}
```

## 4. Commands and output

Everything here ran against `postgres:16` (PostgreSQL 16.15) in Docker, with default settings (`default_transaction_isolation = read committed`, `deadlock_timeout = 1s`). The scripts were kept outside the repo, so they are pasted here in full. To run them again: start the container, load the schema, save `lib.sh` next to the scripts, and run each script with `bash`.

```bash
docker run -d --name concopt-pg16 -e POSTGRES_PASSWORD=pw postgres:16
docker cp schema.sql concopt-pg16:/tmp/schema.sql
docker exec concopt-pg16 psql -U postgres -v ON_ERROR_STOP=1 -q -f /tmp/schema.sql
# when done
docker rm -f concopt-pg16
```

### Schema used by the experiments (`schema.sql`)

This is a test schema, not a proposal for the real one. It has the three exclusion constraints and the composite foreign keys.

```sql
drop schema if exists public cascade;
create schema public;
create extension if not exists btree_gist;

create table dealerships (id bigint primary key);
create table skills (id bigint primary key);
create table service_types (
  id bigint primary key,
  required_skill_id bigint not null references skills,
  duration_minutes int not null,
  unique (id, required_skill_id)
);
create table bays (
  id bigint primary key,
  dealership_id bigint not null references dealerships,
  unique (id, dealership_id)
);
create table technicians (
  id bigint primary key,
  dealership_id bigint not null references dealerships,
  unique (id, dealership_id)
);
create table technician_skills (
  technician_id bigint not null references technicians,
  skill_id bigint not null references skills,
  primary key (technician_id, skill_id)
);
create table customers (id bigint primary key);
create table vehicles (
  id bigint primary key,
  customer_id bigint not null references customers,
  unique (id, customer_id)
);

create table appointments (
  id bigint generated always as identity primary key,
  dealership_id bigint not null,
  bay_id bigint not null,
  technician_id bigint not null,
  customer_id bigint not null,
  vehicle_id bigint not null,
  service_type_id bigint not null,
  required_skill_id bigint not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  check (ends_at > starts_at),
  foreign key (bay_id, dealership_id) references bays (id, dealership_id),
  foreign key (technician_id, dealership_id) references technicians (id, dealership_id),
  foreign key (vehicle_id, customer_id) references vehicles (id, customer_id),
  foreign key (service_type_id, required_skill_id) references service_types (id, required_skill_id),
  foreign key (technician_id, required_skill_id) references technician_skills (technician_id, skill_id),
  constraint appt_bay_no_overlap exclude using gist
    (bay_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status = 'confirmed'),
  constraint appt_tech_no_overlap exclude using gist
    (technician_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status = 'confirmed'),
  constraint appt_vehicle_no_overlap exclude using gist
    (vehicle_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status = 'confirmed')
);

-- seed: 2 dealerships. Dealership 1 has 3 bays and 3 technicians, all with skill 1.
insert into dealerships values (1),(2);
insert into skills values (1),(2);
insert into service_types values (1,1,60),(2,2,60);
insert into bays values (1,1),(2,1),(3,1),(11,2),(12,2);
insert into technicians values (1,1),(2,1),(3,1),(11,2),(12,2);
insert into technician_skills values (1,1),(2,1),(3,1),(11,1),(12,1),(1,2);
insert into customers select g from generate_series(1,2000) g;
insert into vehicles select g, g from generate_series(1,2000) g;
```

### Helper (`lib.sh`)

```bash
export DOCKER_HOST=unix:///path/to/docker.sock
P() { docker exec -i concopt-pg16 psql -U postgres -X -q "$@"; }
INS="insert into appointments (dealership_id,bay_id,technician_id,customer_id,vehicle_id,service_type_id,required_skill_id,starts_at,ends_at)"
```

### E1. How an insert behaves when it meets an overlapping row

Checks: the second insert waits for an open transaction, fails with 23P01 if that one commits, goes through if it rolls back. Touching ranges are fine. `lock_timeout` cuts the wait with 55P03.

<details>
<summary>Script <code>e1.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
echo "truncate appointments" | P
echo "##### E1a: first transaction COMMITS after 3s. Second insert (same bay, other technician and vehicle) starts 1s later."
( P <<SQL
begin;
$INS values (1,1,1,1,1,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
select pg_sleep(3);
commit;
SQL
) > a.out 2>&1 &
( P <<SQL
select pg_sleep(1);
\set VERBOSITY verbose
\timing on
$INS values (1,1,2,2,2,1,1,'2027-01-04 09:30+00','2027-01-04 10:30+00');
SQL
) > b.out 2>&1 &
wait
echo "--- session B output"; cat b.out
echo "##### E1b: first transaction ROLLS BACK after 3s."
echo "truncate appointments" | P
( P <<SQL
begin;
$INS values (1,1,1,1,1,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
select pg_sleep(3);
rollback;
SQL
) > a.out 2>&1 &
( P <<SQL
select pg_sleep(1);
\timing on
$INS values (1,1,2,2,2,1,1,'2027-01-04 09:30+00','2027-01-04 10:30+00') returning id, bay_id;
SQL
) > b.out 2>&1 &
wait
echo "--- session B output"; cat b.out
echo "##### E1c: touching ranges [09:00,10:00) and [10:00,11:00) on the same bay do not conflict"
echo "truncate appointments" | P
P <<SQL
$INS values (1,1,1,1,1,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00') returning id;
$INS values (1,1,1,1,1,1,1,'2027-01-04 10:00+00','2027-01-04 11:00+00') returning id;
SQL
echo "##### E1d: lock_timeout applies to the wait on an in-flight conflicting insert"
echo "truncate appointments" | P
( P <<SQL
begin;
$INS values (1,1,1,1,1,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
select pg_sleep(3);
commit;
SQL
) > a.out 2>&1 &
( P <<SQL
select pg_sleep(1);
set lock_timeout = '500ms';
\set VERBOSITY verbose
\timing on
$INS values (1,1,2,2,2,1,1,'2027-01-04 09:30+00','2027-01-04 10:30+00');
SQL
) > b.out 2>&1 &
wait
echo "--- session B output"; cat b.out
```

</details>

Output:

```text
##### E1a: first transaction COMMITS after 3s. Second insert (same bay, other technician and vehicle) starts 1s later.
--- session B output
 pg_sleep
----------

(1 row)

ERROR:  23P01: conflicting key value violates exclusion constraint "appt_bay_no_overlap"
DETAIL:  Key (bay_id, tstzrange(starts_at, ends_at, '[)'::text))=(1, ["2027-01-04 09:30:00+00","2027-01-04 10:30:00+00")) conflicts with existing key (bay_id, tstzrange(starts_at, ends_at, '[)'::text))=(1, ["2027-01-04 09:00:00+00","2027-01-04 10:00:00+00")).
SCHEMA NAME:  public
TABLE NAME:  appointments
CONSTRAINT NAME:  appt_bay_no_overlap
LOCATION:  check_exclusion_or_unique_constraint, execIndexing.c:874
Time: 2028.095 ms (00:02.028)
##### E1b: first transaction ROLLS BACK after 3s.
--- session B output
 pg_sleep
----------

(1 row)

   id   | bay_id
--------+--------
 169913 |      1
(1 row)

Time: 2031.826 ms (00:02.032)
##### E1c: touching ranges [09:00,10:00) and [10:00,11:00) on the same bay do not conflict
   id
--------
 169914
(1 row)

   id
--------
 169915
(1 row)

##### E1d: lock_timeout applies to the wait on an in-flight conflicting insert
--- session B output
 pg_sleep
----------

(1 row)

ERROR:  55P03: canceling statement due to lock timeout
CONTEXT:  while checking exclusion constraint on tuple (0,1) in relation "appointments"
LOCATION:  ProcessInterrupts, postgres.c:3387
Time: 503.096 ms
```

Reading it: in E1a session B started 1 second after A and waited about 2 more seconds, until A committed, then got 23P01 with the constraint name. In E1b the same wait ended in a successful insert on bay 1, because A rolled back. In E1d the wait was cut at 500 ms with 55P03.

### E2. Many plain inserts at the same instant, against ON CONFLICT DO NOTHING

Checks: whether simultaneous inserts for the same bay and time deadlock. All 16 clients insert the same bay and technician into the same 50 ms time bucket, over and over. The function catches the error and logs the SQLSTATE.

<details>
<summary>Script <code>e2.sql</code></summary>

```sql
drop table if exists errlog;
create table errlog (run text, code text, cname text, waited_ms numeric);

-- One blind insert of a fixed bay and technician into time bucket k. Logs the outcome.
create or replace function try_insert(run text, b bigint, t bigint, v bigint, k bigint, on_conflict boolean default false)
returns text language plpgsql as $$
declare
  c text; n text; t0 timestamptz := clock_timestamp(); got bigint;
  s timestamptz := timestamptz '2030-01-01 00:00+00' + k * interval '1 hour';
begin
  begin
    if on_conflict then
      insert into appointments (dealership_id,bay_id,technician_id,customer_id,vehicle_id,service_type_id,required_skill_id,starts_at,ends_at)
      values (1,b,t,v,v,1,1,s,s + interval '1 hour')
      on conflict do nothing returning id into got;
      c := case when got is null then 'skipped' else 'ok' end;
    else
      insert into appointments (dealership_id,bay_id,technician_id,customer_id,vehicle_id,service_type_id,required_skill_id,starts_at,ends_at)
      values (1,b,t,v,v,1,1,s,s + interval '1 hour');
      c := 'ok';
    end if;
  exception when others then
    get stacked diagnostics c = returned_sqlstate, n = constraint_name;
  end;
  insert into errlog values (run, c, n, round(extract(epoch from clock_timestamp() - t0) * 1000, 1));
  return c;
end $$;
```

</details>

<details>
<summary>Script <code>e2_plain.pgb</code></summary>

```sql
\set v :client_id + 1
select try_insert('plain', 1, 1, :v, floor(extract(epoch from clock_timestamp()) * 20)::bigint % 100000);
```

</details>

<details>
<summary>Script <code>e2_onconflict.pgb</code></summary>

```sql
\set v :client_id + 1
select try_insert('onconflict', 1, 1, :v, floor(extract(epoch from clock_timestamp()) * 20)::bigint % 100000, true);
```

</details>

<details>
<summary>Script <code>e2.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
for f in e2.sql e2_plain.pgb e2_onconflict.pgb; do docker cp $f concopt-pg16:/tmp/$f; done
echo "truncate appointments" | P
P -f /tmp/e2.sql
echo "##### E2a: 16 clients, 20s, all blind-insert the same bay and technician into the same 50ms time bucket (plain INSERT)"
docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c 16 -j 4 -T 20 -f /tmp/e2_plain.pgb 2>&1 | egrep 'number of (transactions|failed)|latency average|tps'
echo "##### E2b: same load with INSERT ... ON CONFLICT DO NOTHING"
docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c 16 -j 4 -T 20 -f /tmp/e2_onconflict.pgb 2>&1 | egrep 'number of (transactions|failed)|latency average|tps'
P <<SQL
select run, code, coalesce(cname,'-') as constraint_name, count(*), round(avg(waited_ms),1) as avg_ms, max(waited_ms) as max_ms
from errlog group by 1,2,3 order by 1,4 desc;
select 'double booked bay rows' as check, count(*) from appointments a join appointments b
  on a.id < b.id and a.bay_id = b.bay_id and a.status='confirmed' and b.status='confirmed'
  and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)');
select count(*) as appointments_total from appointments;
SQL
```

</details>

Output:

```text
##### E2a: 16 clients, 20s, all blind-insert the same bay and technician into the same 50ms time bucket (plain INSERT)
number of transactions actually processed: 1795
number of failed transactions: 0 (0.000%)
latency average = 219.435 ms
tps = 72.914365 (without initial connection time)
##### E2b: same load with INSERT ... ON CONFLICT DO NOTHING
number of transactions actually processed: 9008
number of failed transactions: 0 (0.000%)
latency average = 35.574 ms
tps = 449.766369 (without initial connection time)
    run     |  code   |   constraint_name   | count | avg_ms | max_ms
------------+---------+---------------------+-------+--------+---------
 onconflict | skipped | -                   |  8628 |   10.3 |   150.0
 onconflict | ok      | -                   |   380 |    0.5 |     4.0
 plain      | 23P01   | appt_bay_no_overlap |  1436 |    6.6 |   128.4
 plain      | ok      | -                   |   302 |  172.8 | 15002.3
 plain      | 40P01   |                     |    57 | 4280.9 | 15001.8
(5 rows)

         check          | count
------------------------+-------
 double booked bay rows |     0
(1 row)

 appointments_total
--------------------
                682
(1 row)
```

Reading it: plain INSERT had 57 deadlocks (40P01). The deadlocked inserts waited 4.3 seconds on average and up to 15 seconds, and so did some successful ones. ON CONFLICT DO NOTHING had no deadlocks and the longest wait was 150 ms. No bay was double booked in either run.

### E3 and E4. Row locks and advisory locks at each isolation level, and SKIP LOCKED

Checks: which lock shapes really stop a double booking. The table `appt_nc` has no exclusion constraint, so only the lock protects it. Session A books bay 1 and holds its transaction open for 2 seconds. Session B starts 1 second later and wants the same hour. The lines `A:` and `B:` show the bay each one booked.

<details>
<summary>Script <code>e3.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
# A copy of appointments with NO exclusion constraints, so only the lock protects it.
P <<SQL
drop table if exists appt_nc;
create table appt_nc (id bigint generated always as identity primary key, bay_id bigint not null, vehicle_id bigint not null,
  starts_at timestamptz not null, ends_at timestamptz not null);
SQL
FREE="not exists (select 1 from appt_nc a where a.bay_id = b.id and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange('2027-01-04 09:00+00','2027-01-04 10:00+00','[)'))"
INS_NC="insert into appt_nc (bay_id, vehicle_id, starts_at, ends_at) values (:bay, :veh, '2027-01-04 09:00+00','2027-01-04 10:00+00') returning bay_id as booked_bay"

# run_pair <title> <isolation> <lock+pick statements>
run_pair() {
  echo; echo "##### $1"
  echo "truncate appt_nc" | P
  for who in A B; do
    if [ $who = A ]; then pre=""; post="select pg_sleep(2);"; veh=1; else pre="select pg_sleep(1) \\gset x_"; post=""; veh=2; fi
    ( P -At <<SQL
$pre
\set veh $veh
begin isolation level $2;
$3
$INS_NC;
$post
commit;
SQL
    ) > $who.out 2>&1 &
  done
  wait
  echo "A: $(tr '\n' ' ' < A.out)"; echo "B: $(tr '\n' ' ' < B.out)"
  P -At -c "select 'rows for bay 1 at 09:00 = ' || count(*) filter (where bay_id=1) || ', bays used = ' || coalesce(string_agg(bay_id::text, ',' order by id),'none') from appt_nc"
}

run_pair "E3a: READ COMMITTED. Lock all bays of the dealership first, then pick a free one in a SECOND statement" "read committed" \
"select count(*) as locked from (select id from bays where dealership_id = 1 order by id for update) s \\gset l_
select b.id as bay from bays b where b.dealership_id = 1 and $FREE order by b.id limit 1 \\gset"

run_pair "E3b: READ COMMITTED. Pick the free bay and lock it in ONE statement (NOT EXISTS ... FOR UPDATE)" "read committed" \
"select b.id as bay from bays b where b.dealership_id = 1 and $FREE order by b.id limit 1 for update \\gset"

run_pair "E3c: REPEATABLE READ. Lock all bays first, then pick in a second statement" "repeatable read" \
"select count(*) as locked from (select id from bays where dealership_id = 1 order by id for update) s \\gset l_
select b.id as bay from bays b where b.dealership_id = 1 and $FREE order by b.id limit 1 \\gset"

run_pair "E3d: READ COMMITTED. Advisory lock on the dealership, then pick in a second statement" "read committed" \
"select pg_advisory_xact_lock(1001, 1) \\gset l_
select b.id as bay from bays b where b.dealership_id = 1 and $FREE order by b.id limit 1 \\gset"

run_pair "E3e: REPEATABLE READ. Advisory lock on the dealership as the first statement, then pick" "repeatable read" \
"select pg_advisory_xact_lock(1001, 1) \\gset l_
select b.id as bay from bays b where b.dealership_id = 1 and $FREE order by b.id limit 1 \\gset"

run_pair "E3f: SERIALIZABLE, no locks at all, no constraint. Pick then insert" "serializable" \
"select b.id as bay from bays b where b.dealership_id = 1 and $FREE order by b.id limit 1 \\gset"

echo; echo "##### E4: SKIP LOCKED. A holds a lock on every bay of dealership 1 while it books ONE of them. B asks with SKIP LOCKED."
( P -At <<SQL
begin;
select count(*) from (select id from bays where dealership_id = 1 order by id for update) s;
select pg_sleep(2);
commit;
SQL
) > A.out 2>&1 &
( P <<SQL
select pg_sleep(1) \gset x_
select b.id as bay_found_by_b from bays b where b.dealership_id = 1 order by b.id limit 1 for update skip locked;
SQL
) > B.out 2>&1 &
wait
cat B.out
```

</details>

Output:

```text

##### E3a: READ COMMITTED. Lock all bays of the dealership first, then pick a free one in a SECOND statement
A: 1
B: 2
rows for bay 1 at 09:00 = 1, bays used = 1,2

##### E3b: READ COMMITTED. Pick the free bay and lock it in ONE statement (NOT EXISTS ... FOR UPDATE)
A: 1
B: 1
rows for bay 1 at 09:00 = 2, bays used = 1,1

##### E3c: REPEATABLE READ. Lock all bays first, then pick in a second statement
A: 1
B: 1
rows for bay 1 at 09:00 = 2, bays used = 1,1

##### E3d: READ COMMITTED. Advisory lock on the dealership, then pick in a second statement
A: 1
B: 2
rows for bay 1 at 09:00 = 1, bays used = 1,2

##### E3e: REPEATABLE READ. Advisory lock on the dealership as the first statement, then pick
A: 1
B: 1
rows for bay 1 at 09:00 = 2, bays used = 1,1

##### E3f: SERIALIZABLE, no locks at all, no constraint. Pick then insert
A: 1  ERROR:  could not serialize access due to read/write dependencies among transactions DETAIL:  Reason code: Canceled on identification as a pivot, during commit attempt. HINT:  The transaction might succeed if retried.
B: 1
rows for bay 1 at 09:00 = 1, bays used = 1

##### E4: SKIP LOCKED. A holds a lock on every bay of dealership 1 while it books ONE of them. B asks with SKIP LOCKED.
 bay_found_by_b
----------------
(0 rows)
```

Reading it: E3a and E3d are correct (B took bay 2). E3b, E3c and E3e double booked bay 1. E3f is SERIALIZABLE with no locks: A was aborted with 40001 at COMMIT and one row was stored. In E4, B found no bay at all with SKIP LOCKED while A held the rows, although A was only going to use one of them.

### E5. SERIALIZABLE under spread out load, and one writer at another level

Checks: how often SERIALIZABLE aborts bookings that do not really overlap, and what happens when one writer is not SERIALIZABLE. The table `appt_ser` has no exclusion constraint. pgbench retries failed transactions by itself, up to 50 times (`--max-tries=50`).

<details>
<summary>Script <code>e5.sql</code></summary>

```sql
-- Same shape as appointments but with NO exclusion constraints. Only the isolation level protects it.
drop table if exists appt_ser;
create table appt_ser (id bigint generated always as identity primary key, dealership_id bigint not null,
  bay_id bigint not null, technician_id bigint not null, vehicle_id bigint not null,
  starts_at timestamptz not null, ends_at timestamptz not null);
create index on appt_ser (bay_id, starts_at);
create index on appt_ser (technician_id, starts_at);
create index on appt_ser (vehicle_id, starts_at);

create or replace function book_ser(d bigint, v bigint, k bigint) returns text language plpgsql as $$
declare
  s timestamptz := timestamptz '2030-01-01 00:00+00' + k * interval '1 hour';
  e timestamptz := s + interval '1 hour';
  b bigint; t bigint;
begin
  if exists (select 1 from appt_ser a where a.vehicle_id = v and a.starts_at < e and a.ends_at > s) then return 'vehicle_busy'; end if;
  select bay.id into b from bays bay where bay.dealership_id = d
    and not exists (select 1 from appt_ser a where a.bay_id = bay.id and a.starts_at < e and a.ends_at > s)
    order by bay.id limit 1;
  select tech.id into t from technicians tech
    join technician_skills q on q.technician_id = tech.id and q.skill_id = 1
    where tech.dealership_id = d
    and not exists (select 1 from appt_ser a where a.technician_id = tech.id and a.starts_at < e and a.ends_at > s)
    order by tech.id limit 1;
  if b is null or t is null then return 'no_slot'; end if;
  insert into appt_ser (dealership_id, bay_id, technician_id, vehicle_id, starts_at, ends_at) values (d, b, t, v, s, e);
  return 'booked';
end $$;
```

</details>

<details>
<summary>Script <code>e5_ser.pgb</code></summary>

```sql
\set v random(1, 2000)
\set k random(1, 20000)
\set d random(1, 3)
begin isolation level serializable;
select book_ser(:d, :v, :k);
commit;
```

</details>

<details>
<summary>Script <code>e5.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
for f in e5.sql e5_ser.pgb; do docker cp $f concopt-pg16:/tmp/$f; done
P -f /tmp/e5.sql
DBL="select 'double booked: ' || count(*) from appt_ser a join appt_ser b on a.id < b.id and a.starts_at < b.ends_at and b.starts_at < a.ends_at and (a.bay_id=b.bay_id or a.technician_id=b.technician_id or a.vehicle_id=b.vehicle_id)"
echo "##### E5a: SERIALIZABLE only, table starts empty. 32 clients, 15s, random dealership (1 to 3) and random slot out of 20000, so real overlaps are rare"
docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c 32 -j 4 -T 15 --max-tries=50 --failures-detailed -f /tmp/e5_ser.pgb 2>&1 | egrep 'number of|latency average|tps|ERROR' | sort | uniq -c
P -At -c "$DBL" -c "select 'rows: ' || count(*) from appt_ser"
echo "##### E5b: same, but the table is first filled with 300000 old rows and analysed, so the planner uses the indexes"
P -q <<SQL
truncate appt_ser;
insert into appt_ser (dealership_id, bay_id, technician_id, vehicle_id, starts_at, ends_at)
select 3, 301 + (g % 10), 301 + (g % 10), 1 + (g % 2000), timestamptz '2020-01-01' + (g / 10) * interval '1 hour', timestamptz '2020-01-01' + (g / 10 + 1) * interval '1 hour'
from generate_series(1, 300000) g;
analyze appt_ser;
SQL
docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c 32 -j 4 -T 15 --max-tries=50 --failures-detailed -f /tmp/e5_ser.pgb 2>&1 | egrep 'number of|latency average|tps|ERROR' | sort | uniq -c
P -At -c "select 'double booked among new rows: ' || count(*) from appt_ser a join appt_ser b on a.id < b.id and a.starts_at >= '2030-01-01' and b.starts_at >= '2030-01-01' and a.starts_at < b.ends_at and b.starts_at < a.ends_at and (a.bay_id=b.bay_id or a.technician_id=b.technician_id or a.vehicle_id=b.vehicle_id)"

echo "##### E5c: one writer forgets SERIALIZABLE. A is SERIALIZABLE, B is READ COMMITTED, both want bay 1 at 09:00"
P -q -c "truncate appt_ser"
for who in A B; do
  if [ $who = A ]; then pre=""; post="select pg_sleep(2);"; iso="serializable"; veh=1; else pre="select pg_sleep(1) \\gset x_"; post=""; iso="read committed"; veh=2; fi
  ( P -At <<SQL
$pre
begin isolation level $iso;
select b.id as bay from bays b where b.dealership_id = 1 and not exists (select 1 from appt_ser a where a.bay_id = b.id and a.starts_at < '2027-01-04 10:00+00' and a.ends_at > '2027-01-04 09:00+00') order by b.id limit 1 \gset
insert into appt_ser (dealership_id, bay_id, technician_id, vehicle_id, starts_at, ends_at) values (1, :bay, $veh, $veh, '2027-01-04 09:00+00', '2027-01-04 10:00+00') returning bay_id;
$post
commit;
SQL
  ) > $who.out 2>&1 &
done
wait
echo "A ($(echo serializable)): $(tr '\n' ' ' < A.out)"; echo "B (read committed): $(tr '\n' ' ' < B.out)"
P -At -c "select 'rows for bay 1 at 09:00 = ' || count(*) from appt_ser where bay_id = 1"
```

</details>

Output:

```text
##### E5a: SERIALIZABLE only, table starts empty. 32 clients, 15s, random dealership (1 to 3) and random slot out of 20000, so real overlaps are rare
   1 latency average = 168.827 ms (including failures)
   1 maximum number of tries: 50
   1 number of clients: 32
   1 number of deadlock failures: 0 (0.000%)
   1 number of failed transactions: 717 (25.229%)
   1 number of serialization failures: 717 (25.229%)
   1 number of threads: 4
   1 number of transactions actually processed: 2125
   1 number of transactions retried: 2739 (96.376%)
   1 total number of retries: 72603
   1 tps = 141.723961 (without initial connection time)
double booked: 0
rows: 2124
##### E5b: same, but the table is first filled with 300000 old rows and analysed, so the planner uses the indexes
   1 latency average = 751.460 ms (including failures)
   1 maximum number of tries: 50
   1 number of clients: 32
   1 number of deadlock failures: 0 (0.000%)
   1 number of failed transactions: 49 (7.656%)
   1 number of serialization failures: 49 (7.656%)
   1 number of threads: 4
   1 number of transactions actually processed: 591
   1 number of transactions retried: 343 (53.594%)
   1 total number of retries: 6017
   1 tps = 39.323440 (without initial connection time)
double booked among new rows: 0
##### E5c: one writer forgets SERIALIZABLE. A is SERIALIZABLE, B is READ COMMITTED, both want bay 1 at 09:00
A (serializable): 1
B (read committed): 1
rows for bay 1 at 09:00 = 2
```

The E5a and E5b figures in that output are not used in the comparison. They came from btree indexes and a query that scanned every old row of a bay, which is unfair to SERIALIZABLE. Only E5c is used from this run. The agent ran E5b and E5a again with the GiST shape the real schema would have:

### E5b, second try

Same load as above with GiST indexes and the range query.

<details>
<summary>Script <code>e5b.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
P -q <<'SQL'
-- Second try at E5b. The first try used btree indexes and a query that scanned every old row of a bay,
-- which is unfair to SERIALIZABLE. This one uses the same GiST shape the exclusion constraint would give,
-- as plain indexes (still no exclusion constraint), and the same range query the real code would use.
drop index if exists appt_ser_bay_id_starts_at_idx, appt_ser_technician_id_starts_at_idx, appt_ser_vehicle_id_starts_at_idx;
truncate appt_ser;
insert into appt_ser (dealership_id, bay_id, technician_id, vehicle_id, starts_at, ends_at)
select 3, 301 + (g % 10), 301 + (g % 10), 1 + (g % 2000), timestamptz '2020-01-01' + (g / 10) * interval '1 hour', timestamptz '2020-01-01' + (g / 10 + 1) * interval '1 hour'
from generate_series(1, 300000) g;
create index appt_ser_bay_gist on appt_ser using gist (bay_id, tstzrange(starts_at, ends_at, '[)'));
create index appt_ser_tech_gist on appt_ser using gist (technician_id, tstzrange(starts_at, ends_at, '[)'));
create index appt_ser_veh_gist on appt_ser using gist (vehicle_id, tstzrange(starts_at, ends_at, '[)'));
analyze appt_ser;
create or replace function book_ser(d bigint, v bigint, k bigint) returns text language plpgsql as $$
declare
  s timestamptz := timestamptz '2030-01-01 00:00+00' + k * interval '1 hour';
  e timestamptz := s + interval '1 hour';
  r tstzrange := tstzrange(s, e, '[)');
  b bigint; t bigint;
begin
  if exists (select 1 from appt_ser a where a.vehicle_id = v and tstzrange(a.starts_at, a.ends_at, '[)') && r) then return 'vehicle_busy'; end if;
  select bay.id into b from bays bay where bay.dealership_id = d
    and not exists (select 1 from appt_ser a where a.bay_id = bay.id and tstzrange(a.starts_at, a.ends_at, '[)') && r)
    order by bay.id limit 1;
  select tech.id into t from technicians tech
    join technician_skills q on q.technician_id = tech.id and q.skill_id = 1
    where tech.dealership_id = d
    and not exists (select 1 from appt_ser a where a.technician_id = tech.id and tstzrange(a.starts_at, a.ends_at, '[)') && r)
    order by tech.id limit 1;
  if b is null or t is null then return 'no_slot'; end if;
  insert into appt_ser (dealership_id, bay_id, technician_id, vehicle_id, starts_at, ends_at) values (d, b, t, v, s, e);
  return 'booked';
end $$;
SQL
echo "##### plan check: does the free-bay probe use the GiST index?"
P -At -c "explain (costs off) select 1 from appt_ser a where a.bay_id = 301 and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange('2030-01-05 09:00+00','2030-01-05 10:00+00','[)')"
echo "##### E5b (second try): SERIALIZABLE only, 300000 old rows, GiST indexes. 32 clients, 15s, random dealership and random slot out of 20000"
docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c 32 -j 4 -T 15 --max-tries=50 --failures-detailed -f /tmp/e5_ser.pgb 2>&1 | egrep 'number of|latency average|tps|ERROR' | sort | uniq -c
P -At -c "select 'double booked among new rows: ' || count(*) from appt_ser a join appt_ser b on a.id < b.id and a.starts_at >= '2030-01-01' and b.starts_at >= '2030-01-01' and a.starts_at < b.ends_at and b.starts_at < a.ends_at and (a.bay_id=b.bay_id or a.technician_id=b.technician_id or a.vehicle_id=b.vehicle_id)" -c "select 'new rows: ' || count(*) from appt_ser where starts_at >= '2030-01-01'"
echo "##### same load, 4 clients instead of 32"
docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c 4 -j 4 -T 10 --max-tries=50 --failures-detailed -f /tmp/e5_ser.pgb 2>&1 | egrep 'number of (failed|serial|transactions)|total number|latency average|tps|ERROR' | sort | uniq -c
```

</details>

Output:

```text
##### plan check: does the free-bay probe use the GiST index?
Index Scan using appt_ser_veh_gist on appt_ser a
  Index Cond: (tstzrange(starts_at, ends_at, '[)'::text) && '["2030-01-05 09:00:00+00","2030-01-05 10:00:00+00")'::tstzrange)
  Filter: (bay_id = 301)
##### E5b (second try): SERIALIZABLE only, 300000 old rows, GiST indexes. 32 clients, 15s, random dealership and random slot out of 20000
   1 latency average = 12.730 ms (including failures)
   1 maximum number of tries: 50
   1 number of clients: 32
   1 number of deadlock failures: 0 (0.000%)
   1 number of failed transactions: 20 (0.053%)
   1 number of serialization failures: 20 (0.053%)
   1 number of threads: 4
   1 number of transactions actually processed: 37724
   1 number of transactions retried: 7834 (20.756%)
   1 total number of retries: 29989
   1 tps = 2512.418904 (without initial connection time)
double booked among new rows: 0
new rows: 36982
##### same load, 4 clients instead of 32
   1 latency average = 5.928 ms
   1 number of failed transactions: 0 (0.000%)
   1 number of serialization failures: 0 (0.000%)
   1 number of transactions actually processed: 6749
   1 number of transactions retried: 39 (0.578%)
   1 total number of retries: 57
   1 tps = 674.718433 (without initial connection time)
```

Reading it: on the large table with GiST indexes 21% of transactions were retried at 32 clients and 0.6% at 4 clients. No double booking. In E5c (in the first output above) the READ COMMITTED writer and the SERIALIZABLE writer both booked bay 1.

### E5a, second try

The empty table case again, with the GiST indexes and the range query from the script above.

<details>
<summary>Script <code>e5d.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
# E5a again with the fair setup: GiST indexes and the range query (the book_ser from e5b.sh is installed),
# but with the table starting EMPTY, the way a new installation or a test database looks.
P -q -c "truncate appt_ser" -c "analyze appt_ser"
for c in 32 4; do
  P -q -c "truncate appt_ser" -c "analyze appt_ser"
  echo "##### E5a (second try): SERIALIZABLE only, table starts empty, GiST indexes, $c clients, 15s, random dealership and random slot out of 20000"
  docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c $c -j 4 -T 15 --max-tries=50 --failures-detailed -f /tmp/e5_ser.pgb 2>&1 | egrep 'number of (failed|serial|transactions)|total number|latency average|tps|ERROR' | sort | uniq -c
  P -At -c "select 'double booked: ' || count(*) from appt_ser a join appt_ser b on a.id < b.id and a.starts_at < b.ends_at and b.starts_at < a.ends_at and (a.bay_id=b.bay_id or a.technician_id=b.technician_id or a.vehicle_id=b.vehicle_id)" -c "select 'rows: ' || count(*) from appt_ser"
done
```

</details>

Output:

```text
##### E5a (second try): SERIALIZABLE only, table starts empty, GiST indexes, 32 clients, 15s, random dealership and random slot out of 20000
   1 latency average = 68.929 ms (including failures)
   1 number of failed transactions: 313 (4.500%)
   1 number of serialization failures: 313 (4.500%)
   1 number of transactions actually processed: 6643
   1 number of transactions retried: 4223 (60.710%)
   1 total number of retries: 52355
   1 tps = 443.354001 (without initial connection time)
double booked: 0
rows: 6642
##### E5a (second try): SERIALIZABLE only, table starts empty, GiST indexes, 4 clients, 15s, random dealership and random slot out of 20000
   1 latency average = 7.483 ms (including failures)
   1 number of failed transactions: 2 (0.025%)
   1 number of serialization failures: 2 (0.025%)
   1 number of transactions actually processed: 8017
   1 number of transactions retried: 851 (10.612%)
   1 total number of retries: 3588
   1 tps = 534.422915 (without initial connection time)
double booked: 0
rows: 8011
```

Reading it: starting from an empty table, 61% of transactions were retried at 32 clients and 313 (4.5%) still failed after 50 tries. At 4 clients 11% were retried and 2 failed after 50 tries. No double booking.

### E6, E7 and E8. ON CONFLICT forms, what gets past the constraint, partitioning

Checks: which bad rows the foreign keys and CHECK refuse (E7a), which bad rows an exclusion constraint alone accepts (E7b), how the ON CONFLICT forms behave (E6), and whether a partitioned table can have the constraint (E8).

<details>
<summary>Script <code>e7.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
echo "truncate appointments" | P
echo "##### E7a: gaps the foreign keys close (each should fail)"
P -v VERBOSITY=terse <<SQL
\echo -- bay 11 belongs to dealership 2, appointment says dealership 1
$INS values (1,11,1,1,1,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
\echo -- technician 2 does not have skill 2, service type 2 needs skill 2
$INS values (1,1,2,1,1,2,2,'2027-01-04 09:00+00','2027-01-04 10:00+00');
\echo -- service type 2 needs skill 2 but the row claims skill 1
$INS values (1,1,2,1,1,2,1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
\echo -- vehicle 5 does not belong to customer 1
$INS values (1,1,1,1,5,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
\echo -- zero length (start = end) is stopped by the CHECK, not by the exclusion constraint
$INS values (1,1,1,1,1,1,1,'2027-01-04 09:00+00','2027-01-04 09:00+00');
\echo -- end before start
$INS values (1,1,1,1,1,1,1,'2027-01-04 10:00+00','2027-01-04 09:00+00');
SQL
echo "##### E7b: what the exclusion constraint alone lets through (table with ONLY the exclusion constraint, nullable columns)"
P -v VERBOSITY=terse <<SQL
drop table if exists appt_ex;
create table appt_ex (id bigint generated always as identity primary key, bay_id bigint, starts_at timestamptz, ends_at timestamptz,
  status text default 'confirmed',
  constraint ex_bay exclude using gist (bay_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status = 'confirmed'));
insert into appt_ex (bay_id, starts_at, ends_at) values (1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
\echo -- NULL bay twice at the same time: accepted
insert into appt_ex (bay_id, starts_at, ends_at) values (null,'2027-01-04 09:00+00','2027-01-04 10:00+00'), (null,'2027-01-04 09:00+00','2027-01-04 10:00+00') returning id, bay_id;
\echo -- empty range (start = end) inside a booked hour: accepted
insert into appt_ex (bay_id, starts_at, ends_at) values (1,'2027-01-04 09:30+00','2027-01-04 09:30+00') returning id, isempty(tstzrange(starts_at, ends_at, '[)')) as is_empty;
\echo -- NULL end time means an unbounded range. It is accepted and then blocks the bay forever
insert into appt_ex (bay_id, starts_at, ends_at) values (1,'2027-01-05 09:00+00',null) returning id, tstzrange(starts_at, ends_at, '[)');
insert into appt_ex (bay_id, starts_at, ends_at) values (1,'2028-06-01 09:00+00','2028-06-01 10:00+00');
\echo -- cancelled rows are ignored, and flipping one back to confirmed IS checked
insert into appt_ex (bay_id, starts_at, ends_at, status) values (1,'2027-01-04 09:00+00','2027-01-04 10:00+00','cancelled') returning id, status;
update appt_ex set status = 'confirmed' where status = 'cancelled';
\echo -- a reschedule (UPDATE of the times) IS checked
insert into appt_ex (bay_id, starts_at, ends_at) values (2,'2027-01-04 09:00+00','2027-01-04 10:00+00');
update appt_ex set bay_id = 1 where bay_id = 2;
SQL
echo "##### E6: ON CONFLICT forms on an exclusion constraint"
P -v VERBOSITY=terse <<SQL
truncate appointments;
$INS values (1,1,1,1,1,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00') returning id;
\echo -- no target: bay conflict gives 0 rows and no error, and the transaction stays usable
begin;
$INS values (1,1,2,2,2,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00') on conflict do nothing returning id;
select 'transaction still usable' as note;
commit;
\echo -- named constraint as target: a bay conflict is swallowed
$INS values (1,1,2,2,2,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00') on conflict on constraint appt_bay_no_overlap do nothing returning id;
\echo -- named bay constraint as target, but the conflict is on the technician: still raises 23P01
$INS values (1,2,1,2,2,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00') on conflict on constraint appt_bay_no_overlap do nothing returning id;
\echo -- DO UPDATE is not allowed with an exclusion constraint
$INS values (1,1,2,2,2,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00') on conflict on constraint appt_bay_no_overlap do update set status = 'confirmed';
SQL
echo "##### E8: exclusion constraint on a partitioned table in PostgreSQL 16"
P -v VERBOSITY=terse <<SQL
drop table if exists appt_part;
create table appt_part (bay_id bigint not null, starts_at timestamptz not null, ends_at timestamptz not null,
  exclude using gist (bay_id with =, tstzrange(starts_at, ends_at, '[)') with &&)) partition by range (starts_at);
SQL
```

</details>

Output (error lines can appear one line later than the comment they belong to, because psql writes them to another stream):

```text
##### E7a: gaps the foreign keys close (each should fail)
-- bay 11 belongs to dealership 2, appointment says dealership 1
ERROR:  insert or update on table "appointments" violates foreign key constraint "appointments_bay_id_dealership_id_fkey"
-- technician 2 does not have skill 2, service type 2 needs skill 2
ERROR:  insert or update on table "appointments" violates foreign key constraint "appointments_technician_id_required_skill_id_fkey"
-- service type 2 needs skill 2 but the row claims skill 1
ERROR:  insert or update on table "appointments" violates foreign key constraint "appointments_service_type_id_required_skill_id_fkey"
-- vehicle 5 does not belong to customer 1
-- zero length (start = end) is stopped by the CHECK, not by the exclusion constraint
ERROR:  insert or update on table "appointments" violates foreign key constraint "appointments_vehicle_id_customer_id_fkey"
ERROR:  new row for relation "appointments" violates check constraint "appointments_check"
-- end before start
ERROR:  new row for relation "appointments" violates check constraint "appointments_check"
##### E7b: what the exclusion constraint alone lets through (table with ONLY the exclusion constraint, nullable columns)
-- NULL bay twice at the same time: accepted
 id | bay_id
----+--------
  2 |
  3 |
(2 rows)

-- empty range (start = end) inside a booked hour: accepted
 id | is_empty
----+----------
  4 | t
(1 row)

-- NULL end time means an unbounded range. It is accepted and then blocks the bay forever
 id |          tstzrange
----+-----------------------------
  5 | ["2027-01-05 09:00:00+00",)
(1 row)

ERROR:  conflicting key value violates exclusion constraint "ex_bay"
-- cancelled rows are ignored, and flipping one back to confirmed IS checked
 id |  status
----+-----------
  7 | cancelled
(1 row)

ERROR:  conflicting key value violates exclusion constraint "ex_bay"
-- a reschedule (UPDATE of the times) IS checked
ERROR:  conflicting key value violates exclusion constraint "ex_bay"
##### E6: ON CONFLICT forms on an exclusion constraint
  id
-------
 10818
(1 row)

-- no target: bay conflict gives 0 rows and no error, and the transaction stays usable
 id
----
(0 rows)

           note
--------------------------
 transaction still usable
(1 row)

-- named constraint as target: a bay conflict is swallowed
 id
----
(0 rows)

-- named bay constraint as target, but the conflict is on the technician: still raises 23P01
-- DO UPDATE is not allowed with an exclusion constraint
ERROR:  conflicting key value violates exclusion constraint "appt_tech_no_overlap"
ERROR:  ON CONFLICT DO UPDATE not supported with exclusion constraints
##### E8: exclusion constraint on a partitioned table in PostgreSQL 16
ERROR:  exclusion constraints are not supported on partitioned tables at character 113
```

### E9. The full booking flow under load, four ways

Checks: false rejections, attempts, deadlocks and latency for the whole flow (read a free pair, insert, try again). Four modes: `retry` is plain INSERT with retry on 23P01 and 40P01. `onconflict` is INSERT ... ON CONFLICT DO NOTHING with a re-read on zero rows. `advisory` takes an advisory lock on the dealership first. `rowlock` locks all bay and technician rows of the dealership first. All four run against the table with the exclusion constraints. "Hot" means every client asks for the same 100 ms time bucket at a dealership with 10 bays and 10 technicians. "Spread" means a random dealership and a random slot out of 20,000.

<details>
<summary>Script <code>e9.sql</code></summary>

```sql
-- Dealership 3: 10 bays (301..310) and 10 technicians (301..310), all with skill 1.
insert into dealerships values (3) on conflict do nothing;
insert into bays select 300 + g, 3 from generate_series(1,10) g on conflict do nothing;
insert into technicians select 300 + g, 3 from generate_series(1,10) g on conflict do nothing;
insert into technician_skills select 300 + g, 1 from generate_series(1,10) g on conflict do nothing;
-- technicians 306..310 also have skill 2, so the "fewest skills first" rule has something to do
insert into technician_skills select 300 + g, 2 from generate_series(6,10) g on conflict do nothing;

drop table if exists booklog;
create table booklog (run text, mode text, d bigint, k bigint, outcome text, attempts int, conflicts int, deadlocks int, ms numeric, last_constraint text);

-- The whole booking flow for one request, in one function, so pgbench can drive it.
-- mode: retry      = read free pair, plain INSERT, on 23P01 or 40P01 read again
--       onconflict = read free pair, INSERT ... ON CONFLICT DO NOTHING, on 0 rows read again
--       advisory   = take pg_advisory_xact_lock(dealership), then read and insert once
--       rowlock    = lock all bay rows then all technician rows of the dealership, then read and insert once
drop function if exists book(text,text,bigint,bigint,bigint,int);
create or replace function book(run text, mode text, d bigint, v bigint, k bigint, cap int, dcap int default 3)
returns text language plpgsql as $$
declare
  s timestamptz := timestamptz '2030-01-01 00:00+00' + k * interval '1 hour';
  e timestamptz := s + interval '1 hour';
  r tstzrange := tstzrange(s, e, '[)');
  b bigint; t bigint; got bigint; c text; n text;
  attempts int := 0; conflicts int := 0; deadlocks int := 0; outcome text;
  t0 timestamptz := clock_timestamp();
begin
  if mode = 'advisory' then
    perform pg_advisory_xact_lock(1001, d::int);
  elsif mode = 'rowlock' then
    perform 1 from bays where dealership_id = d order by id for no key update;
    perform 1 from technicians where dealership_id = d order by id for no key update;
  end if;
  loop
    attempts := attempts + 1;
    -- fresh read on every attempt (each statement gets a new snapshot at READ COMMITTED)
    select bay.id into b from bays bay where bay.dealership_id = d
      and not exists (select 1 from appointments a where a.bay_id = bay.id and a.status = 'confirmed'
                      and tstzrange(a.starts_at, a.ends_at, '[)') && r)
      order by bay.id limit 1;
    select tech.id into t from technicians tech
      join technician_skills q on q.technician_id = tech.id and q.skill_id = 1
      where tech.dealership_id = d
      and not exists (select 1 from appointments a where a.technician_id = tech.id and a.status = 'confirmed'
                      and tstzrange(a.starts_at, a.ends_at, '[)') && r)
      order by (select count(*) from technician_skills x where x.technician_id = tech.id), tech.id limit 1;
    if b is null or t is null then outcome := 'no_slot'; exit; end if;
    if conflicts >= cap then outcome := 'gave_up_conflicts'; exit; end if;
    if deadlocks >= dcap then outcome := 'gave_up_deadlocks'; exit; end if;
    begin
      if mode = 'onconflict' then
        insert into appointments (dealership_id,bay_id,technician_id,customer_id,vehicle_id,service_type_id,required_skill_id,starts_at,ends_at)
        values (d,b,t,v,v,1,1,s,e) on conflict do nothing returning id into got;
        if got is null then
          -- we cannot tell which constraint fired, so check the vehicle by hand
          if exists (select 1 from appointments a where a.vehicle_id = v and a.status = 'confirmed'
                     and tstzrange(a.starts_at, a.ends_at, '[)') && r) then outcome := 'vehicle_busy'; exit; end if;
          conflicts := conflicts + 1; continue;
        end if;
      else
        insert into appointments (dealership_id,bay_id,technician_id,customer_id,vehicle_id,service_type_id,required_skill_id,starts_at,ends_at)
        values (d,b,t,v,v,1,1,s,e);
      end if;
      outcome := 'booked'; exit;
    exception
      when exclusion_violation then
        get stacked diagnostics n = constraint_name;
        if n = 'appt_vehicle_no_overlap' then outcome := 'vehicle_busy'; exit; end if;
        conflicts := conflicts + 1;
      when deadlock_detected then
        deadlocks := deadlocks + 1;
    end;
  end loop;
  insert into booklog values (run, mode, d, k, outcome, attempts, conflicts, deadlocks,
    round(extract(epoch from clock_timestamp() - t0) * 1000, 1), n);
  return outcome;
end $$;
```

</details>

<details>
<summary>Script <code>e9_hot_retry.pgb</code></summary>

```sql
\set v random(1, 2000)
select book('hot', 'retry', 3, :v, floor(extract(epoch from clock_timestamp()) * 10)::bigint % 100000, 21);
```

</details>

<details>
<summary>Script <code>e9_spread_retry.pgb</code></summary>

```sql
\set v random(1, 2000)
\set k random(1, 20000)
\set d random(1, 3)
select book('spread', 'retry', :d, :v, :k, 21);
```

</details>

<details>
<summary>Script <code>e9.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
for f in e9.sql e9_*.pgb; do docker cp $f concopt-pg16:/tmp/$f; done
P -f /tmp/e9.sql
for m in retry onconflict advisory rowlock; do
  echo "truncate appointments" | P
  echo "##### E9 hot: mode=$m, 32 clients, 15s, every client asks for the same 100ms time bucket at dealership 3 (10 bays, 10 technicians)"
  docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c 32 -j 4 -T 15 -f /tmp/e9_hot_$m.pgb 2>&1 | egrep 'number of (transactions|failed)|latency average|tps|ERROR' | sort | uniq -c | head -8
  P -At <<SQL
select 'buckets where someone got no_slot while fewer than 10 appointments exist: ' || count(*) from (
  select l.k from booklog l where l.run='hot' and l.mode='$m' and l.outcome='no_slot'
  and l.outcome = 'no_slot'
  group by l.k having (select count(*) from appointments a where a.dealership_id=3
     and a.starts_at = timestamptz '2030-01-01 00:00+00' + l.k * interval '1 hour') < 10) x;
select 'requests that gave up while their bucket still had a free pair: ' || count(*) from booklog l where l.run='hot' and l.mode='$m' and l.outcome like 'gave_up%'
  and (select count(*) from appointments a where a.dealership_id=3 and a.starts_at = timestamptz '2030-01-01 00:00+00' + l.k * interval '1 hour') < 10;
select 'double booked (bay, technician or vehicle): ' || count(*) from appointments a join appointments b on a.id < b.id
  and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')
  and (a.bay_id=b.bay_id or a.technician_id=b.technician_id or a.vehicle_id=b.vehicle_id);
SQL
done
for m in retry onconflict advisory rowlock; do
  echo "truncate appointments" | P
  echo "##### E9 spread: mode=$m, 32 clients, 15s, random dealership (1 to 3) and random slot out of 20000"
  docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c 32 -j 4 -T 15 -f /tmp/e9_spread_$m.pgb 2>&1 | egrep 'number of (transactions|failed)|latency average|tps|ERROR' | sort | uniq -c | head -8
done
P <<SQL
select run, mode, outcome, count(*) as requests, max(attempts) as max_attempts, round(avg(attempts),2) as avg_attempts,
  sum(conflicts) as conflicts_23p01, sum(deadlocks) as deadlocks_40p01,
  round(avg(ms),1) as avg_ms, percentile_disc(0.99) within group (order by ms) as p99_ms, max(ms) as max_ms
from booklog group by 1,2,3 order by 1,2,3;
SQL
```

</details>

Notes from the first run of the `retry` mode, written up by hand rather than pasted, before the function had a separate cap for deadlocks (it gave up only after 21 conflicts and deadlocks together):

```text
First run of E9 hot, mode=retry (plain INSERT, retry on 23P01 and 40P01 with no cap on deadlocks that mattered, no backoff), 32 clients.
After 45 finished requests all 32 sessions were stuck for more than 6 minutes. Samples 3 seconds apart:

     at     | finished_requests | waiting_sessions |        sessions_that_block_others
 07:08:57.4 |                45 |               32 | 569 waits for {575}, 575 waits for {569}
 07:09:00.4 |                45 |               32 | 566 waits for {571}, 571 waits for {566}
 07:09:03.4 |                45 |               32 | 576 waits for {597}, 597 waits for {576}

Every other session waits for one of the pair. The deadlocked pair changes each second (deadlock_timeout = 1s),
the victim retries at once, rejoins the pile, and nobody ever commits. Killed by hand.
```

Output of the full run, with a cap of 3 deadlocks per request:

```text
##### E9 hot: mode=retry, 32 clients, 15s, every client asks for the same 100ms time bucket at dealership 3 (10 bays, 10 technicians)
   1 latency average = 89469.656 ms
   1 number of failed transactions: 0 (0.000%)
   1 number of transactions actually processed: 33
   1 tps = 0.357663 (without initial connection time)
buckets where someone got no_slot while fewer than 10 appointments exist: 0
requests that gave up while their bucket still had a free pair: 31
double booked (bay, technician or vehicle): 0
##### E9 hot: mode=onconflict, 32 clients, 15s, every client asks for the same 100ms time bucket at dealership 3 (10 bays, 10 technicians)
   1 latency average = 6.709 ms
   1 number of failed transactions: 0 (0.000%)
   1 number of transactions actually processed: 71564
   1 tps = 4769.665556 (without initial connection time)
buckets where someone got no_slot while fewer than 10 appointments exist: 0
requests that gave up while their bucket still had a free pair: 0
double booked (bay, technician or vehicle): 0
##### E9 hot: mode=advisory, 32 clients, 15s, every client asks for the same 100ms time bucket at dealership 3 (10 bays, 10 technicians)
   1 latency average = 64.302 ms
   1 number of failed transactions: 0 (0.000%)
   1 number of transactions actually processed: 7489
   1 tps = 497.654796 (without initial connection time)
buckets where someone got no_slot while fewer than 10 appointments exist: 0
requests that gave up while their bucket still had a free pair: 0
double booked (bay, technician or vehicle): 0
##### E9 hot: mode=rowlock, 32 clients, 15s, every client asks for the same 100ms time bucket at dealership 3 (10 bays, 10 technicians)
   1 latency average = 68.664 ms
   1 number of failed transactions: 0 (0.000%)
   1 number of transactions actually processed: 7015
   1 tps = 466.035449 (without initial connection time)
buckets where someone got no_slot while fewer than 10 appointments exist: 0
requests that gave up while their bucket still had a free pair: 0
double booked (bay, technician or vehicle): 0
##### E9 spread: mode=retry, 32 clients, 15s, random dealership (1 to 3) and random slot out of 20000
   1 latency average = 8.667 ms
   1 number of failed transactions: 0 (0.000%)
   1 number of transactions actually processed: 55447
   1 tps = 3691.964931 (without initial connection time)
##### E9 spread: mode=onconflict, 32 clients, 15s, random dealership (1 to 3) and random slot out of 20000
   1 latency average = 10.371 ms
   1 number of failed transactions: 0 (0.000%)
   1 number of transactions actually processed: 46269
   1 tps = 3085.398707 (without initial connection time)
##### E9 spread: mode=advisory, 32 clients, 15s, random dealership (1 to 3) and random slot out of 20000
   1 latency average = 67.014 ms
   1 number of failed transactions: 0 (0.000%)
   1 number of transactions actually processed: 7195
   1 tps = 477.511498 (without initial connection time)
##### E9 spread: mode=rowlock, 32 clients, 15s, random dealership (1 to 3) and random slot out of 20000
   1 latency average = 65.935 ms
   1 number of failed transactions: 0 (0.000%)
   1 number of transactions actually processed: 7355
   1 tps = 485.326639 (without initial connection time)
  run   |    mode    |      outcome      | requests | max_attempts | avg_attempts | conflicts_23p01 | deadlocks_40p01 | avg_ms  | p99_ms  | max_ms
--------+------------+-------------------+----------+--------------+--------------+-----------------+-----------------+---------+---------+---------
 hot    | advisory   | booked            |     1492 |            1 |         1.00 |               0 |               0 |    61.5 |    97.3 |   188.3
 hot    | advisory   | no_slot           |     5994 |            1 |         1.00 |               0 |               0 |    62.4 |   112.5 |   188.5
 hot    | advisory   | vehicle_busy      |        3 |            1 |         1.00 |               0 |               0 |    58.9 |    60.3 |    60.3
 hot    | onconflict | booked            |     1510 |           10 |         4.46 |            5224 |               0 |    10.9 |    32.9 |    47.3
 hot    | onconflict | no_slot           |    70030 |           11 |         1.49 |           34272 |               0 |     2.0 |    29.9 |    71.6
 hot    | onconflict | vehicle_busy      |       24 |            8 |         2.96 |              47 |               0 |     9.6 |    28.6 |    28.6
 hot    | retry      | booked            |        2 |            4 |         2.50 |               1 |               2 | 46120.6 | 92235.2 | 92235.2
 hot    | retry      | gave_up_deadlocks |       31 |            5 |         4.94 |              29 |              93 | 77137.8 | 92234.7 | 92234.7
 hot    | rowlock    | booked            |     1510 |            1 |         1.00 |               0 |               0 |    66.7 |   120.9 |   154.1
 hot    | rowlock    | no_slot           |     5501 |            1 |         1.00 |               0 |               0 |    66.4 |   108.8 |   178.7
 hot    | rowlock    | vehicle_busy      |        4 |            1 |         1.00 |               0 |               0 |    65.8 |    66.6 |    66.6
 spread | advisory   | booked            |     7190 |            1 |         1.00 |               0 |               0 |    61.0 |   175.4 |   202.8
 spread | advisory   | no_slot           |        5 |            1 |         1.00 |               0 |               0 |    23.2 |    86.4 |    86.4
 spread | onconflict | booked            |    44990 |            2 |         1.00 |              12 |               0 |     1.1 |     3.0 |    25.0
 spread | onconflict | no_slot           |     1258 |            2 |         1.00 |               1 |               0 |     0.5 |     1.7 |     3.1
 spread | onconflict | vehicle_busy      |       21 |            1 |         1.00 |               0 |               0 |     0.9 |     1.5 |     1.5
 spread | retry      | booked            |    53374 |            2 |         1.00 |              19 |               0 |     1.0 |     2.9 |    49.9
 spread | retry      | no_slot           |     2036 |            2 |         1.00 |               2 |               0 |     0.5 |     1.9 |     4.6
 spread | retry      | vehicle_busy      |       37 |            1 |         1.00 |               0 |               0 |     1.2 |     2.9 |     2.9
 spread | rowlock    | booked            |     7352 |            1 |         1.00 |               0 |               0 |    60.0 |   187.6 |   287.0
 spread | rowlock    | no_slot           |        3 |            1 |         1.00 |               0 |               0 |    71.7 |    94.5 |    94.5
(21 rows)
```

Reading it: the pgbench scripts for the other modes differ only in the mode name. In the hot run, `retry` finished 33 requests in 92 seconds and 31 of them gave up on deadlocks while their time bucket still had free pairs. The other three modes had no request refused while a pair was free and no double booking. `onconflict` needed up to 10 attempts for a booking and 11 for a "no slot" (10 bays, 10 technicians). `advisory` and `rowlock` always needed 1 attempt and waited about 60 ms in the queue.

### E9b. Plain INSERT with retry at 2, 4 and 8 clients

Checks: whether the deadlock problem needs 32 clients to show. It does not.

<details>
<summary>Script <code>e9b.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
for c in 2 4 8; do
  P -q -c "truncate appointments"
  sed "s/'hot', 'retry'/'hot$c', 'retry'/" e9_hot_retry.pgb > e9_hot_retry_$c.pgb
  docker cp e9_hot_retry_$c.pgb concopt-pg16:/tmp/e9_hot_retry_$c.pgb
  echo "##### E9b: plain INSERT with retry, $c clients, 15s, all asking for the same 100ms bucket at dealership 3"
  docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c $c -j 2 -T 15 -f /tmp/e9_hot_retry_$c.pgb 2>&1 | egrep 'number of transactions|latency average|tps|ERROR' | sort | uniq -c
done
P <<SQL
select run, outcome, count(*) as requests, max(attempts) as max_attempts, sum(conflicts) as conflicts_23p01, sum(deadlocks) as deadlocks_40p01,
  round(avg(ms),1) as avg_ms, percentile_disc(0.99) within group (order by ms) as p99_ms, max(ms) as max_ms
from booklog where run in ('hot2','hot4','hot8') group by 1,2 order by 1,2;
SQL
```

</details>

Output:

```text
##### E9b: plain INSERT with retry, 2 clients, 15s, all asking for the same 100ms bucket at dealership 3
   1 latency average = 30.060 ms
   1 number of transactions actually processed: 1039
   1 tps = 66.532803 (without initial connection time)
##### E9b: plain INSERT with retry, 4 clients, 15s, all asking for the same 100ms bucket at dealership 3
   1 latency average = 220.836 ms
   1 number of transactions actually processed: 386
   1 tps = 18.112998 (without initial connection time)
##### E9b: plain INSERT with retry, 8 clients, 15s, all asking for the same 100ms bucket at dealership 3
   1 latency average = 1994.346 ms
   1 number of transactions actually processed: 85
   1 tps = 4.011341 (without initial connection time)
 run  |      outcome      | requests | max_attempts | conflicts_23p01 | deadlocks_40p01 | avg_ms  | p99_ms  | max_ms
------+-------------------+----------+--------------+-----------------+-----------------+---------+---------+---------
 hot2 | booked            |      393 |            6 |             339 |               8 |    51.5 |  1037.3 |  4007.2
 hot2 | gave_up_deadlocks |        1 |            5 |               1 |               3 |  4009.2 |  4009.2 |  4009.2
 hot2 | no_slot           |      644 |            5 |              38 |               1 |     2.0 |     2.8 |  1032.4
 hot2 | vehicle_busy      |        1 |            2 |               1 |               0 |     2.1 |     2.1 |     2.1
 hot4 | booked            |      164 |            6 |              54 |               9 |   215.4 |  9012.2 | 11014.4
 hot4 | gave_up_deadlocks |        5 |            5 |               3 |              15 |  8817.5 | 11025.6 | 11025.6
 hot4 | no_slot           |      217 |            2 |               4 |               0 |     0.3 |     2.4 |     2.6
 hot8 | booked            |       20 |            8 |              44 |               2 |  1065.9 | 21022.5 | 21022.5
 hot8 | gave_up_deadlocks |        7 |            5 |               6 |              21 | 18596.5 | 21029.5 | 21029.5
 hot8 | no_slot           |       57 |            8 |              26 |               0 |     3.4 |    38.8 |    38.8
 hot8 | vehicle_busy      |        1 |            2 |               1 |               0 |     5.2 |     5.2 |     5.2
(11 rows)
```

### E9c. Why the lock modes are slower

Checks: whether waiting for the disk while holding the lock explains the gap. Same spread load, with `synchronous_commit` on and off.

<details>
<summary>Script <code>e9c.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
# Why are the two lock modes slower? Run the spread load again with synchronous_commit off,
# so a commit no longer waits for the disk. If the lock modes speed up a lot, the wait for the disk
# while holding the lock is the reason.
for m in advisory onconflict; do
  for sc in on off; do
    P -q -c "truncate appointments"
    echo "##### E9c spread: mode=$m, synchronous_commit=$sc, 32 clients, 10s"
    docker exec -e PGOPTIONS="-c synchronous_commit=$sc" concopt-pg16 pgbench -U postgres -d postgres -n -c 32 -j 4 -T 10 -f /tmp/e9_spread_$m.pgb 2>&1 | egrep 'latency average|tps' | tr '\n' ' '; echo
  done
done
```

</details>

Output:

```text
##### E9c spread: mode=advisory, synchronous_commit=on, 32 clients, 10s
latency average = 35.317 ms tps = 906.070764 (without initial connection time)
##### E9c spread: mode=advisory, synchronous_commit=off, 32 clients, 10s
latency average = 8.389 ms tps = 3814.383194 (without initial connection time)
##### E9c spread: mode=onconflict, synchronous_commit=on, 32 clients, 10s
latency average = 6.885 ms tps = 4647.791609 (without initial connection time)
##### E9c spread: mode=onconflict, synchronous_commit=off, 32 clients, 10s
latency average = 4.795 ms tps = 6674.041061 (without initial connection time)
```

Reading it: with the disk wait removed, the advisory lock mode got about 4 times faster and the optimistic mode about 1.4 times faster. Also note that the advisory lock mode did 906 per second here and 478 per second in E9 for the same test, so single figures from this setup should not be leaned on.

### E9d. Does a random pause after a deadlock help plain INSERT

Checks: the usual advice to pause for a random time before retrying. The `book` function from E9 got one more mode, `retry_pause`, by adding these lines to its deadlock handler:

```sql
      when deadlock_detected then
        deadlocks := deadlocks + 1;
        -- mode retry_pause: wait a random 0 to 100 ms before the next try
        if mode = 'retry_pause' then perform pg_sleep(random() * 0.1); end if;
```

<details>
<summary>Script <code>e9d.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
# Does a random pause after a deadlock help plain INSERT? Same hot load as E9b at 8 clients, with and without the pause.
# Reload only the function, keep the booklog rows from earlier runs.
sed -n '/^create or replace function book/,$p' e9.sql > e9_fn.sql
docker cp e9_fn.sql concopt-pg16:/tmp/e9_fn.sql
P -q -c "drop function if exists book(text,text,bigint,bigint,bigint,int,int)" -f /tmp/e9_fn.sql
for m in retry retry_pause; do
  P -q -c "truncate appointments"
  printf '%s\n' '\set v random(1, 2000)' "select book('e9d', '$m', 3, :v, floor(extract(epoch from clock_timestamp()) * 10)::bigint % 100000, 21);" > e9d_$m.pgb
  docker cp e9d_$m.pgb concopt-pg16:/tmp/e9d_$m.pgb
  echo "##### E9d: mode=$m, 8 clients, 15s, all asking for the same 100ms bucket at dealership 3"
  docker exec concopt-pg16 pgbench -U postgres -d postgres -n -c 8 -j 2 -T 15 -f /tmp/e9d_$m.pgb 2>&1 | egrep 'number of transactions|latency average|tps|ERROR' | sort | uniq -c
done
P <<SQL
select mode, outcome, count(*) as requests, max(attempts) as max_attempts, sum(conflicts) as conflicts_23p01, sum(deadlocks) as deadlocks_40p01,
  round(avg(ms),1) as avg_ms, percentile_disc(0.99) within group (order by ms) as p99_ms, max(ms) as max_ms
from booklog where run = 'e9d' group by 1,2 order by 1,2;
SQL
```

</details>

Output:

```text
##### E9d: mode=retry, 8 clients, 15s, all asking for the same 100ms bucket at dealership 3
   1 latency average = 579.325 ms
   1 number of transactions actually processed: 291
   1 tps = 13.809165 (without initial connection time)
##### E9d: mode=retry_pause, 8 clients, 15s, all asking for the same 100ms bucket at dealership 3
   1 latency average = 1724.670 ms
   1 number of transactions actually processed: 103
   1 tps = 4.638568 (without initial connection time)
    mode     |      outcome      | requests | max_attempts | conflicts_23p01 | deadlocks_40p01 | avg_ms  | p99_ms  | max_ms
-------------+-------------------+----------+--------------+-----------------+-----------------+---------+---------+---------
 retry       | booked            |      103 |            7 |              10 |               2 |   205.5 |    28.2 | 21050.8
 retry       | gave_up_deadlocks |        7 |            8 |              18 |              21 | 17747.6 | 21049.4 | 21049.4
 retry       | no_slot           |      181 |            1 |               0 |               0 |     0.2 |     0.5 |     0.7
 retry_pause | booked            |       24 |            8 |              45 |               2 |   931.9 | 22017.1 | 22017.1
 retry_pause | gave_up_deadlocks |        7 |            9 |              28 |              21 | 19057.3 | 22072.5 | 22072.5
 retry_pause | no_slot           |       72 |            9 |              32 |               0 |     2.9 |    43.0 |    43.0
(6 rows)
```

Reading it: 7 requests gave up on deadlocks in both runs, and the longest stall was 21 to 22 seconds in both. The pause made no visible difference. This is one run of each, so it only says the pause is not a cure.

### E10. Smaller checks

Checks: FOR UPDATE against FOR NO KEY UPDATE with the foreign key check (E10a), a transaction after 23P01 (E10b), ON CONFLICT DO NOTHING at REPEATABLE READ (E10c), a deferrable exclusion constraint (E10d), and whether `btree_gist` is a trusted extension (E10e).

<details>
<summary>Script <code>e10.sh</code></summary>

```bash
cd "$(dirname "$0")"; . ./lib.sh
P -q -c "truncate appointments"
echo "##### E10a: FOR UPDATE on a bay row blocks an appointment insert that references the bay (the foreign key check). FOR NO KEY UPDATE does not."
for mode in "for update" "for no key update"; do
  ( P -At <<SQL
begin;
select id from bays where id = 2 $mode;
select pg_sleep(2);
commit;
SQL
  ) > A.out 2>&1 &
  ( P -At -v VERBOSITY=terse <<SQL
select pg_sleep(0.7) \gset x_
set lock_timeout = '300ms';
$INS values (1,2,2,2,2,1,1,'2027-02-01 09:00+00','2027-02-01 10:00+00') returning 'inserted while bay row was locked' as result;
SQL
  ) > B.out 2>&1 &
  wait
  echo "holder used: $mode  ->  $(tr '\n' ' ' < B.out)"
  P -q -c "truncate appointments"
done
echo "##### E10b: after a 23P01 the transaction is dead until rollback"
P -v VERBOSITY=verbose 2>&1 <<SQL | egrep 'ERROR|note'
$INS values (1,1,1,1,1,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
begin;
$INS values (1,1,2,2,2,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
select 'still alive' as note;
rollback;
SQL
echo "##### E10c: ON CONFLICT DO NOTHING at REPEATABLE READ, when the conflicting row was committed after our snapshot"
P -q -c "truncate appointments"
( P -At -v VERBOSITY=verbose <<SQL
begin isolation level repeatable read;
select count(*) from appointments;
select pg_sleep(1.5) \gset x_
$INS values (1,1,2,2,2,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00') on conflict do nothing returning id;
commit;
SQL
) > A.out 2>&1 &
( P -At <<SQL
select pg_sleep(0.5) \gset x_
$INS values (1,1,1,1,1,1,1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
SQL
) > B.out 2>&1 &
wait
grep -E 'ERROR|^[0-9]+$' A.out
echo "##### E10d: a DEFERRABLE exclusion constraint cannot be used with ON CONFLICT, and reports the conflict at COMMIT"
P -v VERBOSITY=terse 2>&1 <<SQL
drop table if exists appt_def;
create table appt_def (bay_id bigint not null, starts_at timestamptz not null, ends_at timestamptz not null,
  constraint def_bay exclude using gist (bay_id with =, tstzrange(starts_at, ends_at, '[)') with &&) deferrable initially deferred);
insert into appt_def values (1,'2027-01-04 09:00+00','2027-01-04 10:00+00');
insert into appt_def values (1,'2027-01-04 09:00+00','2027-01-04 10:00+00') on conflict on constraint def_bay do nothing;
begin;
insert into appt_def values (1,'2027-01-04 09:00+00','2027-01-04 10:00+00') returning 'insert accepted for now' as note;
commit;
SQL
echo "##### E10e: is btree_gist a trusted extension (installable without superuser)?"
P -At -c "select name, version, trusted from pg_available_extension_versions where name = 'btree_gist' order by version desc limit 1"
```

</details>

Output:

```text
##### E10a: FOR UPDATE on a bay row blocks an appointment insert that references the bay (the foreign key check). FOR NO KEY UPDATE does not.
holder used: for update  ->  ERROR:  canceling statement due to lock timeout
holder used: for no key update  ->  inserted while bay row was locked
##### E10b: after a 23P01 the transaction is dead until rollback
ERROR:  23P01: conflicting key value violates exclusion constraint "appt_bay_no_overlap"
ERROR:  25P02: current transaction is aborted, commands ignored until end of transaction block
##### E10c: ON CONFLICT DO NOTHING at REPEATABLE READ, when the conflicting row was committed after our snapshot
0
ERROR:  40001: could not serialize access due to concurrent update
##### E10d: a DEFERRABLE exclusion constraint cannot be used with ON CONFLICT, and reports the conflict at COMMIT
ERROR:  ON CONFLICT does not support deferrable unique constraints/exclusion constraints as arbiters
          note
-------------------------
 insert accepted for now
(1 row)

ERROR:  conflicting key value violates exclusion constraint "def_bay"
##### E10e: is btree_gist a trusted extension (installable without superuser)?
btree_gist|1.7|t
```
