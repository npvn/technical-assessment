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

// What the request line says about the request and the response. A short
// list of fields to keep, not a list of headers to hide. Headers, the query
// string and the client address are all free text from outside (an
// Idempotency-Key or a User-Agent can hold anything), so none of it is
// logged. Bodies are never logged either.
interface SerializedRequest {
  id: unknown;
  method: string;
  url: string;
}

function requestFields(req: SerializedRequest) {
  return { id: req.id, method: req.method, path: req.url.split('?')[0] };
}

function responseFields(res: { statusCode: number }) {
  return { statusCode: res.statusCode };
}

// pino through nestjs-pino. Every line logged during a request carries its
// reqId, the request line comes from pino-http when the response finishes.
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
        serializers: { req: requestFields, res: responseFields },
        autoLogging: {
          ignore: (req: IncomingMessage) =>
            QUIET_PATHS.some((path) => (req.url ?? '').startsWith(path)),
        },
      },
      destination,
    ],
  }),
});
