import { overlaps, rangeFromStart } from '../../../src/scheduling/index.js';
import { BRAKES_MINUTES, DIAG_MINUTES, OIL_MINUTES, at, range } from './fixtures.js';

describe('overlaps', () => {
  it('AC-02 touching ranges do not overlap, in either order', () => {
    const existing = range('2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z');
    const next = range('2027-03-09T10:00:00Z', '2027-03-09T11:00:00Z');
    expect(overlaps(existing, next)).toBe(false);
    expect(overlaps(next, existing)).toBe(false);
  });

  it('AC-03 a range starting inside another overlaps it', () => {
    const existing = range('2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z');
    const request = rangeFromStart(at('2027-03-09T09:30:00Z'), OIL_MINUTES);
    expect(overlaps(existing, request)).toBe(true);
    expect(overlaps(request, existing)).toBe(true);
  });

  it('AC-06 the whole duration counts, not only the start', () => {
    // T1 is booked 10:30 to 11:30. BRAKES at 10:00 starts while T1 is free
    // but runs into the booking.
    const t1Booking = range('2027-03-09T10:30:00Z', '2027-03-09T11:30:00Z');
    const brakes = rangeFromStart(at('2027-03-09T10:00:00Z'), BRAKES_MINUTES);
    expect(brakes.end).toEqual(at('2027-03-09T11:30:00Z'));
    expect(overlaps(brakes, t1Booking)).toBe(true);
    expect(overlaps(t1Booking, brakes)).toBe(true);
  });

  it('AC-07 a range that contains a booking overlaps it', () => {
    const booking = range('2027-03-09T10:00:00Z', '2027-03-09T11:00:00Z');
    const diag = rangeFromStart(at('2027-03-09T09:00:00Z'), DIAG_MINUTES);
    expect(overlaps(diag, booking)).toBe(true);
    expect(overlaps(booking, diag)).toBe(true);
  });

  it('AC-07 a range inside a booking overlaps it', () => {
    const booking = range('2027-03-09T10:00:00Z', '2027-03-09T11:00:00Z');
    const oil = range('2027-03-09T10:15:00Z', '2027-03-09T10:45:00Z');
    expect(overlaps(oil, booking)).toBe(true);
    expect(overlaps(booking, oil)).toBe(true);
  });

  it('a range overlaps itself', () => {
    const r = range('2027-03-09T10:00:00Z', '2027-03-09T11:00:00Z');
    expect(overlaps(r, r)).toBe(true);
  });

  it('ranges with a gap between them do not overlap', () => {
    const a = range('2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z');
    const b = range('2027-03-09T10:00:00.001Z', '2027-03-09T11:00:00Z');
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(b, a)).toBe(false);
  });

  it('a one millisecond overlap still counts', () => {
    const a = range('2027-03-09T09:00:00Z', '2027-03-09T10:00:00.001Z');
    const b = range('2027-03-09T10:00:00Z', '2027-03-09T11:00:00Z');
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(b, a)).toBe(true);
  });
});

describe('rangeFromStart', () => {
  it('AC-01 OIL at 09:00 ends at 10:00', () => {
    expect(rangeFromStart(at('2027-03-09T09:00:00Z'), OIL_MINUTES)).toEqual(
      range('2027-03-09T09:00:00Z', '2027-03-09T10:00:00Z'),
    );
  });

  it('AC-14 60 minutes across the autumn change ends one real hour later', () => {
    // 01:30 BST plus 60 real minutes is 01:30 GMT. Wall clock maths would give 02:30Z.
    const r = rangeFromStart(at('2027-10-31T00:30:00Z'), 60);
    expect(r.start).toEqual(at('2027-10-31T00:30:00Z'));
    expect(r.end).toEqual(at('2027-10-31T01:30:00Z'));
  });

  it('AC-14 120 minutes across the spring change ends two real hours later', () => {
    // 00:30 GMT plus 120 real minutes is 03:30 BST (02:30Z). Wall clock maths
    // would give 02:30 local, which is 01:30Z. A 60 minute case can't tell the
    // two apart, because the skipped hour lands both on the same instant.
    const r = rangeFromStart(at('2027-03-28T00:30:00Z'), 120);
    expect(r.start).toEqual(at('2027-03-28T00:30:00Z'));
    expect(r.end).toEqual(at('2027-03-28T02:30:00Z'));
  });
});
