import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Metrics } from '../common/metrics.js';
import type { BookingObserver, BookingRecord } from './booking.observer.js';

// The app's booking observer: the booking metrics and one log line per
// booking request, both from the same record. The record only has ids and
// numbers, so nothing personal can reach the log from here.
@Injectable()
export class BookingTelemetry implements BookingObserver {
  constructor(
    private readonly metrics: Metrics,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('Booking');
  }

  record(record: BookingRecord): void {
    const { metrics } = this;
    metrics.bookingRequests.inc({ outcome: record.outcome.toLowerCase() });
    if (record.reason) metrics.bookingContended.inc({ reason: record.reason });
    metrics.bookingAttempts.observe(record.attempts);
    metrics.bookingLostRaces.inc(record.lostRaces);
    metrics.bookingDuration.observe(record.durationMs / 1000);

    // pino adds the reqId of the request this runs in
    this.logger.info({ ...record }, 'booking');
  }
}
