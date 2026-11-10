import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { OpeningWindow, TimeRange } from '../scheduling/index.js';
import type { BusyAppointment } from './compute-slots.js';

// The reads behind GET /availability. Plain class, the module builds it with
// a factory like the appointments reader.
export class AvailabilityReader {
  constructor(private readonly db: Kysely<Database>) {}

  // The dealership with its zone and opening hours, or null for a 404.
  async findDealership(id: string) {
    const row = await this.db
      .selectFrom('dealerships')
      .select(['id', 'time_zone'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    const hours = await this.db
      .selectFrom('opening_hours')
      .select(['iso_weekday', 'opens_at', 'closes_at'])
      .where('dealership_id', '=', row.id)
      .execute();
    return {
      id: row.id,
      timeZone: row.time_zone,
      openingHours: hours.map((h): OpeningWindow => ({
        isoWeekday: h.iso_weekday,
        opensAt: h.opens_at,
        closesAt: h.closes_at,
      })),
    };
  }

  async findServiceType(id: string) {
    const row = await this.db
      .selectFrom('service_types')
      .select(['id', 'duration_minutes', 'required_skill_code'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row
      ? { id: row.id, durationMinutes: row.duration_minutes, skillCode: row.required_skill_code }
      : null;
  }

  // The three small queries from DESIGN.md section 5. Everything else is
  // worked out in code, so this is three round trips whatever the number of
  // slots, not one query per slot.
  async loadDay(dealershipId: string, skillCode: string, day: TimeRange) {
    const bays = await this.db
      .selectFrom('service_bays')
      .select('id')
      .where('dealership_id', '=', dealershipId)
      .execute();

    const technicians = await this.db
      .selectFrom('technicians')
      .innerJoin('technician_skills', 'technician_skills.technician_id', 'technicians.id')
      .select('technicians.id')
      .where('technicians.dealership_id', '=', dealershipId)
      .where('technician_skills.skill_code', '=', skillCode)
      .execute();

    // Every active appointment at the dealership that overlaps the local
    // day, half open like everywhere else. Same status filter as the
    // exclusion constraints (cancelled holds nothing). The starts_at bound
    // lets Postgres use the (dealership_id, starts_at) index.
    const appointments = await this.db
      .selectFrom('appointments')
      .select(['service_bay_id', 'technician_id', 'starts_at', 'ends_at'])
      .where('dealership_id', '=', dealershipId)
      .where('status', '<>', 'cancelled')
      .where('starts_at', '<', day.end)
      .where('ends_at', '>', day.start)
      .execute();

    return {
      bayIds: bays.map((b) => b.id),
      technicianIds: technicians.map((t) => t.id),
      appointments: appointments.map((a): BusyAppointment => ({
        serviceBayId: a.service_bay_id,
        technicianId: a.technician_id,
        start: a.starts_at,
        end: a.ends_at,
      })),
    };
  }
}
