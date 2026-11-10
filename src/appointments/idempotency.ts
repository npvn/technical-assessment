import type { BookingRequest } from './booking.types.js';

// The Idempotency-Key header and the request hash (A15, ADR 001 decision 3).
// Both are pure, so they are unit tested without Nest or a database.

export type IdempotencyKeyCheck = { ok: true; key: string | null } | { ok: false; message: string };

// Step 8 red stub, returns a wrong value on purpose.
export function parseIdempotencyKey(_raw: string | undefined): IdempotencyKeyCheck {
  return { ok: false, message: 'not implemented' };
}

// Step 8 red stub, returns a wrong value on purpose.
export function requestHash(_request: BookingRequest): string {
  return '';
}
