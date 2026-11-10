import {
  computeSlots,
  localDayRange,
  type BusyAppointment,
  type SlotInput,
} from '../../../src/availability/compute-slots.js';
import {
  DIAG_MINUTES,
  HARBOUR_HOURS,
  HORIZON_DAYS,
  LONDON,
  NORTH_HOURS,
  NOW,
  OIL_MINUTES,
  STEP_MINUTES,
  SYDNEY,
} from '../scheduling/fixtures.js';

// computeSlots on plain data, no database. The day query and the HTTP side
// are in test/e2e/availability.test.ts. Most cases are North from the SPEC
// with OIL (60 minutes), two bays and two OIL technicians unless a case says
// otherwise. The clock is the shared "now", Mon 1 March 2027 09:00 UTC.

const BAY_1 = 'bay-1';
const BAY_2 = 'bay-2';
const T1 = 'T1';
const T2 = 'T2';

function northDay(date: string, extra: Partial<SlotInput> = {}): SlotInput {
  return {
    date,
    timeZone: LONDON,
    openingHours: NORTH_HOURS,
    durationMinutes: OIL_MINUTES,
    now: NOW,
    stepMinutes: STEP_MINUTES,
    horizonDays: HORIZON_DAYS,
    bayIds: [BAY_1, BAY_2],
    technicianIds: [T1, T2],
    appointments: [],
    ...extra,
  };
}

function busy(bay: string, technician: string, startIso: string, endIso: string): BusyAppointment {
  return {
    serviceBayId: bay,
    technicianId: technician,
    start: new Date(startIso),
    end: new Date(endIso),
  };
}

// Every 15 minutes from first to last, both included, as UTC strings. Built
// on its own here so the test doesn't share any logic with the code. None of
// the ranges cross a clock change, so plain UTC steps are fine.
function every15(firstIso: string, lastIso: string): string[] {
  const out: string[] = [];
  for (let t = new Date(firstIso).getTime(); t <= new Date(lastIso).getTime(); t += 15 * 60_000) {
    out.push(new Date(t).toISOString().replace('.000Z', 'Z'));
  }
  return out;
}

function slots(input: SlotInput): string[] {
  return computeSlots(input).map((d) => d.toISOString().replace('.000Z', 'Z'));
}

describe('computeSlots', () => {
  it('AC-33 North, OIL, no bookings, Tue 9 March: 35 starts from 08:00Z to 16:30Z', () => {
    const result = slots(northDay('2027-03-09'));
    expect(result).toHaveLength(35);
    expect(result).toEqual(every15('2027-03-09T08:00:00Z', '2027-03-09T16:30:00Z'));
  });

  it('AC-33 bay 1 the only bay, booked 09:00 to 10:00 by T2: 28 starts, touching edges stay', () => {
    const result = slots(
      northDay('2027-03-09', {
        bayIds: [BAY_1],
        appointments: [busy(BAY_1, T2, '2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z')],
      }),
    );
    const gone = every15('2027-03-09T08:15:00Z', '2027-03-09T09:45:00Z');
    expect(gone).toHaveLength(7);
    expect(result).toHaveLength(28);
    expect(result).toEqual(
      every15('2027-03-09T08:00:00Z', '2027-03-09T16:30:00Z').filter((s) => !gone.includes(s)),
    );
    // 08:00 ends at 09:00 and 10:00 starts when the booking ends, both touching
    expect(result).toContain('2027-03-09T08:00:00Z');
    expect(result).toContain('2027-03-09T10:00:00Z');
  });

  it('AC-33 Mon 29 March (BST): 35 starts from 07:00Z to 15:30Z', () => {
    const result = slots(northDay('2027-03-29'));
    expect(result).toHaveLength(35);
    expect(result).toEqual(every15('2027-03-29T07:00:00Z', '2027-03-29T15:30:00Z'));
  });

  it('AC-33 Sat 13 March (09:00 to 13:00): 13 starts from 09:00Z to 12:00Z', () => {
    const result = slots(northDay('2027-03-13'));
    expect(result).toHaveLength(13);
    expect(result).toEqual(every15('2027-03-13T09:00:00Z', '2027-03-13T12:00:00Z'));
  });

  it('AC-33 today (Mon 1 March, now 09:00Z): 30 starts from 09:15Z, 09:00 is now so it is out', () => {
    const result = slots(northDay('2027-03-01'));
    expect(result).toHaveLength(30);
    expect(result).toEqual(every15('2027-03-01T09:15:00Z', '2027-03-01T16:30:00Z'));
  });

  it.each([
    ['2027-03-14', 'Sunday, closed'],
    ['2027-02-28', 'in the past, also a Sunday'],
    ['2027-06-01', 'past the 90 day window'],
  ])('AC-33 %s (%s) has no starts', (date) => {
    expect(slots(northDay(date))).toEqual([]);
  });

  // 2027-02-28 is a Sunday, so it would be empty on the closed rule alone.
  // Sat 27 February is open, so only the past rule can empty it.
  it('AC-33 a past day the dealership is open (Sat 27 February) has no starts', () => {
    expect(slots(northDay('2027-02-27'))).toEqual([]);
  });

  // Same clock as AC-16's horizon case. The limit is exactly 90 x 24 hours,
  // 2027-05-31T09:00:00Z (10:00 BST), so the day is cut partway through.
  // 31 May 2027 is a UK bank holiday. Closure days are out of scope, so North
  // is open as on any Monday. Don't "fix" this.
  it('AC-33 the 90 day limit cuts a day partway: 07:00Z to 09:00Z only', () => {
    const result = slots(northDay('2027-05-31', { now: new Date('2027-03-02T09:00:00Z') }));
    expect(result).toEqual(every15('2027-05-31T07:00:00Z', '2027-05-31T09:00:00Z'));
  });

  describe('a long job (DIAG, 180 minutes)', () => {
    it('AC-33 Tue 9 March: 27 starts, the last at 14:30Z so it ends at closing', () => {
      const result = slots(northDay('2027-03-09', { durationMinutes: DIAG_MINUTES }));
      expect(result).toHaveLength(27);
      expect(result).toEqual(every15('2027-03-09T08:00:00Z', '2027-03-09T14:30:00Z'));
    });

    it('AC-33 Sat 13 March: 5 starts, 09:00Z to 10:00Z', () => {
      const result = slots(northDay('2027-03-13', { durationMinutes: DIAG_MINUTES }));
      expect(result).toEqual(every15('2027-03-13T09:00:00Z', '2027-03-13T10:00:00Z'));
    });

    it('AC-33 a booking in the middle blocks every start whose 3 hours would touch it', () => {
      const result = slots(
        northDay('2027-03-09', {
          durationMinutes: DIAG_MINUTES,
          bayIds: [BAY_1],
          appointments: [busy(BAY_1, T2, '2027-03-09T12:00:00Z', '2027-03-09T13:00:00Z')],
        }),
      );
      // 09:00 ends at 12:00 (touching) and 13:00 starts at its end
      expect(result).toEqual([
        ...every15('2027-03-09T08:00:00Z', '2027-03-09T09:00:00Z'),
        ...every15('2027-03-09T13:00:00Z', '2027-03-09T14:30:00Z'),
      ]);
    });
  });

  describe('the technician side', () => {
    // Every AC-33 row is about a bay. These make sure technicians count too.
    it('AC-33 two free bays, the only qualified technician booked 09:00 to 10:00: 28 starts', () => {
      const result = slots(
        northDay('2027-03-09', {
          technicianIds: [T1],
          appointments: [busy(BAY_2, T1, '2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z')],
        }),
      );
      const gone = every15('2027-03-09T08:15:00Z', '2027-03-09T09:45:00Z');
      expect(result).toEqual(
        every15('2027-03-09T08:00:00Z', '2027-03-09T16:30:00Z').filter((s) => !gone.includes(s)),
      );
    });

    it('AC-33 one of two bays and one of two technicians booked: still 35 starts', () => {
      const result = slots(
        northDay('2027-03-09', {
          appointments: [busy(BAY_1, T1, '2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z')],
        }),
      );
      expect(result).toEqual(every15('2027-03-09T08:00:00Z', '2027-03-09T16:30:00Z'));
    });

    // The appointment's technician isn't in the qualified list (say a BRAKES
    // only technician on bay 2). It holds bay 2, so bay 1 and T1 stay free.
    it('AC-33 a booking by a technician without the skill only holds its bay', () => {
      const result = slots(
        northDay('2027-03-09', {
          technicianIds: [T1],
          appointments: [busy(BAY_2, 'T-brakes', '2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z')],
        }),
      );
      expect(result).toEqual(every15('2027-03-09T08:00:00Z', '2027-03-09T16:30:00Z'));
    });
  });

  it.each([
    ['no bays', { bayIds: [] }],
    ['no technician with the skill', { technicianIds: [] }],
  ])('AC-33 a dealership with %s has no starts', (_name, extra: Partial<SlotInput>) => {
    expect(slots(northDay('2027-03-09', extra))).toEqual([]);
  });

  // The date is the dealership's local date, not a UTC date. Harbour's
  // Monday 8 March opens at 08:00 Sydney time (+11:00), which is Sunday 21:00
  // UTC, and closes at 17:00 local (06:00Z), so the last OIL start is 05:00Z.
  it('AC-33 Harbour (Sydney) Mon 8 March: 33 starts from 2027-03-07T21:00Z to 2027-03-08T05:00Z', () => {
    const result = slots(northDay('2027-03-08', { timeZone: SYDNEY, openingHours: HARBOUR_HOURS }));
    expect(result).toHaveLength(33);
    expect(result).toEqual(every15('2027-03-07T21:00:00Z', '2027-03-08T05:00:00Z'));
  });
});

// The day query's window. In Cairo the clocks jump from 00:00 to 01:00 on
// Fri 24 April 2026, so that local day starts at 01:00 and is 23 hours long.
// It still ends at the next midnight, not at 01:00 the next day, or a few
// starts would be listed under both dates.
describe('localDayRange', () => {
  it('a day that skips midnight (Cairo, 24 April 2026) runs from 01:00 to the next midnight', () => {
    expect(localDayRange('2026-04-24', 'Africa/Cairo')).toEqual({
      start: new Date('2026-04-23T22:00:00Z'),
      end: new Date('2026-04-24T21:00:00Z'),
    });
  });

  it('the day after starts exactly where that one ends', () => {
    const skipped = localDayRange('2026-04-24', 'Africa/Cairo');
    const next = localDayRange('2026-04-25', 'Africa/Cairo');
    expect(next.start).toEqual(skipped.end);
  });

  // What a client would see: Cairo skips midnight again on Fri 30 April
  // 2027, inside the 90 day window. Open around the clock on Friday and
  // Saturday, the first hour of Saturday must only be listed on Saturday.
  it('no start is listed under two dates (Cairo, Fri 30 April 2027)', () => {
    const allDay = [5, 6].map((isoWeekday) => ({
      isoWeekday,
      opensAt: '00:00:00',
      closesAt: '23:45:00',
    }));
    const day = (date: string) =>
      slots(northDay(date, { timeZone: 'Africa/Cairo', openingHours: allDay }));

    const friday = day('2027-04-30');
    const saturday = day('2027-05-01');

    expect(friday.filter((start) => saturday.includes(start))).toEqual([]);
    expect(friday.at(-1)).toBe('2027-04-30T19:45:00Z');
    expect(saturday[0]).toBe('2027-04-30T21:00:00Z');
  });

  it('a normal day is 24 hours from local midnight', () => {
    expect(localDayRange('2027-03-09', 'Europe/London')).toEqual({
      start: new Date('2027-03-09T00:00:00Z'),
      end: new Date('2027-03-10T00:00:00Z'),
    });
  });
});
