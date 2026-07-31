# POD-279 — verified state of the integration branch

Measured on 2026-07-31, on a quiet host, with a clean working tree and
`bun install` run first. RE-MEASURED at the end of the run; the table below is
the later of the two and supersedes the earlier numbers. Every number below was produced in this one sitting;
none is quoted from a handoff.

## Result: fully green, all three lanes, zero failures

| Check | Result |
|---|---|
| `bun run typecheck --force` | 23/23 successful, **`Cached: 0 cached, 23 total`** |
| `bun run test:unit` | 605 files, **8800 passed**, 19 skipped, 0 failed |
| `bun run test:web` | 180 files, **1440 passed**, 0 failed |
| `bun run test:mobile` | 4 files, **34 passed**, 0 failed |
| `bun run migration:check` | clean |

Twelve gates, all exit 0 (`lint:shadowing` was added during the run by POD-1246,
to catch a merge defect neither git nor the typechecker reports): `check-boundaries`, `check-no-nul-bytes`,
`audit-settings-commands`, `audit-client-secrets`, `audit-browser-reach`,
`audit-derived-families`, `audit-machine-grants`, `audit-router-mutations`,
`audit-durable-classes`, `audit-declared-consumers`, `rearch-audit`, `lint:shadowing`.

`audit-phase2-client` reports **4** open `unattributed-store-read` sites and is
RED BY DESIGN — see below.

## The one deliberate red

`audit:phase2-client` names four composition roots that adopt a persisted client
store without establishing the current principal:

    apps/web/src/lib/desktopReplica.ts:135      closes with the TanStack deletion
    apps/web/src/lib/shadow/runner.ts:110       POD-1223's shadow harness
    apps/web/src/lib/webReplica.ts:63           POD-1239 relocated it here so a
                                                web agent CAN close it
    packages/client-core/src/replica/legacy-snapshot.ts:124   fixture capture,
                                                reported not excluded

Two of the original six are closed (mobile and the kernel web root), each with a
counterfactual proving the rows are DISCARDED rather than a no-op passing. The
gate was merged red on purpose: the sites predate the instrument, and silencing a
gate on the day it first says NO reproduces the defect it was built to expose.

## Known-flaky, all passing in this run

`scripts/loop-split-load.integration` (p95 perf, load-sensitive),
`scripts/rearch-audit.test.ts` (CLI cases spawnSync), `apps/web RepoScanFlow` and
`IssuePage.agent-start` (web-lane contention, POD-1238 — the failing SET varies
between runs, so it is contention rather than two test bugs). All four passed
here; under host load average 50-84 earlier in the run they did not, and every
merge that passed one of them recorded which lane the claim rested on.

## What is NOT verified by any of the above

- **The rewrite is not on `main`.** See POD-1246; 19 of 109 conflicts resolved.
- **No real-device mobile run.** `expo-sqlite` is the thing under test and the
  web export cannot stand in (POD-1220).
- **The 70 Playwright browser suites** now have a lane (POD-1227) but it is
  non-blocking and their pass/fail census is not part of this result.
- **POD-1244** (second-tab convergence on the kernel replica) is open and blocks
  turning the kernel flag on by default. The flag resolves absent to `false`, so
  nothing shipped depends on it.
