import type { BookingConfig } from '../appointments/booking.config.js';

// Everything the app reads from the environment, read once at start.
export interface AppConfig {
  databaseUrl: string;
  port: number;
  dbPoolSize: number;
  // How long a query waits to get a pool connection before it fails. pg
  // waits forever by default, so a full pool would queue requests with no
  // limit, past the booking budget and every other one.
  dbConnectTimeoutMs: number;
  booking: BookingConfig;
}

type Env = Record<string, string | undefined>;

// Reads and checks the config. A bad value stops the app at start with a
// message naming the variable, instead of turning into odd behaviour under
// load later (a lock_timeout of NaN, say).
export function loadConfig(env: Env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. It needs a Postgres connection string.');
  }
  return {
    databaseUrl,
    port: positiveInt(env, 'PORT', 3000),
    dbPoolSize: positiveInt(env, 'DB_POOL_SIZE', 10),
    dbConnectTimeoutMs: positiveInt(env, 'DB_CONNECT_TIMEOUT_MS', 2_000),
    booking: {
      lockTimeoutMs: positiveInt(env, 'BOOKING_LOCK_TIMEOUT_MS', 2_000),
      statementTimeoutMs: positiveInt(env, 'BOOKING_STATEMENT_TIMEOUT_MS', 5_000),
      loopBudgetMs: positiveInt(env, 'BOOKING_LOOP_BUDGET_MS', 5_000),
    },
  };
}

// Unset means the default. Set means it has to be a whole number of 1 or
// more. A timeout of 0 would switch the Postgres timeout off, which is never
// what someone means here.
function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name} must be a whole number of 1 or more, got "${raw}"`);
  }
  return Number(raw);
}

export interface LogConfig {
  level: LogLevel;
  // pino-pretty instead of JSON lines. For a person reading a terminal, never
  // for production (pino-pretty is a dev dependency, the image doesn't have it).
  pretty: boolean;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// Kept apart from loadConfig, so the log settings can be read on their own
// without a DATABASE_URL. Same rule as the rest, a bad value stops the app
// at start.
export function loadLogConfig(env: Env): LogConfig {
  const level = env.LOG_LEVEL ?? 'info';
  if (!isLogLevel(level)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${level}"`);
  }
  const pretty = env.LOG_PRETTY ?? 'false';
  if (pretty !== 'true' && pretty !== 'false') {
    throw new Error(`LOG_PRETTY must be true or false, got "${pretty}"`);
  }
  return { level, pretty: pretty === 'true' };
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
