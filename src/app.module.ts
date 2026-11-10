import { Module } from '@nestjs/common';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { AvailabilityModule } from './availability/availability.module.js';
import { ConfigModule } from './common/config.module.js';
import { DatabaseModule } from './common/database.module.js';
import { HealthModule } from './common/health.module.js';
import { LoggingModule } from './common/logging.module.js';
import { MetricsModule } from './common/metrics.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    MetricsModule,
    HealthModule,
    AppointmentsModule,
    AvailabilityModule,
  ],
})
export class AppModule {}
