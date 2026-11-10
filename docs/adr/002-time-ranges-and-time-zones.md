# ADR 002: Time ranges and time zones

Status: accepted, 2026-11-10

## The problem

Scheduling code is where small time mistakes hide, and they don't show up in a happy-path test. The ones I wanted to rule out from the start:

- a job ending at 10:00 blocking the next one starting at 10:00 (a closed range or a `<=` in the overlap check)
- a Monday morning booking in Sydney checked against Sunday's opening hours, because the weekday was taken from the UTC value
- `"2026-11-20T08:30:00Z"` compared with a 09:00 opening time as if 08:30 were local time (it's 09:30 in Berlin)
- the server's own time zone leaking in through `new Date("2026-11-20 09:00")`
- a job on the day the clocks change ending an hour off

## The decision

1. **Half-open ranges, `[start, end)`, everywhere.** In the overlap function, in the availability query and in the exclusion constraints (`tstzrange(starts_at, ends_at, '[)')`). Two ranges overlap when `a.start < b.end && b.start < a.end`, with strict `<` on both sides. Back-to-back jobs are fine, and that's the normal case on a busy day.
2. **The database stores instants.** `starts_at` and `ends_at` are `timestamptz` (UTC inside Postgres). The database never deals with local time.
3. **The API only takes exact instants.** `startTime` must be ISO 8601 with an explicit offset (`Z` or `+01:00`). A time without an offset gets 400, because "09:00" alone means a different moment depending on who reads it. Because the offset is always there, the "this local time doesn't exist" problem of daylight saving (01:30 on a spring-forward night) can't come in through the API.
4. **The end is the start plus the duration in real minutes.** `ends_at = starts_at + duration_minutes`, computed on the instant, not on the wall clock. A 60 minute job is 60 minutes long even on the night the clocks change.
5. **Business rules are checked in the dealership's own time zone.** Each dealership has an IANA zone (`Europe/London`, `Australia/Sydney`). The weekday, the opening window and the 15 minute grid are all worked out by converting the instant into that zone with Luxon. Opening hours are stored as local wall times (`08:00` to `17:30`), because that's how a dealership thinks about them, and they stay right across daylight saving changes without any edit.
6. **One clock, injected.** Domain code never calls `new Date()` or `Date.now()`. A `Clock` is injected, so "now" is fixed in tests and "must be in the future" doesn't rot when the calendar moves on.
7. **Responses carry both.** Every appointment comes back with UTC times and the dealership's local times with offset, so a client never has to know the zone rules to show "Tuesday 09:00".

## Why Luxon

Node 24 doesn't ship the Temporal API without a polyfill yet. Luxon is small, mature, and does zone-aware arithmetic on IANA zones using the runtime's own time zone data. date-fns-tz would also work. I went with Luxon because its `DateTime.setZone(...)` reads very close to the rule it implements, which helps when someone reviews the opening-hours code.

## Trade-offs

- Clients have to send an offset. That's a little more work for a client, but every real client (a web app, a mobile app, a dealer system) knows its offset, and it removes a whole class of guessing on the server.
- Opening hours stored as local wall times means a day where the clocks change is a 23 or 25 hour day in UTC terms. That's what a dealership expects (it still opens at 08:00), and the test suite covers both changes for `Europe/London`.
- Windows that run past midnight aren't supported (A6). Service departments don't run overnight shifts, and allowing it would make "which day's hours apply" a real question.
