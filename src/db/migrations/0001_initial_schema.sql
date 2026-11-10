-- The tables. The design and the reasons for every constraint are in
-- docs/DESIGN.md section 3 and docs/adr/001-no-double-booking.md.
--
-- Everything that protects appointments from bad rows (the exclusion
-- constraints, the checks, the foreign keys from appointments and the
-- idempotency index) lives in 0002_booking_constraints.sql, so the rules that
-- matter most can be read in one place. It was also written that way on
-- purpose for test-first: the AC-21 tests ran red against this file alone.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE dealerships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- IANA zone, for example Europe/London. Checked by the app with Luxon.
  time_zone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One opening window per weekday in local wall time. No row means closed.
CREATE TABLE opening_hours (
  dealership_id uuid NOT NULL REFERENCES dealerships (id) ON DELETE RESTRICT,
  iso_weekday integer NOT NULL,
  opens_at time NOT NULL,
  closes_at time NOT NULL,
  PRIMARY KEY (dealership_id, iso_weekday)
);

CREATE TABLE service_bays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id uuid NOT NULL REFERENCES dealerships (id) ON DELETE RESTRICT,
  name text NOT NULL
);

CREATE TABLE skills (
  code text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE technicians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id uuid NOT NULL REFERENCES dealerships (id) ON DELETE RESTRICT,
  name text NOT NULL
);

CREATE TABLE technician_skills (
  technician_id uuid NOT NULL REFERENCES technicians (id) ON DELETE RESTRICT,
  skill_code text NOT NULL REFERENCES skills (code) ON DELETE RESTRICT,
  PRIMARY KEY (technician_id, skill_code)
);

CREATE TABLE service_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  duration_minutes integer NOT NULL,
  required_skill_code text NOT NULL REFERENCES skills (code) ON DELETE RESTRICT
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL
);

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  vin text NOT NULL UNIQUE,
  make text NOT NULL,
  model text NOT NULL,
  year integer NOT NULL
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id uuid NOT NULL,
  service_type_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  service_bay_id uuid NOT NULL,
  technician_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed',
  idempotency_key text,
  request_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
