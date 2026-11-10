// Injection tokens for the booking service's dependencies. They are
// interfaces, so Nest needs a token to find them. The module that wires them
// up comes with the REST layer in step 5.
export const BOOKING_STORE = Symbol('BOOKING_STORE');
export const BOOKING_CONFIG = Symbol('BOOKING_CONFIG');
export const CLOCK = Symbol('CLOCK');
// Optional. Without it the service uses a no-op observer (booking.observer.ts).
export const BOOKING_OBSERVER = Symbol('BOOKING_OBSERVER');
