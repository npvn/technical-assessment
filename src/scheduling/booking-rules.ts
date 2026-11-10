// Fixed by the SPEC, not config. Starts sit on a 15 minute grid (A9) and
// can be at most 90 days ahead (A10). The booking path and the
// availability list both read them from here, so they can't drift apart.
export const STEP_MINUTES = 15;
export const HORIZON_DAYS = 90;
