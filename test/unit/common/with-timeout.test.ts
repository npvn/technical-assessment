import { withTimeout } from '../../../src/common/health.module.js';

// The race behind /health/ready. pg has no connect timeout of its own on that
// probe, so a database host that drops packets would hang it. The e2e test
// for a missing database fails fast with an error and never gets here.

// A promise that never settles, like a query to a host that drops packets.
const never = () => new Promise<never>(() => {});

// Waits for the work, but gives up after a second, so a broken withTimeout
// shows up as a failed assertion instead of a test that hangs.
function settleWithin(work: Promise<unknown>, ms = 1_000): Promise<unknown> {
  return Promise.race([
    work.then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ rejected: error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);
}

describe('withTimeout', () => {
  it('rejects work that never settles once the time is up', async () => {
    const started = performance.now();

    const outcome = await settleWithin(withTimeout(never(), 50));

    expect(outcome).toEqual({ rejected: new Error('no answer in 50 ms') });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('passes the value through when the work is quicker', async () => {
    expect(await settleWithin(withTimeout(Promise.resolve('up'), 1_000))).toEqual({
      resolved: 'up',
    });
  });

  it('passes the error through when the work fails first', async () => {
    const refused = new Error('connection refused');

    expect(await settleWithin(withTimeout(Promise.reject(refused), 1_000))).toEqual({
      rejected: refused,
    });
  });

  it('clears its timer once the work has settled', async () => {
    vi.useFakeTimers();
    try {
      await withTimeout(Promise.resolve('up'), 1_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
