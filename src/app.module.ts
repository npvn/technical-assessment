import { Module } from '@nestjs/common';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { ConfigModule } from './common/config.module.js';
import { DatabaseModule } from './common/database.module.js';

@Module({
  imports: [ConfigModule, DatabaseModule, AppointmentsModule],
})
export class AppModule {}
