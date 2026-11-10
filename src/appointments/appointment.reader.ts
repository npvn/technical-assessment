import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { AppointmentView } from './http-mapping.js';

// Reads one appointment by id, with its dealership's time zone for the local
// times, for GET /appointments/:id. POST builds its body from the booking
// itself, and both go through toAppointmentResponse, so the two bodies come
// from the same code and can't drift apart.
export class AppointmentReader {
  constructor(private readonly db: Kysely<Database>) {}

  async findById(id: string): Promise<AppointmentView | null> {
    const row = await this.db
      .selectFrom('appointments')
      .innerJoin('dealerships', 'dealerships.id', 'appointments.dealership_id')
      .selectAll('appointments')
      .select('dealerships.time_zone')
      .where('appointments.id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      dealershipId: row.dealership_id,
      serviceTypeId: row.service_type_id,
      customerId: row.customer_id,
      vehicleId: row.vehicle_id,
      serviceBayId: row.service_bay_id,
      technicianId: row.technician_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      createdAt: row.created_at,
      timeZone: row.time_zone,
    };
  }
}
