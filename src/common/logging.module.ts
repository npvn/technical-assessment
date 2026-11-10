import { Global, Module } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import pino, { type DestinationStream } from 'pino';
import { LOG_CONFIG, ConfigModule } from './config.module.js';
import type { LogConfig } from './config.js';
import { requestIdFor } from './request-id.js';

// Where the JSON log lines go. stdout in the app, a test swaps in its own
// stream to read them back (AC-36).
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

// pino-pretty is a dev dependency, so it's only loaded when LOG_PRETTY=true.
// The production image doesn't have it and never asks for it.
async function destinationFor(config: LogConfig): Promise<DestinationStream> {
  if (!config.pretty) return pino.destination(1);
  const { default: pretty } = await import('pino-pretty');
  return pretty({ colorize: true });
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [{ provide: LOG_DESTINATION, inject: [LOG_CONFIG], useFactory: destinationFor }],
  exports: [LOG_DESTINATION],
})
class LogDestinationModule {}

// Probes and scrapes come every few seconds and would bury the real traffic.
const QUIET_PATHS = ['/health/', '/metrics'];

// pino through nestjs-pino. Every line logged during a request carries its
// reqId, the request line comes from pino-http when the response finishes.
// Request and response bodies are never logged, and the headers that can
// carry secrets are redacted.
export const LoggingModule = LoggerModule.forRootAsync({
  imports: [LogDestinationModule, ConfigModule],
  inject: [LOG_CONFIG, LOG_DESTINATION],
  useFactory: (config: LogConfig, destination: DestinationStream) => ({
    pinoHttp: [
      {
        level: config.level,
        genReqId: requestIdFor,
        // reqId at the top of every line, not only inside req
        quietReqLogger: true,
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          censor: '[redacted]',
        },
        autoLogging: {
          ignore: (req: IncomingMessage) =>
            QUIET_PATHS.some((path) => (req.url ?? '').startsWith(path)),
        },
      },
      destination,
    ],
  }),
});
