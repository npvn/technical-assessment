import { loadConfig } from '../../../src/common/config.js';

const URL = 'postgres://user:pass@localhost:5432/scheduler';

describe('loadConfig', () => {
  it('uses the defaults when only DATABASE_URL is set', () => {
    expect(loadConfig({ DATABASE_URL: URL })).toEqual({
      databaseUrl: URL,
      port: 3000,
      dbPoolSize: 10,
      booking: { lockTimeoutMs: 2_000, statementTimeoutMs: 5_000, loopBudgetMs: 5_000 },
    });
  });

  it('reads every value from the environment', () => {
    expect(
      loadConfig({
        DATABASE_URL: URL,
        PORT: '8080',
        DB_POOL_SIZE: '25',
        BOOKING_LOCK_TIMEOUT_MS: '1500',
        BOOKING_STATEMENT_TIMEOUT_MS: '4000',
        BOOKING_LOOP_BUDGET_MS: '30000',
      }),
    ).toEqual({
      databaseUrl: URL,
      port: 8080,
      dbPoolSize: 25,
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
});
