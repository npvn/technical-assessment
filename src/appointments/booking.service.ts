import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../scheduling/index.js';
import type { BookingConfig } from './booking.config.js';
import type { BookingStore } from './booking.store.js';
import { BOOKING_CONFIG, BOOKING_STORE, CLOCK } from './booking.tokens.js';
import type { BookingRequest, BookingResult } from './booking.types.js';

// Books one appointment: the lookups, the 404s and 422s, then the loop from
// ADR 001. Nest injects the dependencies in the app, a unit test just calls
// the constructor with a fake store and a test clock.
@Injectable()
export class BookingService {
  constructor(
    @Inject(BOOKING_STORE) private readonly store: BookingStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BOOKING_CONFIG) private readonly config: BookingConfig,
  ) {}

  book(_request: BookingRequest): Promise<BookingResult> {
    return Promise.reject(new Error('not implemented'));
  }
}
