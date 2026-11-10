// Timeouts and the loop budget for booking (SPEC "Timeouts and 503").
// lockTimeoutMs and statementTimeoutMs are set with SET LOCAL at the start of
// every booking transaction. loopBudgetMs is the most time the whole loop may
// take before it answers 503 instead of starting another attempt.
export interface BookingConfig {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  loopBudgetMs: number;
}

export const DEFAULT_BOOKING_CONFIG: BookingConfig = {
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
  loopBudgetMs: 5_000,
};
