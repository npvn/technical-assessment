import fc from 'fast-check';
import { overlaps, rangeFromStart, type TimeRange } from '../../../src/scheduling/index.js';

// Ranges are built from whole minutes on a small timeline, so random ranges
// touch and overlap often. Building them from integers (not fc.date) also
// keeps Invalid Date out of the inputs.
const BASE_MS = Date.parse('2027-03-09T00:00:00Z');
const MINUTE_MS = 60_000;
const TIMELINE_MINUTES = 120;

function fromMinutes(startMinute: number, endMinute: number): TimeRange {
  return {
    start: new Date(BASE_MS + startMinute * MINUTE_MS),
    end: new Date(BASE_MS + endMinute * MINUTE_MS),
  };
}

// A non-empty range [s, s + len) in whole minutes.
const minuteRange = fc
  .record({
    start: fc.integer({ min: 0, max: TIMELINE_MINUTES }),
    length: fc.integer({ min: 1, max: 60 }),
  })
  .map(({ start, length }) => ({ start, end: start + length }));

describe('overlaps (property)', () => {
  it('is symmetric', () => {
    fc.assert(
      fc.property(minuteRange, minuteRange, (a, b) => {
        const ra = fromMinutes(a.start, a.end);
        const rb = fromMinutes(b.start, b.end);
        expect(overlaps(ra, rb)).toBe(overlaps(rb, ra));
      }),
    );
  });

  it('touching ranges never overlap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TIMELINE_MINUTES }),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 60 }),
        (edge, before, after) => {
          const first = fromMinutes(edge - before, edge);
          const second = fromMinutes(edge, edge + after);
          expect(overlaps(first, second)).toBe(false);
          expect(overlaps(second, first)).toBe(false);
        },
      ),
    );
  });

  it('matches "some minute is in both" on a whole minute timeline', () => {
    // With whole minute ends, two half-open ranges share an instant exactly
    // when they share a whole minute m with start <= m < end.
    fc.assert(
      fc.property(minuteRange, minuteRange, (a, b) => {
        // Walk every minute on the timeline and look for one inside both ranges.
        const inside = (m: number, r: { start: number; end: number }) => r.start <= m && m < r.end;
        let shared = false;
        for (let m = 0; m <= TIMELINE_MINUTES + 60; m++) {
          if (inside(m, a) && inside(m, b)) shared = true;
        }
        expect(overlaps(fromMinutes(a.start, a.end), fromMinutes(b.start, b.end))).toBe(shared);
      }),
    );
  });

  it('a range overlaps any non-empty range it contains', () => {
    fc.assert(
      fc.property(
        minuteRange,
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 59 }),
        (outer, cutStart, cutEnd) => {
          const length = outer.end - outer.start;
          // Trim both ends but leave at least one minute inside.
          const innerStart = outer.start + Math.min(cutStart, length - 1);
          const innerEnd = Math.max(innerStart + 1, outer.end - cutEnd);
          const o = fromMinutes(outer.start, outer.end);
          const i = fromMinutes(innerStart, innerEnd);
          expect(overlaps(o, i)).toBe(true);
          expect(overlaps(i, o)).toBe(true);
        },
      ),
    );
  });
});

describe('rangeFromStart (property)', () => {
  it('is exactly the duration in real minutes, from the same start', () => {
    fc.assert(
      fc.property(
        // Any whole second between 2020 and 2040, so clock changes in every zone are included.
        fc.integer({
          min: Date.parse('2020-01-01T00:00:00Z') / 1000,
          max: Date.parse('2040-01-01T00:00:00Z') / 1000,
        }),
        fc.integer({ min: 1, max: 600 }),
        (startSeconds, durationMinutes) => {
          const start = new Date(startSeconds * 1000);
          const r = rangeFromStart(start, durationMinutes);
          expect(r.start.getTime()).toBe(start.getTime());
          expect(r.end.getTime() - r.start.getTime()).toBe(durationMinutes * MINUTE_MS);
        },
      ),
    );
  });
});
