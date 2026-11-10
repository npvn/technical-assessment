import { Global, Module } from '@nestjs/common';
import { loadConfig, loadLogConfig } from './config.js';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const LOG_CONFIG = Symbol('LOG_CONFIG');

// The config, read from the environment once when the app starts.
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig(process.env) },
    { provide: LOG_CONFIG, useFactory: () => loadLogConfig(process.env) },
  ],
  exports: [APP_CONFIG, LOG_CONFIG],
})
export class ConfigModule {}
