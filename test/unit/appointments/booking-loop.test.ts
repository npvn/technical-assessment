import type { BookingConfig } from '../../../src/appointments/booking.config.js';
import { BookingService } from '../../../src/appointments/booking.service.js';
import type { BookingRequest } from '../../../src/appointments/booking.types.js';
import {
  FakeBookingStore,
  RANGE,
  REQUEST,
  SteppingClock,
  freeRead,
  goodLookup,
  ids,
  pgError,
  storedFrom,
  type FakeScript,
} from './fake-booking-store.js';

// The booking loop from ADR 001 with a fake store, so the cap, the time
// budget and the database error budget can be forced without a database.
// The real Postgres races are in test/integration/appointments.

const CONFIG: BookingConfig = {
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
  loopBudgetMs: 5_000,
};

function setup(script: FakeScript, clock = new SteppingClock()) {
  const store = new FakeBookingStore(script);
  const service = new BookingService(store, clock, CONFIG);
  const book = (request: Partial<BookingRequest> = {}) => service.book({ ...REQUEST, ...request });
  return { store, service, clock, book };
}

const alwaysLoses = (): null => null;

describe('lost races', () => {
  it('a lost race reads again and books the next free pair', async () => {
    const { store, book } = setup({
      read: (n) =>
        n === 1
          ? freeRead({ bayIds: ['bay-1', 'bay-2'], technicianIds: ['tech-1', 'tech-2'] })
          : freeRead({ bayIds: ['bay-2'], technicianIds: ['tech-2'] }),
      insert: (n, booking) => (n === 1 ? null : storedFrom(booking, 'appointment-1')),
    });

    const result = await book();

    expect(result).toEqual({
      kind: 'created',
      appointment: expect.objectContaining({
        id: 'appointment-1',
        serviceBayId: 'bay-2',
        technicianId: 'tech-2',
      }),
    });
    // Each attempt is its own transaction, with its own read.
    expect(store.attempts).toBe(2);
    expect(store.reads).toHaveLength(2);
    expect(store.insertedPairs()).toEqual([
      ['bay-1', 'tech-1'],
      ['bay-2', 'tech-2'],
    ]);
    expect(store.reads[0]).toEqual({
      dealershipId: 'north',
      vehicleId: 'vehicle-1',
      skillCode: 'OIL_SERVICE',
      range: RANGE,
      preferredTechnicianId: null,
    });
    expect(store.inserts[0]).toEqual({
      dealershipId: 'north',
      serviceTypeId: 'oil',
      customerId: 'customer-1',
      vehicleId: 'vehicle-1',
      serviceBayId: 'bay-1',
      technicianId: 'tech-1',
      range: RANGE,
    });
  });

  it('a lost race followed by a read with no free bay is SLOT_UNAVAILABLE, not contended', async () => {
    const { store, book } = setup({
      read: (n) =>
        n === 1
          ? freeRead({ bayIds: ['bay-1'], technicianIds: ['tech-1', 'tech-2'] })
          : freeRead({ bayIds: [], technicianIds: ['tech-2'] }),
      insert: alwaysLoses,
    });

    expect(await book()).toEqual({ kind: 'rejected', code: 'SLOT_UNAVAILABLE' });
    expect(store.inserts).toHaveLength(1);
  });

  it('a lost race where the re-read finds the vehicle busy is VEHICLE_ALREADY_BOOKED', async () => {
    const { store, book } = setup({
      // The same car just got booked somewhere else. Pairs are still free
      // here, but the vehicle check comes first (ADR 001).
      read: (n) => (n === 1 ? freeRead() : freeRead({ vehicleBusy: true })),
      insert: alwaysLoses,
    });

    expect(await book()).toEqual({ kind: 'rejected', code: 'VEHICLE_ALREADY_BOOKED' });
    expect(store.inserts).toHaveLength(1);
  });

  it('a lost race on the preferred technician is TECHNICIAN_UNAVAILABLE, with no fallback to another technician (A19, A5)', async () => {
    const { store, book } = setup({
      read: (n) =>
        n === 1
          ? freeRead({ bayIds: ['bay-1', 'bay-2'], technicianIds: ['tech-1', 'tech-2'] })
          : freeRead({
              preferredTechnicianBusy: true,
              bayIds: ['bay-2'],
              technicianIds: ['tech-1'],
            }),
      insert: alwaysLoses,
    });
    store.lookupResult = goodLookup({
      preferredTechnician: { id: 'tech-2', dealershipId: 'north', skillCodes: ['OIL_SERVICE'] },
    });

    const result = await book({ preferredTechnicianId: 'tech-2' });

    expect(result).toEqual({ kind: 'rejected', code: 'TECHNICIAN_UNAVAILABLE' });
    expect(store.reads[0]?.preferredTechnicianId).toBe('tech-2');
    // The one insert used the preferred technician, not the first free one.
    expect(store.insertedPairs()).toEqual([['bay-1', 'tech-2']]);
  });
});

describe('AC-25 the hard cap and the time budget', () => {
  it('AC-25 when every insert loses, it gives up after B + T + 2 attempts with attempt_cap, never a 409', async () => {
    // B = 2 and T = 3 at the first read, so the cap is 7.
    const { store, book } = setup({
      read: () => freeRead({ bayIds: ids('bay', 2), technicianIds: ids('tech', 3) }),
      insert: alwaysLoses,
    });

    expect(await book()).toEqual({ kind: 'contended', reason: 'attempt_cap' });
    expect(store.inserts).toHaveLength(7);
    expect(store.attempts).toBe(7);
  });

  it('AC-25 the cap comes from the first read, even when later reads show longer lists', async () => {
    // B = 1 and T = 1 at the first read, so the cap is 4, whatever comes later.
    const { store, book } = setup({
      read: (n) =>
        n === 1
          ? freeRead({ bayIds: ids('bay', 1), technicianIds: ids('tech', 1) })
          : freeRead({ bayIds: ids('bay', 5), technicianIds: ids('tech', 5) }),
      insert: alwaysLoses,
    });

    expect(await book()).toEqual({ kind: 'contended', reason: 'attempt_cap' });
    expect(store.inserts).toHaveLength(4);
  });

  it('AC-25 with a preferred technician T is 1, so the cap is B + 1 + 2', async () => {
    // B = 2 and five free technicians, but only the preferred one can be
    // used, so the cap is 2 + 1 + 2 = 5, not 2 + 5 + 2.
    const { store, book } = setup({
      read: () => freeRead({ bayIds: ids('bay', 2), technicianIds: ids('tech', 5) }),
      insert: alwaysLoses,
    });
    store.lookupResult = goodLookup({
      preferredTechnician: { id: 'tech-1', dealershipId: 'north', skillCodes: ['OIL_SERVICE'] },
    });

    expect(await book({ preferredTechnicianId: 'tech-1' })).toEqual({
      kind: 'contended',
      reason: 'attempt_cap',
    });
    expect(store.inserts).toHaveLength(5);
  });

  it('AC-25 when the time budget runs out it answers time_budget, never a 409', async () => {
    // 50 bays and 50 technicians give a cap of 102, far away. Every lost
    // insert takes 2 s of the 5 s budget, so the budget has to stop it.
    const clock = new SteppingClock();
    const { store, book } = setup(
      {
        read: () => freeRead({ bayIds: ids('bay', 50), technicianIds: ids('tech', 50) }),
        insert: () => {
          clock.advance(2_000);
          return null;
        },
      },
      clock,
    );

    expect(await book()).toEqual({ kind: 'contended', reason: 'time_budget' });
    // Each insert takes 2 s. Attempts start at 0, 2 and 4 s, and at 6 s the
    // 5 s budget is gone, so exactly 3. A wrong budget (say the 2 s lock
    // timeout) would give a different count.
    expect(store.inserts).toHaveLength(3);
  });
});

describe('AC-41 database errors that say nothing about free slots', () => {
  it('AC-41 the insert throws 40P01 twice and then succeeds: created', async () => {
    const { store, book } = setup({
      read: () => freeRead(),
      insert: (n, booking) => {
        if (n <= 2) throw pgError('40P01');
        return storedFrom(booking, 'appointment-1');
      },
    });

    expect(await book()).toEqual({
      kind: 'created',
      appointment: expect.objectContaining({ id: 'appointment-1' }),
    });
    expect(store.inserts).toHaveLength(3);
  });

  it.each(['40P01', '40001', '55P03'])(
    'AC-41 %s four times in a row: db_retries_exhausted, never a 409',
    async (code) => {
      const { store, book } = setup({
        read: () => freeRead(),
        insert: () => {
          throw pgError(code);
        },
      });

      expect(await book()).toEqual({ kind: 'contended', reason: 'db_retries_exhausted' });
      // The budget is 3 retries, so the fourth error is the last insert.
      expect(store.inserts).toHaveLength(4);
    },
  );

  it('AC-41 the insert throws three times and then succeeds: created after exactly 4 inserts', async () => {
    const { store, book } = setup({
      read: () => freeRead(),
      insert: (n, booking) => {
        if (n <= 3) throw pgError('40P01');
        return storedFrom(booking, 'appointment-1');
      },
    });

    expect(await book()).toEqual({
      kind: 'created',
      appointment: expect.objectContaining({ id: 'appointment-1' }),
    });
    expect(store.inserts).toHaveLength(4);
  });

  it('AC-41 the database errors are counted per request in total, not only in a row', async () => {
    // Errors and lost races take turns, so there are never two errors in a
    // row. The cap (50 + 50 + 2) is far away. The fourth error still ends it.
    const { store, book } = setup({
      read: () => freeRead({ bayIds: ids('bay', 50), technicianIds: ids('tech', 50) }),
      insert: (n) => {
        if (n % 2 === 1) throw pgError('40001');
        return null;
      },
    });

    expect(await book()).toEqual({ kind: 'contended', reason: 'db_retries_exhausted' });
    expect(store.inserts).toHaveLength(7);
  });

  it('AC-41 database errors do not count towards the attempt cap', async () => {
    // B = 1 and T = 1, so the cap is 4 attempts that got an answer from the
    // insert. The 3 errors first don't use any of them, so the 4th real
    // attempt (the 7th insert) still runs and books.
    const { store, book } = setup({
      read: () => freeRead({ bayIds: ids('bay', 1), technicianIds: ids('tech', 1) }),
      insert: (n, booking) => {
        if (n <= 3) throw pgError('55P03');
        if (n <= 6) return null;
        return storedFrom(booking, 'appointment-1');
      },
    });

    expect(await book()).toEqual({
      kind: 'created',
      appointment: expect.objectContaining({ id: 'appointment-1' }),
    });
    expect(store.inserts).toHaveLength(7);
  });

  it('AC-41 57014 once: statement_timeout straight away, no retry', async () => {
    const { store, book } = setup({
      read: () => freeRead(),
      insert: (n, booking) => {
        if (n === 1) throw pgError('57014');
        return storedFrom(booking, 'appointment-1');
      },
    });

    expect(await book()).toEqual({ kind: 'contended', reason: 'statement_timeout' });
    expect(store.inserts).toHaveLength(1);
    expect(store.attempts).toBe(1);
  });

  it.each([
    ['a unique violation (23505)', pgError('23505')],
    ['a plain bug with no SQLSTATE', new TypeError('cannot read properties of undefined')],
  ])('any other error, like %s, is a bug and is thrown as is', async (_name, error) => {
    const { store, book } = setup({
      read: () => freeRead(),
      insert: () => {
        throw error;
      },
    });

    await expect(book()).rejects.toBe(error);
    expect(store.inserts).toHaveLength(1);
  });
});

describe('checks before the loop', () => {
  it('a 404 or 422 answer never starts an attempt', async () => {
    const { store, book } = setup({ read: () => freeRead(), insert: alwaysLoses });
    store.lookupResult = goodLookup({ offersService: false });

    expect(await book()).toEqual({ kind: 'rejected', code: 'SERVICE_NOT_OFFERED' });
    expect(store.attempts).toBe(0);
  });
});
