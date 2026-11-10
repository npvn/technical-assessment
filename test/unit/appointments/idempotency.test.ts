import { createHash } from 'node:crypto';
import type { BookingRequest } from '../../../src/appointments/booking.types.js';
import { parseIdempotencyKey, requestHash } from '../../../src/appointments/idempotency.js';
import { parseInstant } from '../../../src/scheduling/index.js';

// The two pure halves of the Idempotency-Key (A15): the header check and the
// hash that tells a replay from a reused key.

const REQUEST: BookingRequest = {
  dealershipId: 'de000000-0000-4000-8000-000000000001',
  serviceTypeId: '5e000000-0000-4000-8000-000000000001',
  customerId: 'c0000000-0000-4000-8000-000000000001',
  vehicleId: '0e000000-0000-4000-8000-000000000001',
  startTime: new Date('2027-03-09T09:00:00Z'),
  preferredTechnicianId: null,
};

// The canonical form, spelled out. The hash is stored on the row and compared
// on every retry, so changing this form would turn every stored key into a
// 422 for its own retry. If this test breaks, that's the reason to stop.
// Fixed field order, ids in lower case, a missing preferred technician as
// null, and the start as milliseconds since the epoch (a UTC instant, so the
// offset the client wrote it with doesn't matter).
const CANONICAL =
  '{"dealershipId":"de000000-0000-4000-8000-000000000001",' +
  '"serviceTypeId":"5e000000-0000-4000-8000-000000000001",' +
  '"customerId":"c0000000-0000-4000-8000-000000000001",' +
  '"vehicleId":"0e000000-0000-4000-8000-000000000001",' +
  '"preferredTechnicianId":null,' +
  '"startTime":1804582800000}';

const BASE_HASH = createHash('sha256').update(CANONICAL).digest('hex');

function instant(text: string): Date {
  const parsed = parseInstant(text);
  if (!parsed) throw new Error(`test setup: ${text} did not parse`);
  return parsed;
}

describe('requestHash', () => {
  it('is the SHA-256 hex of the canonical form', () => {
    expect(requestHash(REQUEST)).toBe(BASE_HASH);
    expect(BASE_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC-28 the same instant written with another offset gives the same hash', () => {
    const london = { ...REQUEST, startTime: instant('2027-03-09T09:00:00Z') };
    const plusOne = { ...REQUEST, startTime: instant('2027-03-09T10:00:00+01:00') };

    expect(requestHash(plusOne)).toBe(BASE_HASH);
    expect(requestHash(london)).toBe(BASE_HASH);
  });

  it('AC-27 a missing preferred technician and null are the same', () => {
    const missing: BookingRequest = { ...REQUEST };
    delete missing.preferredTechnicianId;

    expect(requestHash(missing)).toBe(BASE_HASH);
    expect(requestHash({ ...REQUEST, preferredTechnicianId: undefined })).toBe(BASE_HASH);
  });

  it('the key itself is not part of the hash, only the request it came with', () => {
    expect(requestHash({ ...REQUEST, idempotencyKey: 'key-1' })).toBe(BASE_HASH);
    expect(requestHash({ ...REQUEST, idempotencyKey: 'key-2' })).toBe(BASE_HASH);
  });

  it('ids in upper case are the same ids, so they give the same hash', () => {
    const upper: BookingRequest = {
      ...REQUEST,
      dealershipId: REQUEST.dealershipId.toUpperCase(),
      serviceTypeId: REQUEST.serviceTypeId.toUpperCase(),
      customerId: REQUEST.customerId.toUpperCase(),
      vehicleId: REQUEST.vehicleId.toUpperCase(),
      preferredTechnicianId: '7E000000-0000-4000-8000-00000000000A',
    };
    const lower = { ...REQUEST, preferredTechnicianId: '7e000000-0000-4000-8000-00000000000a' };

    expect(requestHash(upper)).toBe(requestHash(lower));
    expect(requestHash(lower)).toMatch(/^[0-9a-f]{64}$/);
  });

  // customerId is in the hash too, even though the key lookup is per
  // customer (a different customer never even finds the key, AC-31).
  const CHANGES: [string, Partial<BookingRequest>][] = [
    ['dealershipId', { dealershipId: 'de000000-0000-4000-8000-000000000002' }],
    ['serviceTypeId', { serviceTypeId: '5e000000-0000-4000-8000-000000000002' }],
    ['customerId', { customerId: 'c0000000-0000-4000-8000-000000000002' }],
    ['vehicleId', { vehicleId: '0e000000-0000-4000-8000-000000000002' }],
    ['preferredTechnicianId', { preferredTechnicianId: '7e000000-0000-4000-8000-000000000001' }],
    ['startTime (15 minutes later)', { startTime: new Date('2027-03-09T09:15:00Z') }],
    ['startTime (1 ms later)', { startTime: new Date('2027-03-09T09:00:00.001Z') }],
  ];

  it.each(CHANGES)('AC-27 a change to %s changes the hash', (_field, change) => {
    const changed = requestHash({ ...REQUEST, ...change });

    expect(changed).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(BASE_HASH);
  });

  it('two different preferred technicians give different hashes', () => {
    const t1 = requestHash({
      ...REQUEST,
      preferredTechnicianId: '7e000000-0000-4000-8000-000000000001',
    });
    const t2 = requestHash({
      ...REQUEST,
      preferredTechnicianId: '7e000000-0000-4000-8000-000000000002',
    });

    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(t1).not.toBe(t2);
  });
});

describe('parseIdempotencyKey', () => {
  it('no header means no key', () => {
    expect(parseIdempotencyKey(undefined)).toEqual({ ok: true, key: null });
  });

  it.each([
    ['a plain key', 'booking-42'],
    ['a UUID', '9b2d8c4e-1f3a-4c5b-8d6e-7f8091a2b3c4'],
    ['one character', 'x'],
    ['255 characters', 'k'.repeat(255)],
    ['every visible ASCII character', visibleAscii()],
  ])('accepts %s as it is', (_name, raw) => {
    expect(parseIdempotencyKey(raw)).toEqual({ ok: true, key: raw });
  });

  it.each([
    ['empty', ''],
    ['256 characters', 'k'.repeat(256)],
    ['a space inside', 'booking 42'],
    ['a tab', 'booking\t42'],
    ['a control character', 'booking\u000042'],
    ['DEL', 'booking\u007f'],
    ['a non-ASCII letter', 'buchung-ä'],
    ['two headers joined by a comma and space', 'key-1, key-2'],
  ])('refuses %s and names the header', (_name, raw) => {
    const result = parseIdempotencyKey(raw);

    expect(result).toEqual({ ok: false, message: expect.stringContaining('Idempotency-Key') });
  });
});

// 0x21 "!" to 0x7e "~", 94 characters.
function visibleAscii(): string {
  return Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join('');
}
