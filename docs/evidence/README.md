# Evidence

- [teeth-checks.md](teeth-checks.md) - the race and idempotency tests going red with the constraints, the re-read or the key check removed
- [deadlock-repro.sh](deadlock-repro.sh) and [deadlock-repro-output.txt](deadlock-repro-output.txt) - plain `INSERT` against `ON CONFLICT DO NOTHING` under 16 clients, the reason for ADR 001's insert
- [load-run.md](load-run.md) - the overlap check, the first load run that missed A23, the CPU fix and the final run
- [mutation-testing.md](mutation-testing.md) - Stryker on `src/scheduling`, the gaps it found and the survivors left
- [concurrency-experiments.md](concurrency-experiments.md) - the experiments behind ADR 001, every option against Postgres 16 under parallel load, with the commands and raw output
