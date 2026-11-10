import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { CLOCK } from '../appointments/booking.tokens.js';
import { DATABASE } from '../common/database.module.js';
import type { Database } from '../db/types.js';
import { systemClock } from '../scheduling/index.js';
import { AvailabilityController } from './availability.controller.js';
import { AvailabilityReader } from './availability.reader.js';
import { AvailabilityService } from './availability.service.js';

// Its own clock provider under the same token as booking, so a test that
// overrides CLOCK moves both.
@Module({
  controllers: [AvailabilityController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: AvailabilityReader,
      inject: [DATABASE],
      useFactory: (db: Kysely<Database>) => new AvailabilityReader(db),
    },
    AvailabilityService,
  ],
})
export class AvailabilityModule {}
