// Where the JSON log lines go. stdout in the app, a test swaps in its own
// stream to read them back (AC-36).
// Step 7 red stub: only the token so far, nothing provides it yet.
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');
