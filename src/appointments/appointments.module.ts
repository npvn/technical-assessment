import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { APP_CONFIG } from '../common/config.module.js';
import type { AppConfig } from '../common/config.js';
import { DATABASE } from '../common/database.module.js';
import type { Database } from '../db/types.js';
import { systemClock } from '../scheduling/index.js';
import { AppointmentReader } from './appointment.reader.js';
import { AppointmentsController } from './appointments.controller.js';
import type { BookingConfig } from './booking.config.js';
import { BookingService } from './booking.service.js';
import { PostgresBookingStore } from './booking.store.js';
import { BOOKING_CONFIG, BOOKING_STORE, CLOCK } from './booking.tokens.js';

// The store and the reader are plain classes (the loop tests build them by
// hand), so Nest gets them through factories.
@Module({
  controllers: [AppointmentsController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: BOOKING_CONFIG,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): BookingConfig => config.booking,
    },
    {
      provide: BOOKING_STORE,
      inject: [DATABASE, BOOKING_CONFIG],
      useFactory: (db: Kysely<Database>, config: BookingConfig) =>
        new PostgresBookingStore(db, config),
    },
    {
      provide: AppointmentReader,
      inject: [DATABASE],
      useFactory: (db: Kysely<Database>) => new AppointmentReader(db),
    },
    BookingService,
  ],
})
export class AppointmentsModule {}
