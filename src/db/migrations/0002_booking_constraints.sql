-- The rules that keep bad rows out of the database, in one file.
--
-- The main one is the three exclusion constraints at the bottom. They are the
-- real guarantee against double booking: no two appointments that aren't
-- cancelled can overlap on the same bay, the same technician or the same
-- vehicle. They hold for every writer at every isolation level, the API, a
-- script or somebody in psql. The booking code only checks first so it can
-- give a friendly answer (ADR 001).
--
-- The rest closes the gaps an exclusion constraint can't see:
-- - an empty range (start = end) overlaps nothing, so it would slip past
--   every exclusion constraint. CHECK (ends_at > starts_at) stops it.
-- - a bay or technician from another dealership. The composite foreign keys
--   on (dealership_id, service_bay_id) and (dealership_id, technician_id)
--   stop it, which is why bays and technicians get UNIQUE (dealership_id, id).
-- - deleting a bay, technician, vehicle or customer that has appointments.
--   Every foreign key is ON DELETE RESTRICT, so nothing quietly disappears.
-- - two in-flight requests with the same idempotency key from one customer.
--   The partial unique index lets only one of them in.
--
-- Not checked here on purpose: that the technician has the required skill,
-- and that the vehicle belongs to the customer. Both are facts at booking
-- time that may change later (a skill gets removed, a car gets sold), so the
-- booking service checks them. See ADR 001.
--
-- Ranges are half open, '[)', so a job ending at 10:00 doesn't clash with one
-- starting at 10:00 (ADR 002). The booking read uses exactly the same range
-- expression and status filter as these constraints.

-- Opening hours and service types

ALTER TABLE opening_hours
  ADD CONSTRAINT opening_hours_iso_weekday_check CHECK (iso_weekday BETWEEN 1 AND 7),
  ADD CONSTRAINT opening_hours_opens_before_closes CHECK (opens_at < closes_at);

ALTER TABLE service_types
  ADD CONSTRAINT service_types_duration_minutes_check CHECK (duration_minutes BETWEEN 1 AND 600);

-- Targets for the composite foreign keys from appointments. id alone is
-- already unique, this pair just gives the foreign key something to point at.

ALTER TABLE service_bays
  ADD CONSTRAINT service_bays_dealership_id_id_key UNIQUE (dealership_id, id);

ALTER TABLE technicians
  ADD CONSTRAINT technicians_dealership_id_id_key UNIQUE (dealership_id, id);

-- Appointments

ALTER TABLE appointments
  ADD CONSTRAINT appointments_dealership_id_fkey
    FOREIGN KEY (dealership_id) REFERENCES dealerships (id) ON DELETE RESTRICT,
  ADD CONSTRAINT appointments_service_type_id_fkey
    FOREIGN KEY (service_type_id) REFERENCES service_types (id) ON DELETE RESTRICT,
  ADD CONSTRAINT appointments_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
  ADD CONSTRAINT appointments_vehicle_id_fkey
    FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE RESTRICT,
  ADD CONSTRAINT appointments_service_bay_fkey
    FOREIGN KEY (dealership_id, service_bay_id) REFERENCES service_bays (dealership_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT appointments_technician_fkey
    FOREIGN KEY (dealership_id, technician_id) REFERENCES technicians (dealership_id, id) ON DELETE RESTRICT,

  ADD CONSTRAINT appointments_ends_after_starts CHECK (ends_at > starts_at),
  ADD CONSTRAINT appointments_status_check CHECK (status IN ('confirmed', 'cancelled')),
  -- A key is only useful with the hash of the request it came with, so the
  -- two are both set or both empty.
  ADD CONSTRAINT appointments_idempotency_pair_check
    CHECK ((idempotency_key IS NULL) = (request_hash IS NULL)),

  -- "Not cancelled" rather than "confirmed", so any status added later (say
  -- in_progress) holds its bay by default, which is the safer mistake. The
  -- vehicle one has no dealership in it, a car can't be in two places at once.
  ADD CONSTRAINT appointments_no_bay_overlap EXCLUDE USING gist
    (service_bay_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status <> 'cancelled'),
  ADD CONSTRAINT appointments_no_technician_overlap EXCLUDE USING gist
    (technician_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status <> 'cancelled'),
  ADD CONSTRAINT appointments_no_vehicle_overlap EXCLUDE USING gist
    (vehicle_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status <> 'cancelled');

-- Rows without a key don't count, so any number of them is fine. The same key
-- for two different customers is fine too.
CREATE UNIQUE INDEX appointments_customer_idempotency_key_unique
  ON appointments (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- For listing a dealership's day.
CREATE INDEX appointments_dealership_starts_at_idx ON appointments (dealership_id, starts_at);
