import { toZone } from '../../../src/scheduling/zone.js';
import { LONDON, at } from './fixtures.js';

// Added after mutation testing (PLAN step 10). The other tests only check
// that the zone name is in the error, not the reason after it.
describe('toZone', () => {
  it('the error for an unknown zone carries the reason Luxon gives', () => {
    expect(() => toZone(at('2027-03-09T09:00:00Z'), 'Mars/Nowhere')).toThrow(
      /Mars\/Nowhere.*not supported/,
    );
  });

  it('an Invalid Date throws too, and the message falls back to "invalid"', () => {
    // Luxon gives no reason for a bad Date, so the fallback word is all there is.
    expect(() => toZone(new Date(NaN), LONDON)).toThrow(/: invalid$/);
  });
});
