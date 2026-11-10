import { loadConfig, loadLogConfig } from '../../../src/common/config.js';

const URL = 'postgres://user:pass@localhost:5432/scheduler';

describe('loadConfig', () => {
  it('uses the defaults when only DATABASE_URL is set', () => {
    expect(loadConfig({ DATABASE_URL: URL })).toEqual({
      databaseUrl: URL,
      port: 3000,
      dbPoolSize: 10,
      dbConnectTimeoutMs: 2_000,
      booking: { lockTimeoutMs: 2_000, statementTimeoutMs: 5_000, loopBudgetMs: 5_000 },
    });
  });

  it('reads every value from the environment', () => {
    expect(
      loadConfig({
        DATABASE_URL: URL,
        PORT: '8080',
        DB_POOL_SIZE: '25',
        DB_CONNECT_TIMEOUT_MS: '750',
        BOOKING_LOCK_TIMEOUT_MS: '1500',
        BOOKING_STATEMENT_TIMEOUT_MS: '4000',
        BOOKING_LOOP_BUDGET_MS: '30000',
      }),
    ).toEqual({
      databaseUrl: URL,
      port: 8080,
      dbPoolSize: 25,
      dbConnectTimeoutMs: 750,
      booking: { lockTimeoutMs: 1_500, statementTimeoutMs: 4_000, loopBudgetMs: 30_000 },
    });
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it.each(['abc', '12ms', '1.5', ''])(
    'fails fast on a timeout that is not a whole number (%j)',
    (value) => {
      expect(() => loadConfig({ DATABASE_URL: URL, BOOKING_LOCK_TIMEOUT_MS: value })).toThrow(
        /BOOKING_LOCK_TIMEOUT_MS/,
      );
    },
  );

  it.each(['-1', '0'])('fails fast on a pool size below 1 (%s)', (value) => {
    expect(() => loadConfig({ DATABASE_URL: URL, DB_POOL_SIZE: value })).toThrow(/DB_POOL_SIZE/);
  });

  // How long a query waits for a free pool connection before it gives up.
  // Without it a full pool queues requests with no limit at all.
  it('waits at most 2 s for a database connection by default', () => {
    expect(loadConfig({ DATABASE_URL: URL }).dbConnectTimeoutMs).toBe(2_000);
  });

  it('reads DB_CONNECT_TIMEOUT_MS', () => {
    expect(loadConfig({ DATABASE_URL: URL, DB_CONNECT_TIMEOUT_MS: '750' }).dbConnectTimeoutMs).toBe(
      750,
    );
  });

  // 0 would mean "wait forever" to pg, the thing this setting is there to stop
  it.each(['0', '-1', 'abc', '1.5', ''])(
    'fails fast on a DB_CONNECT_TIMEOUT_MS that is not a whole number of 1 or more (%j)',
    (value) => {
      expect(() => loadConfig({ DATABASE_URL: URL, DB_CONNECT_TIMEOUT_MS: value })).toThrow(
        /DB_CONNECT_TIMEOUT_MS/,
      );
    },
  );
});

describe('loadLogConfig', () => {
  it('logs at info as JSON when nothing is set', () => {
    expect(loadLogConfig({})).toEqual({ level: 'info', pretty: false });
  });

  it('reads LOG_LEVEL and LOG_PRETTY', () => {
    expect(loadLogConfig({ LOG_LEVEL: 'debug', LOG_PRETTY: 'true' })).toEqual({
      level: 'debug',
      pretty: true,
    });
    expect(loadLogConfig({ LOG_LEVEL: 'warn', LOG_PRETTY: 'false' })).toEqual({
      level: 'warn',
      pretty: false,
    });
  });

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])(
    'takes the pino level %s',
    (level) => {
      expect(loadLogConfig({ LOG_LEVEL: level }).level).toBe(level);
    },
  );

  it.each(['verbose', 'INFO', ''])('fails fast on a log level pino does not know (%j)', (value) => {
    expect(() => loadLogConfig({ LOG_LEVEL: value })).toThrow(/LOG_LEVEL/);
  });

  it.each(['yes', '1', 'TRUE', ''])(
    'fails fast on LOG_PRETTY that is not true or false (%j)',
    (value) => {
      expect(() => loadLogConfig({ LOG_PRETTY: value })).toThrow(/LOG_PRETTY/);
    },
  );
});
