import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isDatabaseUnavailable } from '../common/database-unavailable.js';
import {
  HORIZON_DAYS,
  STEP_MINUTES,
  checkBookingTime,
  type Clock,
  type TimeRange,
} from '../scheduling/index.js';
import type { BookingConfig } from './booking.config.js';
import {
  noopBookingObserver,
  type BookingObserver,
  type BookingOutcome,
} from './booking.observer.js';
import type {
  BookingAttempt,
  BookingLookup,
  BookingStore,
  KeyedAppointment,
} from './booking.store.js';
import { BOOKING_CONFIG, BOOKING_OBSERVER, BOOKING_STORE, CLOCK } from './booking.tokens.js';
import type {
  BookingErrorCode,
  BookingRequest,
  BookingResult,
  ContendedReason,
} from './booking.types.js';
import { requestHash } from './idempotency.js';

// Database errors that say nothing about free slots (ADR 001 decision 6).
// Deadlock, serialization failure and lock timeout get retried, up to
// TRANSIENT_RETRIES times per request in total. The next one after that is a
// 503. With ON CONFLICT DO NOTHING at READ COMMITTED none of them showed up in
// the experiments, so this is a backstop and not the normal path.
const TRANSIENT_CODES = new Set(['40P01', '40001', '55P03']);
const TRANSIENT_RETRIES = 3;
// A statement timeout means the database is overloaded. Retrying would only
// add to the load, so it goes straight to a 503.
const STATEMENT_TIMEOUT = '57014';

// Everything one attempt needs, worked out once before the loop.
interface LoopInput {
  request: BookingRequest;
  serviceTypeId: string;
  skillCode: string;
  range: TimeRange;
  preferredTechnicianId: string | null;
  // Only set when the request has an Idempotency-Key.
  idempotency?: Idempotency;
}

interface Idempotency {
  customerId: string;
  key: string;
  requestHash: string;
}

// Shared between attempts. The cap is taken from the very first read, even
// if that attempt then fails with a database error.
interface LoopState {
  cap: number | null;
}

// What the loop did, for the observer. attempts counts every transaction the
// loop started, including the ones a database error broke. lostRaces counts
// the inserts that came back with zero rows.
interface LoopCounts {
  attempts: number;
  lostRaces: number;
}

// An attempt either answers the request, or lost a race and the loop has to
// go round again.
type AttemptOutcome = { kind: 'answer'; result: BookingResult } | { kind: 'lost' };

const rejected = (code: BookingErrorCode): BookingResult => ({ kind: 'rejected', code });
const contended = (reason: ContendedReason): BookingResult => ({ kind: 'contended', reason });

// What bookWithTimeZone answers: the result, and the dealership's time zone
// from the lookup (null when the dealership wasn't found). The controller
// builds the 201 body from these, so it doesn't have to read the new row back
// after the commit.
export interface BookingAnswer {
  result: BookingResult;
  timeZone: string | null;
}

// Books one appointment: the lookups, the 404s and 422s, then the loop from
// ADR 001. Nest injects the dependencies in the app, a unit test just calls
// the constructor with a fake store and a test clock.
@Injectable()
export class BookingService {
  constructor(
    @Inject(BOOKING_STORE) private readonly store: BookingStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BOOKING_CONFIG) private readonly config: BookingConfig,
    // Gets one record per request for the metrics and the booking log line.
    // Optional, so the loop tests can build the service with three arguments.
    @Optional()
    @Inject(BOOKING_OBSERVER)
    private readonly observer: BookingObserver = noopBookingObserver,
  ) {}

  private readonly logger = new Logger(BookingService.name);

  async book(request: BookingRequest): Promise<BookingResult> {
    return (await this.bookWithTimeZone(request)).result;
  }

  // Answers the request, then tells the observer how it went. A throw is
  // recorded and thrown on unchanged, so it still shows up in the booking
  // metrics. The database not being there is SERVICE_UNAVAILABLE (the filter
  // makes it a 503), anything else is INTERNAL_ERROR (a 500).
  async bookWithTimeZone(request: BookingRequest): Promise<BookingAnswer> {
    const startedAt = this.clock.now().getTime();
    const counts: LoopCounts = { attempts: 0, lostRaces: 0 };
    const seen: { timeZone: string | null } = { timeZone: null };
    let result: BookingResult;
    try {
      result = await this.decide(request, counts, seen);
    } catch (error) {
      const outcome = isDatabaseUnavailable(error) ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR';
      this.observe(request, { outcome }, counts, startedAt);
      throw error;
    }
    this.observe(request, outcomeOf(result), counts, startedAt);
    return { result, timeZone: seen.timeZone };
  }

  private async decide(
    request: BookingRequest,
    counts: LoopCounts,
    seen: { timeZone: string | null },
  ): Promise<BookingResult> {
    const idempotency: Idempotency | undefined = request.idempotencyKey
      ? {
          customerId: request.customerId,
          key: request.idempotencyKey,
          requestHash: requestHash(request),
        }
      : undefined;

    // The store looks the key up together with everything else, but the key
    // is checked first, before every 404 and 422. So a replay still works
    // after its start time has passed, or after the preferred technician
    // stopped being eligible (ADR 001 decision 3, AC-42).
    const lookup = await this.store.lookup(request);
    seen.timeZone = lookup.dealership?.timeZone ?? null;
    if (idempotency && lookup.keyed) return answerForKey(lookup.keyed, idempotency);

    const checked = checkLookup(request, lookup);
    if (!checked.ok) return rejected(checked.code);
    const { dealership, serviceType } = checked;

    // The time rules come last among the 422s (SPEC "Order of checks"), in
    // the dealership's own zone and opening hours.
    const time = checkBookingTime({
      start: request.startTime,
      durationMinutes: serviceType.durationMinutes,
      timeZone: dealership.timeZone,
      openingHours: dealership.openingHours,
      now: this.clock.now(),
      stepMinutes: STEP_MINUTES,
      horizonDays: HORIZON_DAYS,
    });
    if (!time.ok) return rejected(time.code);

    return this.loop(counts, {
      request,
      serviceTypeId: serviceType.id,
      skillCode: serviceType.requiredSkillCode,
      range: time.range,
      preferredTechnicianId: request.preferredTechnicianId ?? null,
      ...(idempotency ? { idempotency } : {}),
    });
  }

  // The loop from ADR 001 decisions 4 to 6. Each attempt is its own short
  // transaction: read, then either answer or insert. Three separate limits
  // keep it from running forever, and hitting any of them is a 503, never a
  // 409, because only a fresh read is allowed to say "no slot":
  // - the hard cap on attempts that lost a race (B + T + 2 from the first read)
  // - the database error budget (TRANSIENT_RETRIES)
  // - the time budget, which covers both of the above
  private async loop(counts: LoopCounts, input: LoopInput): Promise<BookingResult> {
    const startedAt = this.clock.now().getTime();
    const state: LoopState = { cap: null };
    let transientErrors = 0;

    for (;;) {
      // Checked before every attempt, so a slow run stops instead of starting
      // another round it has no time for.
      if (this.clock.now().getTime() - startedAt >= this.config.loopBudgetMs) {
        return contended('time_budget');
      }
      // Only lost races count here. A database error didn't show us anything
      // about the slot, so it doesn't use up the cap (it has its own budget).
      if (state.cap !== null && counts.lostRaces >= state.cap) {
        return contended('attempt_cap');
      }

      let outcome: AttemptOutcome;
      counts.attempts++;
      try {
        outcome = await this.store.runAttempt((attempt) => this.attempt(attempt, input, state));
      } catch (error) {
        const code = sqlState(error);
        if (code === STATEMENT_TIMEOUT) return contended('statement_timeout');
        if (code !== undefined && TRANSIENT_CODES.has(code)) {
          transientErrors++;
          if (transientErrors > TRANSIENT_RETRIES) return contended('db_retries_exhausted');
          continue;
        }
        // Anything else is a bug or a real outage, not a booking answer.
        throw error;
      }

      if (outcome.kind === 'answer') return outcome.result;
      counts.lostRaces++;
    }
  }

  // One attempt, inside its transaction. The read answers in a fixed order
  // (ADR 001 decision 4), and the order matters:
  // 1. is the idempotency key already booked? A twin request with the same
  //    key may have committed since the check at the start. This has to
  //    come first, or a replay would see "its own" vehicle as busy and get
  //    a 409.
  // 2. is the vehicle booked at an overlapping time anywhere?
  // 3. is the preferred technician busy? No fallback to someone else, the customer asked for that person (A5).
  // 4. is there no free bay, or no free qualified technician?
  // Otherwise insert the first free pair. Zero rows back means somebody got
  // in first, and the next attempt's read works out what changed.
  private async attempt(
    attempt: BookingAttempt,
    input: LoopInput,
    state: LoopState,
  ): Promise<AttemptOutcome> {
    // The key is looked up inside readSlot, after the vehicle check and not
    // before it. At READ COMMITTED every statement has its own snapshot, so
    // a key check run first could miss a twin that commits right after it,
    // and then the vehicle check would see the twin's booking and give the
    // 409 this order is there to prevent (see readSlot in booking.store.ts).
    const { request, range, preferredTechnicianId, idempotency } = input;
    const read = await attempt.readSlot({
      dealershipId: request.dealershipId,
      vehicleId: request.vehicleId,
      skillCode: input.skillCode,
      range,
      preferredTechnicianId,
      ...(idempotency
        ? { idempotency: { customerId: idempotency.customerId, key: idempotency.key } }
        : {}),
    });

    if (idempotency && read.keyed) return answer(answerForKey(read.keyed, idempotency));

    // Every lost race proves a competitor committed a booking on that bay or
    // technician, so the next read won't offer it again. A request can lose
    // at most B + T - 1 races before it books or gets an honest 409, and the
    // cap leaves a little room on top of that. With a preferred technician
    // only that one person can be used, so T is 1.
    if (state.cap === null) {
      const technicians = preferredTechnicianId ? 1 : read.technicianIds.length;
      state.cap = read.bayIds.length + technicians + 2;
    }

    if (read.vehicleBusy) return answer(rejected('VEHICLE_ALREADY_BOOKED'));
    if (preferredTechnicianId && read.preferredTechnicianBusy) {
      return answer(rejected('TECHNICIAN_UNAVAILABLE'));
    }

    // The lists are already in pick order: lowest bay id, and the technician
    // with the fewest skills, then the lowest id, so generalists stay free (A16).
    const bay = read.bayIds[0];
    const technician = preferredTechnicianId ?? read.technicianIds[0];
    if (bay === undefined || technician === undefined) {
      return answer(rejected('SLOT_UNAVAILABLE'));
    }

    const appointment = await attempt.tryInsert({
      dealershipId: request.dealershipId,
      serviceTypeId: input.serviceTypeId,
      customerId: request.customerId,
      vehicleId: request.vehicleId,
      serviceBayId: bay,
      technicianId: technician,
      range,
      // Stored in the same insert, so the unique index on (customer_id,
      // idempotency_key) lets only one of two twins in. The loser gets zero
      // rows and its next read finds the winner's key.
      ...(idempotency
        ? { idempotency: { key: idempotency.key, requestHash: idempotency.requestHash } }
        : {}),
    });
    return appointment ? answer({ kind: 'created', appointment }) : { kind: 'lost' };
  }

  // The answer is already settled by the time this runs, and a booking may
  // already be committed. A broken metric or log line must not turn that into
  // a 500 the client would then retry, so an observer error is only logged.
  private observe(
    request: BookingRequest,
    outcome: { outcome: BookingOutcome; reason?: ContendedReason },
    counts: LoopCounts,
    startedAt: number,
  ): void {
    try {
      this.observer.record({
        dealershipId: request.dealershipId,
        serviceTypeId: request.serviceTypeId,
        ...outcome,
        attempts: counts.attempts,
        lostRaces: counts.lostRaces,
        durationMs: this.clock.now().getTime() - startedAt,
      });
    } catch (error) {
      this.logger.warn(
        `booking observer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// The outcome as the API names it: created, replayed or the error code. A
// 503 is BOOKING_CONTENDED with its reason next to it.
function outcomeOf(result: BookingResult): { outcome: BookingOutcome; reason?: ContendedReason } {
  switch (result.kind) {
    case 'created':
    case 'replayed':
      return { outcome: result.kind };
    case 'rejected':
      return { outcome: result.code };
    case 'contended':
      return { outcome: 'BOOKING_CONTENDED', reason: result.reason };
  }
}

function answer(result: BookingResult): AttemptOutcome {
  return { kind: 'answer', result };
}

// Somebody already booked with this customer's key. Same request: hand back
// that booking. Different request: 422, never somebody else's booking.
function answerForKey(found: KeyedAppointment, idempotency: Idempotency): BookingResult {
  return found.requestHash === idempotency.requestHash
    ? { kind: 'replayed', appointment: found.appointment }
    : rejected('IDEMPOTENCY_KEY_REUSED');
}

type LookupCheck =
  | { ok: false; code: BookingErrorCode }
  | {
      ok: true;
      dealership: NonNullable<BookingLookup['dealership']>;
      serviceType: NonNullable<BookingLookup['serviceType']>;
    };

// The 404s, then the 422s that don't need a time, in the SPEC "Order of
// checks". The first one that fails decides the code.
function checkLookup(request: BookingRequest, lookup: BookingLookup): LookupCheck {
  const refuse = (code: BookingErrorCode): LookupCheck => ({ ok: false, code });
  const { dealership, serviceType, vehicle, preferredTechnician } = lookup;
  const wantsTechnician = request.preferredTechnicianId != null;

  if (!dealership) return refuse('DEALERSHIP_NOT_FOUND');
  if (!serviceType) return refuse('SERVICE_TYPE_NOT_FOUND');
  if (!lookup.customerFound) return refuse('CUSTOMER_NOT_FOUND');
  if (!vehicle) return refuse('VEHICLE_NOT_FOUND');
  if (wantsTechnician && !preferredTechnician) return refuse('TECHNICIAN_NOT_FOUND');

  // Ownership is checked here at booking time and not by the schema, because
  // cars get sold (ADR 001).
  if (vehicle.customerId !== request.customerId) return refuse('VEHICLE_NOT_OWNED_BY_CUSTOMER');

  // The preferred technician has to work here and have the skill. Busy or
  // not is the loop's question, this one can never work as asked.
  if (
    wantsTechnician &&
    preferredTechnician &&
    (preferredTechnician.dealershipId !== dealership.id ||
      !preferredTechnician.skillCodes.includes(serviceType.requiredSkillCode))
  ) {
    return refuse('TECHNICIAN_NOT_ELIGIBLE');
  }

  // No bay at all, or nobody with the skill at all. Permanent, so a 422 and
  // not a 409, because a 409 means "try another time" (A20).
  if (!lookup.offersService) return refuse('SERVICE_NOT_OFFERED');

  return { ok: true, dealership, serviceType };
}

// pg errors carry the SQLSTATE in `code`, and Kysely passes them on as they are.
function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
