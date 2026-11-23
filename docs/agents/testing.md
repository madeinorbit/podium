# Running tests — which lane, when

Validation guidance for agents working in this repo. Run focused tests during
implementation when they answer a concrete question, then select final checks for the finished
candidate. Avoid repeating broad lanes after each edit or accumulating overlapping checks.

## The normal agent path

At the end of an ordinary runtime-affecting task, run:

    bun run test

This is the lean confidence gate. The root `test` script in `package.json` runs cached,
lock-free typecheck and static checks, including the span-effect lint, then seven exact hermetic
files with one worker: four boot/configuration probes and the Postgres store's three
database-free checks:

| Test file | What it cheaply protects |
| --- | --- |
| `packages/runtime/src/boot.test.ts` | Runtime boot/configuration assembly |
| `apps/server/src/router.setup.test.ts` | Server router construction and required wiring |
| `apps/daemon/src/connection-state.test.ts` | Daemon connection-state startup contract |
| `scripts/test-configuration.test.ts` | Lane membership, exclusions, hermetic setup, and the lean gate's own composition |
| `apps/server/src/migrations/pg/schema-parity.test.ts` | The Postgres schema twin matches the SQLite schema table for table, in the native types of each column's class (POD-6978) |
| `apps/server/src/store/dialect-census.test.ts` | Every store query definition builds on the Postgres tables; the ones that still need a Postgres form are listed with their task (POD-6978) |
| `apps/server/src/migrations/pg/chain-parity.test.ts` | The Postgres baseline migration is what the schema twin renders, and the SQLite and Postgres chains name the same changes (POD-6981) |

It does not run the package sweep, repository rewrite audits, real processes, PTYs,
ports, browsers, performance probes, or agent CLIs. It deliberately does not take `test:heavy`: this bounded one-worker probe neither waits behind
nor delays heavyweight suites.

**Read the footer, and cite it as what it is** [POD-2728]. The lane runs through
`scripts/test-lean.ts`, which measures `vitest.unit.config.ts` at the start of every run
and closes with the ratio it actually covered:

    ────────────────────────────────────────────────
    LEAN GATE PASSED — this is NOT the test suite.

    Ran 6 of the 955 files vitest.unit.config.ts collects in its `node` project (0.6%), 102 tests executed:
      packages/runtime/src/boot.test.ts — 16 tests
      apps/server/src/router.setup.test.ts — 19 tests
      apps/daemon/src/connection-state.test.ts — 11 tests
      scripts/test-configuration.test.ts — 33 tests
      apps/server/src/migrations/pg/schema-parity.test.ts — 15 tests
      apps/server/src/store/dialect-census.test.ts — 8 tests
    ...

(955 is illustrative — every number in that footer is read back out of the runner's own
JSON report for that run, so it tracks the tree rather than this page. The per-file counts
reconcile against Vitest's `Tests N passed (N)` line directly above them; if they ever
disagree, trust neither and say so.)

**`LEAN GATE INCOMPLETE` means you have no gate result at all**, and it exits non-zero.
The run was narrower than the gate's files — a `--shard`, a `-t` filter that matched nothing,
or a `.skip` sitting in one of them. Vitest exits 0 for all three, which is why this is
checked against what executed rather than against what was asked for. Re-run as plain
`bun run test`; do not report the partial run.

That footer exists because agents were reporting `bun run test` green — correctly, in good
faith — as though the trailing `Tests 76 passed (76)` were a suite result. It is not. Report
a green here as **“lean gate green”**, never as “tests pass”; if a change needs suite-level
evidence, the sweep is `bun run test:full` and the lane map is below. The same runner
**refuses to start** when any of its files is no longer collected by that config — a
gate that had silently narrowed to three files used to exit 0, and one that had lost all
four printed `No test files found, exiting with code 0`.
Docs, copy, fonts, formatting, and generated artifacts may skip it when they cannot affect
runtime; say so in the handoff.

Only add a specialized lane when the diff matches a trigger below. If that specialized lane
already proves the relevant basic wiring, use it instead of `test`; otherwise run the
two commands sequentially on the finished candidate. Rerun affected checks after fixing a
failure or changing the candidate. Once a candidate is green, don't repeat validation without
a new change, failure or unresolved concern. "More confidence" without a concrete risk is not
a reason to add a lane.

## Disposable VPS lab

For fresh Linux installer, VPS onboarding, machine join, tunnels and upgrade tests, use the
versioned Docker rig at [`tools/vps-lab/`](../../tools/vps-lab/README.md). The entry point is
`tools/vps-lab/lab`; no `vpslab` executable or old issue worktree is required. It provides
Ubuntu 24.04 with systemd as PID 1 and SSH, so tests exercise real user services.

Run the lab on a Linux Docker host. For a shared fleet, obtain host access and slot assignments
from the test issue. Container SSH endpoints are localhost ports `2200 + N` on that Docker
host. Read the README, inspect `tools/vps-lab/lab status`, and acquire `lab:vpsN` before
changing an assigned slot. Record its host, container ID and build on the test issue. `lab up`
recreates the fleet, `reset N` recreates one box, and `down`/`nuke` remove shared state.
Resume a preserved stopped box with
`docker start vpsN` only after coordinating ownership.

Follow [release-testing.md](../release-testing.md) for current setup and upgrade cases. The
saved `walk` runner targets the dev channel and older CLI assumptions; it resets vps1–vps5
and is not a default gate. Lab drills require the matching changed behavior or release test
scope, and follow the same one-validation-command-at-a-time budget above. For multiple
Podium instances on one OS rather than a fresh distro, use [multi-instance.md](multi-instance.md).

## MobX click speed gate

- Every capture first runs the focused structural lane (`bun run speed:structural`): named pool readers and app consumers, six clicks and three single-row deltas at 1×/4×, row calls, derivation bodies and collection elements compared individually against the visible-neighbourhood ratio. Known failures name their fixing issues in `work-pool-screens.json`; correctness and new reader failures remain enforced. `bun run speed:gate -- --structural-only` runs this portion without a production build, timing capture or benchmark lease. Promotion reuses the saved capture.
- Exceptions are exact action/kind/reader entries in `tests/worklist/harness/src/screen-work.expected-failures.json`, each with an owning issue. Passing entries are reported as fixed without failing the gate; retire those entries with the fix so the same scan cannot return under an old exception. A new action, counter kind or reader has no allowance. The report also lists the app consumers and addressed neighbourhood for every step.
- Run `bun run speed:gate` on the designated benchmark host once at the end of each MobX step before landing; skip small fixes and test-only changes. The runner acquires the benchmark lease.
- One minified production build, real Chromium, the fixed 4× corpus: sidebar issue, mission switch, session pane, rename, unrelated visible background feed update; six samples each (ten exceeded the initial calibration budget), median and worst input → actual Paint.
- Only an action median more than 10% above `docs/measurements/click-speed-baseline.json` makes the gate red; background timing starts at feed delivery. Measured noise and total runtime are in the JSON report.
- After the green source lands on `integrate/4286-pilot`, `bun run speed:gate -- --promote` promotes its saved numbers; commit the small baseline JSON, without running the browser again.
- Initial baseline only: `--calibrate` measures two fresh Chromium captures' median spread (the first supplies the baseline); `--plant-delay-ms=50` plants real click-path work and must turn the gate red. Keep all five actions if repetitions need cutting to stay under five minutes.

## Only the wrappers reach the compiler and the runners

Every agent harness this repository is driven from refuses a shell command that calls `tsc`,
`tsgo`, `bun check`, `vitest`, `bun test`, `playwright` or `turbo` directly, in any spelling (`bunx`, `npx`,
`bun x`, a path into `node_modules`), and refuses `bun run typecheck` / `bun run test*` from
inside a package directory. The refusal names the lane to use instead. The judgement lives in
`scripts/agent-command-guard.ts` and is wired as a PreToolUse hook in `.claude/settings.json`
(Claude Code and Grok), as execpolicy rules in `.codex/rules/default.rules` (Codex) and as a
bash permission map in `opencode.json` (OpenCode).

The hook is the early message, not the enforcement. `scripts/typecheck-project.ts` — the one
`typecheck` script every package has — refuses to run unless Turbo started it, and every
package `test*` script takes admission itself, so a bypass that slips past a rule file still
cannot skip the slot budget, the install fingerprint, or the forced flags.

Typecheck is `bun check` everywhere (POD-6251): the TypeScript 7 checker built into the Bun pinned
in `mise.toml`, run per project with `--no-script` forced. It keeps no incremental state and writes
nothing, so Turbo's cache of the task result is the only cache; a full project check is as fast as
`tsc`'s no-change incremental rerun was (all 30 projects in ~28 s on a 7-core box, 0.73 GB peak,
against ~225 s and 5.2 GB for a cold `tsc`). The root `typescript` package is pinned to the exact
version Bun checks with, because editors run it; `scripts/typecheck-project.ts` refuses when the two
differ. Packages that need TypeScript's JavaScript API for AST audits still declare TypeScript 6 as
a library; it does not typecheck the repository.

## Caches, the span-effect lint, and runs that die

**The typecheck cache is shared across worktrees.** `scripts/typecheck.ts` keys one Turbo cache
by the repository's common git dir, so a fresh worktree can reuse existing results. The default
base is an absolute `XDG_CACHE_HOME`, then the user's `.cache` directory; temporary storage is
only a fallback when neither is usable. The wrapper also honors `TURBO_CACHE_DIR`. See
`scripts/shared-cache-dir.ts` for the path selection. Re-running to "warm it up" is unnecessary.
Run `bun run typecheck` or `bun run typecheck -- --filter <package>` and let Turbo pick the set.
A checkout installed before the move to TypeScript 7 needs `bun run deps:repair`, not
`setup:worktree`: the frozen reconcile leaves a dangling `.bin/tsserver` behind, and the topology
census refuses the gate on it.

**Use cached validation by default.** For a concrete missing cache input, file the gap and use
`bun run typecheck -- --uncached-because="<missing input>"` as a one-off exception. Generic
`TURBO_FORCE`, `--force` and write-only `--cache` flags bypass that accounting and are refused
without a reason.

**The span-effect lint** (`bun run lint:span-effects`, spec §6 rule 19: nothing a caller outside
this process can observe inside a transaction body) is part of `bun run test`. It runs
there and not only in CI because work lands by local fast-forward, so most changes never meet CI.
A cache hit replays the result; a change to its inputs runs the lint again. When it fires, read
[docs/gates/pod-3332-span-effect-lint.md](../gates/pod-3332-span-effect-lint.md). The failure
text names the span, the path and the two ways out.

**The wrappers limit compiler concurrency and host admission.** `scripts/typecheck.ts` caps
compilers within a run; `scripts/validation-admission.ts` bounds concurrent admitted runs by
slots and a memory budget. Let those wrappers select the limits rather than bypassing them.

**Exit 144 with an empty log has occurred under host memory pressure.** The interrupted run
is no validation result, and that exit code alone does not establish a source error or the
cause of termination. Retry the affected lane; if it recurs, inspect the host and runner
diagnostics before attributing it to the change.

## Exhaustive command and ownership map

### Lean, package, and selection lanes

| Command | Tests live in / selection rule | Also executed by | Run when |
| --- | --- | --- | --- |
| `bun run test` | Cached lock-free workspace typecheck, then `scripts/test-lean.ts`: the exact files above via the `node` project in `vitest.unit.config.ts`, with a footer built from the runner's own tally, a refusal if any of them is no longer collected, and a non-zero exit if the run executed less than all of them | `test:agent` compatibility alias | Default end-of-task gate for ordinary runtime code |
| `bun run test:agent` | Exactly the same command and scope as `test` | Alias only | Compatibility only; prefer the conventional `bun run test` |
| `bun run test:full -- --full-because="<reason>"` | Cached typecheck, then package-owned `*.test.*` / `*.spec.*` under `apps/*`, `packages/*`, `scripts/*`, and `tests/worklist`; one Turbo `test` task per owner; server expands to five shards; exclusions come from `vitest.unit.config.ts`. **A bare `test:full` is refused**: it prints every task the sweep would run and the focused lane that usually answers instead, and runs only once the reason is stated (same shape as `--uncached-because`) | `oracle` as its `unit` component; CI `unit-tests` | Scheduled CI, merge batches, release validation, or explicit request—not ordinary agent work |
| `bun run test:unit -- --full-because="<reason>"` | The exhaustive package sweep without the leading typecheck; same refusal | `test:full` tail | Compatibility/diagnosis only; prefer `test:full` when a full sweep is intentionally required |
| `bun run test:file -- <test files...> [vitest args]` | Exactly the named files. Integration/process files (including server integration and PTY files) use the root integration config before package unit routing; `tests/e2e` uses that config with only the named files. Server/web unit files use `bun --bun`, mobile uses Node, and `*.bun.test.ts` uses `bun test`. Groups run sequentially with admission. Extra arguments (`-t <pattern>`, `--reporter`) go to vitest. A missing file, a Vitest file excluded by its config, or a named Vitest file executing zero tests exits non-zero. Collection is checked before execution to refuse extra files | No parent command | A regression or a new test needs exact evidence from named files — this replaces every hand-rolled vitest command |
| `bun run test:lane -- <lane> [vitest args]` | One named lane from `scripts/test-lanes.ts`: `node`, `normalized-wire`, `server`, `server-contracts`, `server-store`, `server-store-pg`, `server-services`, `server-boundary`, `server-normalized-wire`, `web`, `mobile`, `worklist`, `worklist-native`, `scripts`, `integration`, `acceptance`, `e2e`. `--list` prints them with their admission class; heavy lanes take `test:heavy` and build the clients first. An e2e path filter replaces the default `tests/e2e` directory filter; `-t` alone retains the directory. Named files get the same collection and execution checks as `test:file` | No parent command | A change matches one lane's trigger and you need that lane with a filter or name pattern |
| `bun run test:lane -- worklist [paths or vitest args]` | Worklist fixtures, diagnostics, product regressions and native renderer tests through `tests/worklist/vitest.config.ts`, with happy-dom and the work measurement plugins. `test:file` routes worklist files to this same config; `worklist-native` remains a compatibility name | `test:full` via `@podium/worklist-tests#test`; CI unit sweep | Worklist fixture, reader, join, lifecycle or work-measurement changes; prefer bounded named files while working |
| `bun run test:web` | `apps/web/**/*.{test,spec}.*` through `apps/web/vitest.config.ts` | `test:cached`; full `test:full` | A broad web package change where a few exact tests cannot represent the risk |
| `bun run test:mobile` | `apps/mobile/**/*.{test,spec}.*` through `apps/mobile/vitest.config.ts` | `test:cached`; full `test:full` | A broad mobile package change |
| `bun run test:cached` | The web and mobile package tasks above | No parent command | A deliberately cross-client change; never as generic confidence |
| `bun run test:affected` | Turbo package tasks for changed package sources and dependents; root/process files are uncovered | No parent command | Optional package-wide checkpoint when the selected set is known to be useful; not a mandatory agent gate |
| `bun run test:related -- <files>` | Unit tests reachable in Vitest's import graph from the named files; root `node` and `normalized-wire` projects | No parent command | A regression needs exact unit evidence or the user explicitly asks for focused tests |
| `bun run test:changed` | Same projects, selected from files changed since `HEAD` | No parent command | Optional diagnosis only; do not run automatically after edits |
| `bun run test:watch` | Same projects in non-terminating watch mode, one worker | No parent command | Human-requested test-driven iteration only |
| `bun run test:bun:unit` | Exact file `packages/runtime/test/sqlite.bun.test.ts` using `bun:test` | Full `test`; `test:bun` | Focused runtime SQLite changes |

### Shared Postgres Core processes

Use `apps/server/src/**/*.core-process.bun.test.ts` for behavior that has to survive a Core
crash, work through any Core endpoint, or run once when multiple workers compete for work.
This covers job claims and recovery, sync delivery and reconnects, and daemon operations
and facts. Keep ordinary store and single-process wiring checks in their existing lanes.

```bash
bun run test:file -- apps/server/src/core-cluster.core-process.bun.test.ts
```

`test:file` runs these files as their own serial Bun group with one focused validation
slot (1,000 MB admission charge). Run one cluster at a time and keep the default of two
Core processes on the shared host. Register new Core process test files in the explicit
`test:bun` roster. Each Core boots its own HTTP and WebSocket listener, store connection
pool, sync worker, and background worker. Postgres uses one disposable clone per cluster
from the [Postgres test harness](#postgres-store-lane). SQLite runs one Core over a temporary
database file and can restart that Core against the same file.

On a shared Linux validation VM with the Postgres container already running, the sample
took 14.9 s wall time for both engines (7.4 s SQLite, 6.9 s Postgres). The test process tree
peaked at 850 MiB summed RSS, sampled every 100 ms, within the 1,000 MB admission charge.
The shared Postgres container peaked at 53 MiB above its starting memory during the run.

Import `startCoreTestCluster` from `apps/server/src/test-support/core-test-cluster.ts`.
Set `postgresProcesses` in its options for a different Postgres process count.
Use `client(index)` for authenticated tRPC and `route(index)` for HTTP and WebSocket URLs.
For raw client requests, use the route's `clientHeaders` for authentication. Connect a daemon
using the route's daemon socket URL and the test's protocol credentials.
`kill(index)` sends `SIGKILL` and waits for the child to exit. `start(index)` reopens a killed
slot on the same database. `setWakeUpsDropped(index, true)` suppresses the current local
feed wake-up while leaving the fallback timer active, and toggling it back returns the
number of callbacks dropped. Close the cluster in `finally` so the remaining children are
stopped before their database is dropped.

### Server package shards

The generated `apps/server/test-shards.json` is the authoritative file roster. Each shard is
independently Turbo-cached inside the server aggregate used by `bun run test:full`. The
package scripts (`bun run --cwd apps/server test:store`) still exist for Turbo; from a session
use the `test:lane` form, which is the same command with admission taken from the root.

| Command | Tests live in / config | Also executed by | Run when |
| --- | --- | --- | --- |
| `bun run test:lane -- server-contracts` | Generated contracts roster; `apps/server/vitest.contracts.config.ts` | Server aggregate → full `test:full` | Request/response contracts, schemas, command parsing, validation |
| `bun run test:lane -- server-store` | Generated store roster; `apps/server/vitest.store.config.ts` | Server aggregate → full `test:full` | Database access, migrations, repositories, durable state |
| `bun run test:lane -- server-store-pg` | The store roster less `apps/server/test-store-engines.json`'s two lists, on Postgres; `apps/server/vitest.store-pg.config.ts` | CI job `store-pg` only; not in `test:full` | A store change that must hold on Postgres, or a file you move off the pending list (see [Postgres store lane](#postgres-store-lane)) |
| `bun run test:lane -- server-services` | Generated services roster; `apps/server/vitest.services.config.ts` | Server aggregate → full `test:full` | Server service logic without a real process boundary |
| `bun run test:lane -- server-boundary` | Generated boundary roster; `apps/server/vitest.boundary.config.ts` | Server aggregate → full `test:full` | Routers, auth boundaries, external-facing composition |
| `bun run test:lane -- server-normalized-wire` | Generated normalized-wire roster; `apps/server/vitest.normalized-wire.config.ts` | Server aggregate → full `test:full` | Normalized wire encoding and its bounded benchmark guard |
| `bun run test:lane -- server` | The whole-package config (every file the five shards split between them) | No parent command | Diagnose a suspected shard/configuration discrepancy only |

### Postgres store lane

`bun run test:lane -- server-store-pg [files]` runs the store shard on Postgres
[POD-6980, design `docs/design/POD-6958-postgres-store-design.md` §2.10]. It is a
specialized lane like `server-store`: run it for a store change that must hold on Postgres,
one lane at a time, never stacked, and never as part of `bun run test` (the lean gate starts
no database). Name files to run a few; with no files it runs the whole Postgres leg.

**What it runs.** Every store-shard file except the two lists in
`apps/server/test-store-engines.json`: `sqliteOnly` (the file tests SQLite itself; each entry
gives the reason) and `pending` (meant for both engines, not yet passing on Postgres). Making
a file pass on Postgres means deleting it from `pending`; the list is empty when the Postgres
store is complete (POD-6994). A new store test file runs on both engines by default:
`openTestStore()` opens a whole store on a fresh clone of the run's template, and a file that
tests the executor or driver directly gets the leg's engine from `openEngineHarness()`
(`store/executor/harness.ts`) or `createPgStoreExecutor`. A file outside the store shard that
must also hold on Postgres (a boot-wiring file, a server started on a Postgres URL) is listed
under `beyondStoreShard` with the reason.
`src/store/test-store-engines.test.ts` refuses a list entry that is not a store-shard file,
a SQLite-only entry without a reason, a file in both lists, and a `beyondStoreShard` entry
that is a store-shard file, is missing or has no reason. Every store-shard file is on the leg
unless a list names it, so one that fails on Postgres fails the leg by name. To see which
pending files pass now, run the leg with `PODIUM_TEST_STORE_PG_LEG=pending`.

**Workers and the tmpfs.** The local test server keeps its data on a 2,048 MiB tmpfs. Each
worker holds the clones of its file, about 13 MB each, until they are dropped: a test's own
at the test's end when nothing still uses them, the rest at the file's end. A whole-leg run
peaked at 1,246 MB at four workers (about 300 MB a worker), so the harness budgets 320 MiB
a worker, and a lane on an otherwise idle server runs at most **six workers**
(`PODIUM_TEST_WORKERS=6`). At start the lane compares its workers' budget with the space
actually free (other lanes on the host share the server) and refuses to run when it does
not fit, naming the worker count that would. Running out mid-run instead fails tests with
"No space left on device". The numbers live in `pg-test-host.ts`
(`PG_TEST_TMPFS_MIB`, `PG_TEST_TMPFS_MIB_PER_WORKER`); a larger tmpfs is a new container
settings generation. CI's service container has the same 2 GB tmpfs (`ci.yml`, job
`store-pg`) and runs two workers, a 640 MiB budget, so it fits; the start check reads only
the local container's disk, so it does not run there.

**How it gets Postgres.** The config's globalSetup (`src/test-support/pg-test-host.ts`):

- *Locally:* one container per host, `podium-test-pg` (`postgres:17-bookworm`, glibc
  collation, data on a 2 GB tmpfs, `127.0.0.1:56432`, password `podium-test`, durability
  settings off). The lane starts it when it is missing or stopped and leaves it running, so
  lanes in every worktree share it. Starting it and building templates happen under a host
  lock file, `~/.cache/podium/<host>/test-pg.lock`; a second lane waits there ("waiting for
  … test-pg.lock") and then reuses the container. Free the memory with
  `docker rm -f podium-test-pg` when no lane is running. `PODIUM_TEST_PG_PORT` moves the
  port; a container with other settings is refused, not replaced.
- *CI, or your own server:* `PODIUM_TEST_PG_URL=postgres://…/postgres` skips Docker and the
  lock.
- *Template:* one database per migration-chain digest, `podium_tpl_<digest>`, built once by
  the real Postgres runner (`migrations/pg/index.ts`, POD-6981) and never connected to, so
  every clone starts at the head of the chain with its ledger. A test that needs a database
  without the store schema (it creates its own tables, or migrates the database itself)
  takes `emptyPgTestDatabase()` instead of a clone.
- *Per test:* every database is a `CREATE DATABASE … TEMPLATE … STRATEGY FILE_COPY` clone,
  named `t_<run>_<pool>_<pid>_<n>`. Each worker has one (`pgWorkerDatabase()`), and
  `openTestStore()` clones one per store, so two stores never share rows, as two
  `':memory:'` SQLite stores do not. A clone made in a test or its `beforeEach` is dropped
  when that test ends; one made in `beforeAll` or at module scope when the file ends
  (`pg-test-worker-setup.ts`); the lane's teardown drops what a killed worker left, and the
  next lane drops runs older than 12 hours.

**The engine switch.** The globalSetup sets `PODIUM_TEST_STORE_ENGINE=pg`. `openTestStore()`
then opens its store from the clone's URL (and refuses a file path: that test is SQLite-only),
the pre-migrated SQLite image is not installed, and `expectConstantStatements(pin, n)` pins
`n` on both engines. A count that differs by design is written
`{ sqlite, pg, reason }`; failure messages on Postgres name the engine.

**Writing a test that runs on Postgres** [POD-6979]:

- *A failed statement ends the transaction.* Postgres aborts the whole transaction on any
  statement error (later statements fail with `25P02`), where SQLite carries on, and the
  driver refuses the commit with `PgTransactionAbortedError`. A test or repository that
  expects a statement to fail inside a transaction catches it inside a nested transaction
  (a savepoint) or a batch.
- *Fake timers after the pool connects.* postgres.js opens a connection through
  `setTimeout(connect, 0)` and flushes its socket writes on `setImmediate`. Install fake
  timers only after the store has connected (the harness warms its pool), and leave
  `setImmediate` real (`toFake` without it).
- *Placeholders are `$n`.* Raw SQL in a two-engine test is written once per engine; no
  SQL is translated at runtime.

**Two workers.** Focused lanes default to one worker. The isolation pair
(`src/store/pg-test-isolation-{1,2}.test.ts`, which proves two workers of one run see
different databases) needs two and skips with one:
`PODIUM_TEST_WORKERS=2 bun run test:lane -- server-store-pg`. CI sets it.

**CI.** Job `store-pg` in `.github/workflows/ci.yml` runs the whole leg against a
`postgres:17-bookworm` service container, on pull requests that touch the store,
migrations, sync, the harness or the lane files, and on every merge-group run.
The same job then runs the Bun suites that need a store on Postgres:
`server.postgres.bun.test.ts` (the server started on a Postgres URL), and the sync worker's
`worker.bun.test.ts` and `bootstrap-worker.bun.test.ts` under `PODIUM_TEST_STORE_ENGINE=pg`.
Run those locally the same way:
`PODIUM_TEST_STORE_ENGINE=pg bun run test:file -- apps/server/src/sync-worker/worker.bun.test.ts`.

**Measured cost** (2026-11-16, a shared 7 vCPU development host, load average 80 to 220 during the
runs, harness commit after `bddcd1b1e0`; the leg held only the five harness files):

| What | Measured |
| --- | --- |
| Container memory, idle | 42 MiB (`docker stats`); 47 MB of data on tmpfs (template, `postgres`, `template0/1`) |
| Container memory under the lane (two workers, whole leg) | 60 to 86 MiB cgroup `memory.current`, sampled every 250 ms |
| Each live database | 7.9 MiB of tmpfs (40 clones held at once) |
| Each open connection | 1.7 MiB |
| Clone (`FILE_COPY`) | 15 to 18 ms one at a time; 8 at once in 70 ms |
| Drop (`WITH (FORCE)`) | 9 ms each |
| globalSetup, container running and template built | 70 ms |
| Cold start (container absent) | Docker run plus initdb about 4 s when the Docker daemon answers promptly; one run under load average 220 waited 4 minutes for the daemon to create the container |
| Lane wall time, same two database-free files, three interleaved rounds | `server-store` 7.0 to 7.8 s, `server-store-pg` 6.5 to 8.5 s: no overhead above the noise |

**Store files on Postgres** (2026-11-17, the same host, load average 6 to 9, branch
`issue/6995-two-engine-vertical-slice`): `read-watermarks.test.ts` and `quota-history.test.ts`
(26 tests, 28 stores opened) through the two-engine slice's store
(`test-support/pg-slice-tables.ts`), three interleaved rounds, one lane at a time:

| What | `server-store` | `server-store-pg` |
| --- | --- | --- |
| Lane wall time | 10.5, 15.8, 15.5 s | 13.1, 14.6, 14.5 s |
| Vitest `tests` time (both files) | 0.66 to 0.72 s | 3.6 to 4.2 s |
| `quota-history.test.ts` / `read-watermarks.test.ts` | 0.55 to 0.58 s / 0.11 to 0.14 s | 2.8 to 3.5 s / 0.74 to 0.79 s |

For a few files the lane's wall time is transform and import, and Postgres adds nothing above
the noise. The tests themselves take 5 to 6 times as long: most of it is the store each test
opens (a template clone, the slice's DDL, a pool connecting, a drop at the end, about 100 ms
against about 15 ms on SQLite), not the statements. That is above the design's estimate of 1.5
to 3 times, and it falls where a file opens many stores. Re-measure on a whole-shard run once
the leg holds more files (POD-6981 replaces the slice's DDL with the migrated template).

### Explicit process, browser, rewrite, and performance lanes

| Command | Tests live in / exact selection | Also executed by | Run when |
| --- | --- | --- | --- |
| `bun run test:integration` | Patterns and explicit files in `vitest.integration.config.ts`: `*.integration.*`, `*.pty.test.*`, process/daemon/server boot suites; then `test:acceptance` if Vitest is green | `oracle`; CI oracle matrix | Changed real process, PTY, podium-host, daemon/server boot, updater process, or agent-bridge behavior |
| `bun run test:acceptance` | Exact file `scripts/loop-split-load.integration.test.ts` via `vitest.acceptance.config.ts` | Successful `test:integration` | Loop-split load scheduling or its acceptance threshold |
| `bun run test:acceptance:process` | Exact Bun file `scripts/loop-split-process.acceptance.bun.test.ts` | No parent command | Publication worker, user-systemd recovery, janitor/process recovery |
| `bun run test:e2e` | Non-browser `tests/e2e/**/*.test.{ts,tsx}` selected through `vitest.integration.config.ts` | `oracle`; CI oracle matrix | A changed full-stack server↔daemon↔client flow cannot be covered at one boundary |
| `bun run test:machine-updates` | Exact `scripts/machine-updates.integration.bun.test.ts`; independent Unix-socket supervisors, role processes and native helper | No parent command | Supervisor machine update ownership, authorization, staging, handover and recovery |
| `bun run test:native-machine-updates` | `scripts/native-machine-update.integration.ts`; real Linux Tauri/WebKitGTK, private signed debug ELF versions, HTTPS feed and zero-role parent; builds its own isolated compiled supervisor; requires Rust/Xvfb/OpenSSL | No parent command | Native supervisor command transport, signature refusal, installation, shell death/restart and artifact confirmation; excludes packaged AppImage/FUSE, macOS and Windows |
| `bun run test:multi-instance` | Exact runtime files `scripts/multi-instance-runtime.integration.bun.test.ts` and `scripts/named-dev-release.integration.bun.test.ts`, exact managed-account file `scripts/managed-account-spawn.integration.test.ts`, and `scripts/install-sh.test.sh` | `oracle`; CI oracle matrix | Instance identity, state roots, ports, CLI routing, ownership, lifecycle, installer, named-instance release publishing |
| `bun run test:browser -- --suite <stem>` | Named `tests/e2e/browser/<stem>.browser.e2e.ts` via `tests/e2e/playwright.config.ts` | Full browser command/CI project matrix | Only when the requested behavior requires a real browser interaction; scope to the changed surface |
| `bun run test:browser` | Every `tests/e2e/browser/*.browser.e2e.ts`, across requested Playwright projects | CI browser matrix (non-blocking) | Scheduled browser census or explicit full-browser request; never normal agent validation |
| `bun run test:bun` | `apps/daemon/test/**`, `packages/runtime/test/sqlite.bun.test.ts`, `scripts/lifecycle.integration.bun.test.ts`, `scripts/server-owned-janitor.integration.bun.test.ts` | No parent command | Bun-runner, compiled-daemon, worker isolation, or lifecycle changes — including the server's own janitor thread, which needs Bun's runner because a real `worker_threads` spawn inside a vitest fork crashes it |
| `bun run test:smoke:agents` | Real-agent files selected by `vitest.agent-smoke.config.ts` and `vitest.smoke-requirements.ts` | No parent; deliberately excluded from oracle | Only on explicit human request after changing real CLI adapters; spends credentials/quota |
| `bun run test:rearch` | Runs the `audit:rearch` baseline check, then exact file `scripts/rearch-audit.test.ts` via `scripts/vitest.rearch.config.ts` | No default/package parent | Only rewrite migration/audit implementation or baseline changes; never ordinary product work |
| `bun run test:perf:frontend` | Frontend large-state benchmark in `apps/web/vitest.frontend-perf.config.ts` | CI unit job | Large-state rendering/projection work or scheduled performance monitoring |
| `bun run test:perf:sync` | Sync scaling benchmark in `packages/sync/vitest.perf.config.ts` | No parent command | Explicit sync scaling investigation on a bounded/dedicated host; deliberately quadratic |
| `bun run test:live:s3` | `packages/blob-store/src/s3.live.test.ts` via `packages/blob-store/vitest.live.config.ts`: the blob store contract against a real S3-compatible bucket | No parent; `*.live.test.ts` is excluded from every unit lane | Only with a scratch bucket's `PODIUM_FILE_STORAGE_*` credentials in the environment, after changing the S3 adapter; fails rather than skips without them |
| `bun run perf:typing` | `tests/e2e/typing-latency-bench.ts` against a live environment | No parent command | Typing/terminal latency work only |
| `bun run oracle` | Sequential full `test:full`, `test:integration`, `test:e2e`, `test:multi-instance` from `scripts/oracle.ts` | No parent command | Rewrite phase boundary, release candidate, or explicit request; never a normal merge gate |

Files named `*.bench.test.ts` are excluded from generic package-owned and root node-unit
collection. A dedicated project may explicitly re-add a bounded guard such as the server's
normalized-wire benchmark. A benchmark that intentionally amplifies a known cost curve is not
merge-gate evidence merely because Vitest can collect it; give it an explicit performance lane
with the host budget appropriate to its measured peak.
The agent-smoke reporter prints ran-versus-skipped totals for each CLI. A CLI's
viability case starts a real turn and resumes it with retained context; an
installed but unauthenticated or broken binary runs and fails rather than being
reported as absent. The lane also fails when all five viability cases skip, or
when any CLI loses its registered case. Runner operators must explicitly choose
which authenticated binaries to install; absence remains a visible per-CLI skip.

Keep model-output quality evaluations out of this release viability lane. The
former Claude brevity evaluation intermittently produced four sentences against
a three-sentence prose contract despite successful start, turn, and resume; that
is stochastic instruction compliance, not evidence that the CLI transport works.
The lexical response-contract behavior remains protected by deterministic tests.


## The `@podium/server` lane is generated — regenerate it when you add a test

`@podium/server`'s `test` task is an aggregate over five independently cached shards
(`contracts`, `store`, `services`, `boundary`, `normalized-wire`) [POD-520]. Shard
membership AND the per-file Turbo input globs are **derived from the real import
closure**, so `apps/server/test-shards.json` and `apps/server/turbo.json` are generated
files: never hand-edit them, and never coarsen the globs to directories (that costs most
of the cache benefit). After adding, moving, or deleting any `apps/server` test file:

    bun scripts/server-test-shards.ts --write

`scripts/server-test-shards.test.ts` recomputes both files on every default run and fails
on any difference — including the inverse check that no `apps/server` file can change
without some shard's key noticing. It fails as a plain array diff, so a red naming server
test paths means the `--write` above, not a broken test.

Iterating on one shard: `bun run --cwd apps/server test:contracts` (likewise `test:store`,
`test:services`, `test:boundary`, `test:normalized-wire`; `test:unsharded` runs the old
whole-package shape).

Two mechanisms underneath that lane change how a server test behaves:

- **Store tests clone a pre-migrated database** [POD-523]. A globalSetup builds one schema
  image keyed by the migration manifest and every store test clones it, so a changed
  migration is a lane-level input that invalidates all five shards, not just `store`.
- **The `contracts` shard reuses one Vitest runner** [POD-527]: `isolate: false` for the
  files a static scan clears, the rest still forked, and an after-file leak guard that
  fails the offending file by name with the global/env key that moved. A contracts failure
  naming a moved key is that guard, not a flake. Do **not** stress reuse with a whole-shard
  `--sequence.shuffle.files`: it replaces Vitest's project-first sequencer, breaks the reuse
  chain, and exercises reuse *less* than the default order. Shuffle the reused project alone
  (`--project server:contracts:reused --sequence.shuffle.files`).

Measurements and rationale: [POD-520 cache shards](pod-520-server-test-cache-shards.md),
[POD-523 pre-migrated store fixture](pod-523-pre-migrated-store-fixture.md),
[POD-527 runner reuse](pod-527-runner-reuse.md).

## Shared-host resource guard

The shared forked Vitest configuration defaults to at most two workers and keeps one worker available as the floor. This is the safe default for a shared development host, so a test run leaves headroom for the live Podium instance and other agent sessions. Set `PODIUM_TEST_WORKERS=<positive integer>` to choose another ceiling, or `PODIUM_TEST_WORKERS=auto` to restore Vitest's CPU-count default on a dedicated CI/test host. `fileParallelism` remains enabled.

Three admission classes, and the shape of each follows what it is protecting:

- Typecheck, related/changed probes, focused web/mobile/package tests, and direct package
  tests take one of a fixed number of **validation slots**, and are charged against a
  **memory budget**. They must never wait behind a heavyweight suite, so this is a counting
  semaphore rather than a lock: the point is to cap parallelism, not to serialize. The slot
  count is the smaller of half the host's cores and the budget divided by the cheapest run
  (floored, minimum one); `PODIUM_VALIDATION_SLOTS` sets it outright as a positive integer, or
  `off` on a dedicated host with nothing else to protect. The budget defaults to half the
  memory ceiling the process lives under — the tightest cgroup `memory.max` on its ancestry
  (a Podium session on a systemd host is inside `podium-sessions.slice`), else physical RAM —
  and `PODIUM_VALIDATION_BUDGET_MB` sets it outright. Each admitted run is charged its class's
  cost (a typecheck is one 1GB checker, a focused lane 1GB; see `VALIDATION_COST_MB`), and a
  run whose cost would push the live holders over the budget waits even when a slot file is
  free. So on an 8-core box with a 4GB slice the pool has four slots but admits two
  runs, not four. A run that finds no room **queues** and prints one line to
  stderr; it is never refused. The slots are files under
  `~/.cache/podium/<hostname>/validation-slots` (override with
  `PODIUM_VALIDATION_SLOT_DIR` for deliberate isolation), independent of task `TMPDIR`. The
  budget is per user and host — every worktree under `.claude/worktrees/*` competes for the same cores
  and therefore for the same slots. A slot whose holder process is gone, or whose lease
  expired, is reclaimed by the next run that wants it.
- Full package, integration, acceptance, E2E, browser, performance, agent-smoke,
  multi-instance, and full Bun lanes hold `test:heavy`.
- Watch holds only the singleton `validation:watch` lease and forces
  `PODIUM_TEST_WORKERS=1`; a second watcher is refused.

A slot is one worker: the pool sets `PODIUM_TEST_WORKERS=1` for a focused run whose caller did
not choose a limit, so a lane forks what it was charged for. A caller that sets the variable
(including `auto`) keeps its own value. A typecheck is not a vitest run and is left alone.

Batch, do not fan out: every vitest invocation against `apps/server` pays a fixed cost before
any test runs — transforming and importing the server graph — and holds its slot for the whole
run. Three `test:file` calls for three files pay that three times; one call naming all three
pays it once.

Both leases renew while their child runs, terminate the child if renewal fails, and release
only leases the invocation opened. `PODIUM_VALIDATION_RESOURCE_HELD` lets a child of a heavy
or watch wrapper reuse that one parent lease without reacquiring it. An intentionally
manual outer `test:heavy` remains caller-owned.

A hand-rolled Vitest or Playwright invocation that bypasses package scripts still skips the
heavy lease and can race other heavy work — and it shares the fixed default port 8799 with any other
Playwright run on the host (lease does not cover that). Prefer the package script when
you can. One-suite verification belongs on the lane (POD-536) so build, selection,
and exit status stay correct:

    bun run test:browser -- --suite <stem> --project=chromium-pixel

If you must bypass the lane, build first so webServer does not start against empty
dist (POD-535):

    bun scripts/browser-lane.ts --build-only
    bunx playwright test --config tests/e2e/playwright.config.ts --project=chromium-pixel <suite>

Use the equals form of `--project` (space form swallows the next arg). If dist is
missing, webServer fails fast with that build-only command rather than a deep
module-not-found.

The wrapper renews each 30-minute lease every 10 minutes while the child runs. If renewal
fails, it terminates the child rather than allowing an unbudgeted test to continue; an
interrupted process still has the 30-minute TTL as the recovery path.

Automatic heavy/watch lease acquisition is identity-gated on `PODIUM_SESSION_ID`, because the
advisory lock names its holder by session and cannot record one otherwise. CI and
other non-session runs retain the safe worker default but do not serialize against live sessions;
a dedicated host can opt out explicitly with `PODIUM_TEST_WORKERS=auto bun run test:full`.

**Validation slots are NOT identity-gated.** A slot's holder is a process on this machine, so it
needs no session to name it — and a run started from a bare shell burns exactly the same cores.
Every focused/typecheck run on the host is counted, session or no session.

A human running validation in a terminal without `PODIUM_SESSION_ID` therefore still queues for a
slot, but takes no automatic heavy budget lease and can still collide with an agent's heavy run.
On the shared host, run heavyweight validation from a Podium session or coordinate a manual
`test:heavy` hold.

### One lane at a time, inside your own session

Ordering is still yours to enforce. Run only the end-of-task gate selected above and, when a
concrete risk requires it, its one specialized lane—**one after another, each to completion**.
Do not background a lane and start the next (`&`, a second terminal, parallel tool calls), and
do not overlap typecheck with a test run.

Overlapping does not finish sooner on a host shared with a live Podium instance and every
other agent session; it multiplies the peak. The worker ceiling and the `test:heavy` lease
were both sized on the assumption that one session contributes one heavy run at a time, and
a CPU-starved run fails in timeout shapes that read like real regressions — costing a second
full run to disprove.

Never run two heavy things concurrently to save time. If a second heavy run genuinely has to
happen, submit it from another session and let `test:heavy` serialize it — it waits for the
lease and starts when the host is free, which is the outcome you wanted anyway.

## Selection caveats

`test:changed` and `test:related` are optional diagnostic tools, not required workflow steps.
They see only Vitest's import graph in the root `node` and `normalized-wire` projects; they do
not cover web/mobile package configs, process lanes, browser tests, or `bun:test`. They also
cannot discover a filesystem read. For example, changing `docs/TELEMETRY.md` does not select
`packages/telemetry/src/docs-drift.test.ts`; explicitly name that reader if its contract is the
thing being changed.

`test:affected` uses package ownership. It refuses uncovered runtime files rather than pretending
they are green, but that refusal is guidance to choose the relevant explicit lane—not an
instruction to run the full sweep. Inert prose such as ordinary Markdown, `LICENSE`, and `NOTICE`
is ignored. Its base is the closest merge base among the upstream, `origin/main`, and
`origin/project/*`; override with `--base=<ref>` when necessary.

Delivery changes must run driver conformance explicitly [POD-4387]. Focused lanes select only
the tests for files they changed, so `terminal-driver.conformance.test.ts` is in nobody's
changed set when delivery moves underneath it — which is how a `queued`-where-`accepted`-
belongs drift passed every per-lane gate. Touching any of `apps/daemon/src/runtime/terminal-driver.ts`,
`packages/agent-runtime/src/delivery-queue.ts`, `packages/agent-runtime/src/drivers/terminal/injection.ts`,
or `packages/agent-runtime/src/turns.ts` additionally requires:

    bun run test:file -- apps/daemon/src/runtime/terminal-driver.conformance.test.ts

`test:related`/`test:changed` do not satisfy this: they are optional diagnostics over the import
graph, not the contract gate. The corpus is the evidence legacy paths are safe to remove.

Always invoke Vitest through repository scripts. A hand-rolled invocation bypasses admission,
hermetic setup, lane exclusions, and exit-status safeguards.

## Invariants

- **No lane may pass empty** [POD-2728]: every explicit file list in this repository has
  to fail when it collects nothing, because a list that disagrees with the filesystem is
  a manifest bug, not a green. `scripts/test-configuration.test.ts` pins
  `passWithNoTests === false` on all five server shards and pins the lean gate's
  refusal-and-footer behaviour in `scripts/test-lean.ts`. The lean gate was the one
  exception until POD-2728; do not reintroduce `--passWithNoTests` there.
- **A gate reports what ran, not what it asked for** [POD-2728]: "empty" includes a run
  that collected every file and then executed nothing, which is what a `-t` filter that
  matches nothing produces — Vitest marks each such file `passed` and exits 0. Count
  executed assertions from the runner's own report; never let a scope list stand in for
  a result. The first fix for this issue got this wrong and printed a confident green
  over a run of zero tests.
- **Lane membership is guarded**: `scripts/test-configuration.test.ts` asserts the
  package-owned scopes, normalized-wire serialization, hermetic setup, worker caps,
  heavy-lane split, and package.json script shape. Every new package test needs a real
  config and matching Turbo task/input audit. If you add a test that spawns processes/PTYs/servers, name it so a lane pattern catches it
  (`*.integration.test.ts`, `*.pty.test.ts`, `*.smoke.test.ts`) or add it to the
  explicit lists in `vitest.integration.config.ts` (and its mirror exclusion in
  `vitest.unit.config.ts`).
- **Tmp hygiene**: never a bare `mkdtemp` without cleanup in tests. Per-run TMPDIR
- **Root exclusions remain load-bearing**: `vitest.unit.config.ts` still excludes
  integration/e2e/PTY/agent-smoke and named heavy suites, while normalized-wire remains
  a separate serialized project; package configs reuse that exclusion list.
  containment exists (`test-hermetic-env.ts`) but it is a backstop, not a license —
  pair every `mkdtempSync` with `rmSync(..., { recursive: true, force: true })` in
  an afterAll/finally.
- **Tests never inherit the hosting instance**: `test-hermetic-env.ts` scrubs the
  session relay vars AND the instance-identity vars (`PODIUM_INSTANCE`, port/agent-home
  overrides), so a suite launched from inside a live (possibly named) instance runs as a
  hermetic throwaway. For a live-like isolated deployment, use a named instance
  ([docs/agents/multi-instance.md](multi-instance.md)) instead of hand-rolled
  `PODIUM_PORT`/`PODIUM_STATE_DIR` overrides.
- **CI runs the oracle: unit + typecheck + integration + e2e + multi-instance**
  [POD-295]. CI installs with `--ignore-scripts`; real PTYs use Bun.Terminal and
  Podium builds its vendored podium-host with cargo, and the abduco attach client (kept only to
  adopt older sessions) with cc, on first use. Agent-smoke is NEVER in CI
  (it bills real LLM quota) and
  runs only on explicit request.
- **The oracle is the rewrite's behavioral contract** [POD-295]: `bun run oracle`
  runs all five lanes locally in one command (sequentially — the heavy lanes bind
  fixed ports). The lane set lives in `scripts/oracle.ts`; a drift guard in
  `scripts/test-configuration.test.ts` pins it against the CI matrix and the
  package.json scripts, so a lane cannot fall out of CI silently. It is reserved for
  rewrite phase boundaries, release validation or explicit requests. Taking a merge lock
  does not require the oracle; choose the default or focused checks by the triggers above.
