import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { DB_POOL } from './database.module.js';

// Every metric the app exposes at /metrics (DESIGN section 7), on a registry
// of its own rather than prom-client's global one. Two apps in one process
// (the e2e tests boot several) would otherwise share counters, and the
// second would fail to register the same names.
@Injectable()
export class Metrics {
  readonly registry = new Registry();

  // created, replayed or the lower case error code
  readonly bookingRequests = new Counter({
    name: 'booking_requests_total',
    help: 'Booking requests by outcome',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  readonly bookingContended = new Counter({
    name: 'booking_contended_total',
    help: 'Booking requests that got a 503, by internal reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  // 0 means the request was answered before the loop (a 404, a 422, a replay)
  readonly bookingAttempts = new Histogram({
    name: 'booking_attempts',
    help: 'Transactions the booking loop started for one request',
    buckets: [0, 1, 2, 3, 5, 8, 13, 21],
    registers: [this.registry],
  });

  readonly bookingLostRaces = new Counter({
    name: 'booking_lost_races_total',
    help: 'Booking inserts that came back with zero rows because someone got in first',
    registers: [this.registry],
  });

  readonly bookingDuration = new Histogram({
    name: 'booking_duration_seconds',
    help: 'Time to answer a booking request',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  // route is the route template (/appointments/:id), never the raw path, so
  // ids don't each get their own series
  readonly httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by method, route and status',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration by method, route and status',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor(@Inject(DB_POOL) pool: pg.Pool) {
    collectDefaultMetrics({ register: this.registry });

    // Read from the pool at scrape time. Pool saturation is the first thing
    // I'd expect to go wrong under load.
    const registers = [this.registry];
    new Gauge({
      name: 'db_pool_total_connections',
      help: 'Connections the pool has open, busy or idle',
      registers,
      collect() {
        this.set(pool.totalCount);
      },
    });
    new Gauge({
      name: 'db_pool_idle_connections',
      help: 'Open connections nobody is using',
      registers,
      collect() {
        this.set(pool.idleCount);
      },
    });
    new Gauge({
      name: 'db_pool_waiting_clients',
      help: 'Queries waiting for a free connection',
      registers,
      collect() {
        this.set(pool.waitingCount);
      },
    });
  }
}
