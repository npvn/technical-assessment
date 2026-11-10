// Strict parsing of the startTime the API takes (AC-17, ADR 002).
// Returns the exact instant, or null when the text isn't a full ISO 8601 date
// and time with an explicit offset.
export function parseInstant(_text: string): Date | null {
  throw new Error('not implemented');
}
