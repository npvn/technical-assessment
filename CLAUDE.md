# Rules for AI agents working in this repo

This is a NestJS + PostgreSQL service that books a service bay and a qualified technician for the whole length of a service appointment. Read docs/SPEC.md and docs/PLAN.md before changing anything.

## Commands

- `npm test` runs everything (unit, integration, e2e). Integration and e2e start a Postgres container through Testcontainers, so Docker must be running.
- `npm run test:unit` runs the fast pure tests only.
- `npm run lint`, `npm run typecheck`, `npm run format:check`
- `npm run ci` runs the full gate: format, lint, typecheck, build, all tests.
- `docker compose up --build` runs the API with Postgres, migrations and seed data.

## Hard rules

1. **Never edit a test to make it pass.** If a test looks wrong, stop and say why. I decide.
2. **No change beyond the current PLAN.md step.** No new libraries, endpoints or abstractions that the step doesn't ask for. If you think something is missing, say so instead of adding it.
3. **Test first.** Red step: write the tests, run them, show they fail on an assertion (not on a missing import). Green step: the minimum code that makes them pass.
4. **Show the command output.** "Done" or "tests pass" without the output means nothing.
5. **Every booking write goes through one database transaction.** No check-then-insert outside it. The exclusion constraints in the database are the guarantee against double booking. Application checks are only there to give a friendly answer.
6. **Times are UTC `timestamptz` in the database.** Requests carry an explicit offset. Opening hours are evaluated in the dealership's IANA time zone with Luxon. Never use the server's local time, never parse a time without an offset, and never call `new Date()` or `Date.now()` in domain code. Use the injected `Clock`.
7. **Time ranges are half open, `[start, end)`.** A booking ending at 10:00 does not clash with one starting at 10:00.
8. **Pure scheduling rules live in `src/scheduling/` and do not import Nest, Kysely or pg.** Keep them easy to unit test.
9. **SQL migrations are plain SQL and never edited after they are committed.** Add a new one instead.
10. **Do not commit, stage, stash or clean in git.** The engineer reviews the diff and commits.
11. **Never log customer names, emails or VINs.** Log ids.
12. **A concurrency test counts only once it has been seen failing without the thing it protects.** Drop the constraint (or remove the retry) in a scratch copy and show the test go red. Timing-based races pass by luck, so race tests hold every request at a barrier before the write (see `test/integration/appointments/race-barrier.ts`).

## Style

- TypeScript strict mode. ESM (`.js` extensions in relative imports).
- Errors leave the API as `application/problem+json` (RFC 9457) with a stable `code`.
- Comments in plain language. Explain why, not what. No em dashes and no semicolons in comments.

## Saving progress

Write your output to the file you were given early and update it as you go, so an interruption loses little. If you stop partway, the file should say what is done and what is left.
