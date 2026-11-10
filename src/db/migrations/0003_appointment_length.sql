-- No appointment row is longer than 600 minutes.
--
-- 0002 already caps service_types.duration_minutes at 600, but that only
-- covers rows the booking service writes. This puts the same limit on the
-- rows themselves, so it holds for every writer (a script, somebody in psql).
--
-- The availability day query depends on it. It only reads rows that start
-- less than 600 minutes before the local day, so Postgres can use the
-- (dealership_id, starts_at) index as a real range instead of reading the
-- dealership's whole history. A longer row could overlap the day and still
-- be missed by that bound, this CHECK makes sure there is no such row.
--
-- If a job ever needs more than 600 minutes, this CHECK and the bound in
-- availability.reader.ts have to change together.

ALTER TABLE appointments
  ADD CONSTRAINT appointments_at_most_600_minutes
    CHECK (ends_at - starts_at <= interval '600 minutes');
