import { createHash } from 'node:crypto';
import type { BookingRequest } from './booking.types.js';

// The Idempotency-Key header and the request hash (A15, ADR 001 decision 3).
// Both are pure, so they are unit tested without Nest or a database.

export type IdempotencyKeyCheck = { ok: true; key: string | null } | { ok: false; message: string };

const MAX_KEY_LENGTH = 255;
// Visible ASCII only, "!" (0x21) to "~" (0x7e). No spaces, so two headers
// that Express joined with ", " are refused too.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

// No header means no key. An empty header is still a header, so it is
// refused like any other bad value.
export function parseIdempotencyKey(raw: string | undefined): IdempotencyKeyCheck {
  if (raw === undefined) return { ok: true, key: null };
  if (raw.length === 0 || raw.length > MAX_KEY_LENGTH || !VISIBLE_ASCII.test(raw)) {
    return {
      ok: false,
      message: `Idempotency-Key must be 1 to ${MAX_KEY_LENGTH} visible ASCII characters`,
    };
  }
  return { ok: true, key: raw };
}

// SHA-256 hex over a fixed form of the parsed request. It is stored on the
// row and compared on every retry, so this form must never change, or every
// stored key would turn into a 422 for its own retry.
// - the fields always in this order, written as JSON so no value can run
//   into the next one
// - ids in lower case, because Postgres treats an upper case UUID as the
//   same id
// - a missing preferred technician written as null
// - the start as milliseconds since the epoch, so the offset the client
//   used doesn't matter (AC-28)
// The key itself is left out, the hash is about what was asked for.
export function requestHash(request: BookingRequest): string {
  const canonical = JSON.stringify({
    dealershipId: request.dealershipId.toLowerCase(),
    serviceTypeId: request.serviceTypeId.toLowerCase(),
    customerId: request.customerId.toLowerCase(),
    vehicleId: request.vehicleId.toLowerCase(),
    preferredTechnicianId: request.preferredTechnicianId?.toLowerCase() ?? null,
    startTime: request.startTime.getTime(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
