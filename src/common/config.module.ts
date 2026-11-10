import { Global, Module } from '@nestjs/common';
import { loadConfig } from './config.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

// The config, read from the environment once when the app starts.
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
