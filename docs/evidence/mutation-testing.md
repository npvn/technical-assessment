# Mutation testing on src/scheduling

The question: do the unit tests on the pure scheduling rules actually pin them down, or would they still pass with a rule quietly broken?

## Setup

- Stryker 10.1.1 with the vitest runner, `npm run test:mutation`. It mutates `src/scheduling/**/*.ts` minus `index.ts`.
- It uses its own vitest config (`test/stryker/vitest.config.ts`) that runs only `test/unit/scheduling/`, so nothing starts Postgres. One run takes about 15 s.
- It's not part of `npm run ci`. It's a check I run when the rules change.

## Score

| Run                       | Mutants | Killed | Survived | No coverage | Score  |
| ------------------------- | ------- | ------ | -------- | ----------- | ------ |
| Before, no new tests      | 222     | 203    | 16       | 3           | 91.44% |
| After 6 new tests         | 222     | 216    | 6        | 0           | 97.30% |
| After the Havana fix (\*) | 221     | 215    | 6        | 0           | 97.29% |

(\*) Later, after the opening hours check stopped using Luxon's `hasSame(end, 'day')` (see [load-run.md](load-run.md)). The one mutant fewer is the `'day'` string, which isn't there any more:

```
All files              |  97.29 |   97.29 |      215 |         0 |          6 |        0 |        0 |
 opening-hours.ts      | 100.00 |  100.00 |       52 |         0 |          0 |        0 |        0 |
```

## The gaps the new tests closed

13 of the 19 survivors and uncovered mutants were real gaps. The bar I used: if a direct call to the function can tell the mutant apart, it gets a test.

- `opening-hours.ts`, bad opening times (5 mutants). No test fed one, so dropping the `throw`, emptying the message or losing `^` or `$` from the regex all passed (`'108:00:00'` read as `08:00:00`, `'08:00:00x'` accepted). New test: "throws on an opening or closing time that is not HH:MM or HH:MM:SS".
- `opening-hours.ts`, seconds (4 mutants). Every window in the tests was on a whole minute, so subtracting seconds or dividing by 1000 instead of multiplying passed. New test: "opening and closing times with seconds are exact to the second" (window 08:00:30 to 17:30:30).
- `opening-hours.ts`, `MS_PER_MINUTE = 60 / 1000` (1 mutant). Hours and minutes shrink on both sides of the compare, so only seconds in the range show it. New test: "seconds in the range count against whole minute opening hours".
- `zone.ts` (2 mutants). The tests only matched the zone name, and nothing reached the `'invalid'` fallback. New file `zone.test.ts` with "the error for an unknown zone carries the reason Luxon gives" and "an Invalid Date throws too, and the message falls back to "invalid"".
- `grid.ts`, `hour * 60 - minute` (1 mutant). With a step that divides 60 the hours drop out of the `%`, so plus or minus gives the same answer. New test: "works for a step that does not divide the hour" (45 minute step).

All new tests are fixed examples, no random inputs, and no existing test changed.

## The 6 survivors left, and why

- `parse-instant.ts:43` and `:53`, 5 mutants on the `minute > 59` and `second > 59` checks and the `second ?? '0'` default. Equivalent: the regex only lets two digits through and Luxon's `fromObject` refuses minute and second 60 to 99 anyway (checked on Luxon 3.7.2), and `Number("")` and `Number('0')` are both 0. I keep the explicit checks because they say what the rule is without leaning on Luxon, and the minute 60 and second 60 tests would catch it if Luxon ever got looser.
- `time-range.ts:18`, `fromJSDate(start, { zone: 'utc' })` becoming `fromJSDate(start, {})`. Not strictly equivalent. 200,000 starts from 2020 to 2040 under seven `TZ` settings (UTC, Europe/London, America/New_York, Australia/Lord_Howe, Asia/Kolkata, Pacific/Chatham, America/St_Johns) gave 0 differences. It only differs at the very edge of what a JS Date can hold (around the year 275760) and only on a non-UTC process, and the Docker image runs in UTC. Killing it would need a test that flips `process.env.TZ`, which costs more than it proves. The `{ zone: 'utc' }` stays.
