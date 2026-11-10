import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

// Hand-written table types for Kysely. They have to match
// migrations/0001_initial_schema.sql. There is no code generation on purpose,
// the schema is small and the SQL file is the source of truth.

// pg hands timestamptz back as a Date. On insert I also allow an ISO string,
// which is handy in tests and the seed.
type Timestamp = ColumnType<Date, Date | string, Date | string>;

// Same as Timestamp but the database fills it in with now().
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;

// pg hands the time type back as a string like '08:00:00'.
type WallTime = string;

export type AppointmentStatus = 'confirmed' | 'cancelled';

export interface DealershipsTable {
  id: Generated<string>;
  name: string;
  time_zone: string;
  created_at: CreatedAt;
}

export interface OpeningHoursTable {
  dealership_id: string;
  // 1 is Monday, 7 is Sunday (ISO 8601, same as Luxon's weekday)
  iso_weekday: number;
  opens_at: WallTime;
  closes_at: WallTime;
}

export interface ServiceBaysTable {
  id: Generated<string>;
  dealership_id: string;
  name: string;
}

export interface SkillsTable {
  code: string;
  name: string;
}

export interface TechniciansTable {
  id: Generated<string>;
  dealership_id: string;
  name: string;
}

export interface TechnicianSkillsTable {
  technician_id: string;
  skill_code: string;
}

export interface ServiceTypesTable {
  id: Generated<string>;
  code: string;
  name: string;
  duration_minutes: number;
  required_skill_code: string;
}

export interface CustomersTable {
  id: Generated<string>;
  name: string;
  email: string;
}

export interface VehiclesTable {
  id: Generated<string>;
  customer_id: string;
  vin: string;
  make: string;
  model: string;
  year: number;
}

export interface AppointmentsTable {
  id: Generated<string>;
  dealership_id: string;
  service_type_id: string;
  customer_id: string;
  vehicle_id: string;
  service_bay_id: string;
  technician_id: string;
  starts_at: Timestamp;
  ends_at: Timestamp;
  status: ColumnType<AppointmentStatus, AppointmentStatus | undefined, AppointmentStatus>;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: CreatedAt;
}

export interface Database {
  dealerships: DealershipsTable;
  opening_hours: OpeningHoursTable;
  service_bays: ServiceBaysTable;
  skills: SkillsTable;
  technicians: TechniciansTable;
  technician_skills: TechnicianSkillsTable;
  service_types: ServiceTypesTable;
  customers: CustomersTable;
  vehicles: VehiclesTable;
  appointments: AppointmentsTable;
}

export type AppointmentRow = Selectable<AppointmentsTable>;
export type NewAppointment = Insertable<AppointmentsTable>;
