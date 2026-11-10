import fc from 'fast-check';
import { findFreeResources } from '../../../src/availability/free-resources.js';
import {
  insertBay,
  insertCustomerWithVehicle,
  insertDealership,
  insertServiceType,
  insertTechnician,
} from '../../support/fixtures.js';
import { createTestDatabase, type TestDatabase } from '../../support/test-database.js';
import { inRolledBackTransaction, tryInsertAppointment } from './helpers.js';

// AC-22: the availability read and the exclusion constraints agree on what
// "free" means. If the read were stricter, the booking loop would say "no
// slot" while a pair is free. If it were looser, the loop would keep offering
// a bay the constraint keeps refusing (ADR 001 decision 2).
//
// Each run builds a small, busy dealership inside a transaction that is
// rolled back at the end, so runs never see each other's rows. The world is
// kept small (up to 3 bays, 4 technicians, one day) so overlaps and touching
// edges come up often.

// Tue 9 March 2027, North's hours 08:00 to 17:30, which is 38 quarter hours.
// London is on UTC that day.
const OPENS_AT = Date.UTC(2027, 2, 9, 8, 0);
const QUARTERS_IN_DAY = 38;
const quarter = (n: number): Date => new Date(OPENS_AT + n * 15 * 60_000);

const SKILL = 'OIL_SERVICE';
const MAX_EXISTING = 10;

// A range on the 15 minute grid inside opening hours, up to 3 hours long.
const slotArb = fc
  .record({
    start: fc.integer({ min: 0, max: QUARTERS_IN_DAY - 1 }),
    length: fc.integer({ min: 1, max: 12 }),
  })
  .map(({ start, length }) => ({ start, end: Math.min(start + length, QUARTERS_IN_DAY) }));

const worldArb = fc.record({
  bayCount: fc.integer({ min: 1, max: 3 }),
  // Each technician's skills. Some won't have OIL_SERVICE, and the counts
  // differ, so the ordering and the skill filter both get exercised. The
  // first one always has OIL_SERVICE, otherwise a run could end up with no
  // qualified technician and no pairs to probe at all.
  technicianSkills: fc
    .array(fc.subarray([SKILL, 'BRAKES', 'DIAG']), { minLength: 1, maxLength: 4 })
    .map(([first, ...rest]) => [first!.includes(SKILL) ? first! : [SKILL, ...first!], ...rest]),
  existing: fc.array(
    fc.record({
      bay: fc.nat(),
      tech: fc.nat(),
      slot: slotArb,
      // About one in four is cancelled, so a read that forgets the status
      // filter gets caught.
      cancelled: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
    }),
    { maxLength: MAX_EXISTING },
  ),
  query: slotArb,
});

let tdb: TestDatabase;
let serviceTypeId: string;
// One car per existing row, and one more for the probes. A car that is
// already booked would be refused by the vehicle constraint, which is not what
// this test is about.
let cars: { customerId: string; vehicleId: string }[];
let probeCar: { customerId: string; vehicleId: string };

beforeAll(async () => {
  tdb = await createTestDatabase();
  serviceTypeId = await insertServiceType(tdb.db, { requiredSkill: SKILL });
  cars = [];
  for (let i = 0; i < MAX_EXISTING; i++) {
    cars.push(await insertCustomerWithVehicle(tdb.db));
  }
  probeCar = await insertCustomerWithVehicle(tdb.db);
});

afterAll(async () => {
  await tdb?.destroy();
});

describe('AC-22 the availability read agrees with the exclusion constraints', () => {
  it('AC-22 every returned (bay, technician) pair can be inserted, every other qualified pair is refused with 23P01', async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async (world) => {
        await inRolledBackTransaction(tdb.db, async (trx) => {
          const dealershipId = await insertDealership(trx);
          const bays: string[] = [];
          for (let i = 0; i < world.bayCount; i++) {
            bays.push(await insertBay(trx, { dealershipId }));
          }
          const techs: string[] = [];
          for (const skills of world.technicianSkills) {
            techs.push(await insertTechnician(trx, { dealershipId, skills }));
          }
          const qualified = techs.filter((_, i) => world.technicianSkills[i]!.includes(SKILL));

          // Existing rows can use any technician, qualified or not (like a
          // raw row in AC-04). The ones the database refuses are skipped.
          for (const [i, row] of world.existing.entries()) {
            const car = cars[i]!;
            const outcome = await tryInsertAppointment(
              trx,
              {
                dealershipId,
                serviceTypeId,
                customerId: car.customerId,
                vehicleId: car.vehicleId,
                serviceBayId: bays[row.bay % bays.length]!,
                technicianId: techs[row.tech % techs.length]!,
                startsAt: quarter(row.slot.start),
                endsAt: quarter(row.slot.end),
                status: row.cancelled ? 'cancelled' : 'confirmed',
              },
              { keep: true },
            );
            // Only an overlap may refuse an existing row. Anything else means
            // the setup is broken and the run would prove nothing.
            if (!outcome.ok && outcome.code !== '23P01') {
              throw new Error(`existing row refused with ${outcome.code} (${outcome.constraint})`);
            }
          }

          const range = { start: quarter(world.query.start), end: quarter(world.query.end) };
          const free = await findFreeResources(trx, { dealershipId, skillCode: SKILL, range });

          // Nothing outside this dealership's bays and qualified technicians.
          expect(bays).toEqual(expect.arrayContaining(free.bayIds));
          expect(qualified).toEqual(expect.arrayContaining(free.technicianIds));

          // Probe every bay with every qualified technician. Each probe is
          // rolled back, so inserting one pair can't block the next.
          for (const bay of bays) {
            for (const tech of qualified) {
              const outcome = await tryInsertAppointment(
                trx,
                {
                  dealershipId,
                  serviceTypeId,
                  customerId: probeCar.customerId,
                  vehicleId: probeCar.vehicleId,
                  serviceBayId: bay,
                  technicianId: tech,
                  startsAt: range.start,
                  endsAt: range.end,
                },
                { keep: false },
              );
              const returned = free.bayIds.includes(bay) && free.technicianIds.includes(tech);
              if (returned) {
                expect(outcome, `returned pair (${bay}, ${tech}) should insert`).toEqual({
                  ok: true,
                });
              } else {
                expect(
                  outcome,
                  `pair (${bay}, ${tech}) was not returned, so it should be refused`,
                ).toMatchObject({
                  ok: false,
                  code: '23P01',
                  constraint: expect.stringMatching(/^appointments_no_(bay|technician)_overlap$/),
                });
              }
            }
          }
        });
      }),
      { numRuns: 30 },
    );
  });
});
