# Running tests — which lane, when

Doctrine for agents working in this repo [spec:SP-0be7]. The normal path is one
cacheable package-owned default; the remaining lanes stay explicit because they start
real processes, browsers, PTYs, or agent CLIs that cannot be safely hidden in a unit cache.

## Default and explicit lanes

| Lane | Command | What's in it | Cost / guard |
| --- | --- | --- | --- |
| **Default package tests** | `bun run test` (`test:unit` is a compatibility alias) | 28 Turbo tasks covering every default file: one task per package with tests (scripts, desktop, web/mobile, the runtime Bun unit) plus `@podium/server`'s aggregate and its five cache shards | Cached; tasks serial, Vitest capped at 2 workers |
| **Focused package probes** | `bun run test:web`, `bun run test:mobile`, `bun run test:cached` | One or both app package tasks | Cached; one shared host permit |
| **Affected package tests** | `bun run test:affected` | Package tasks for changed packages and dependents | Refuses files no package task can cover |
| **Inner loop** | `bun run test:changed`, `test:related`, `test:watch` | Root `node` and `normalized-wire` projects selected by Vitest | One-shot runs use one permit; watch uses one worker and one singleton permit |
| **Integration** | `bun run test:integration` | `vitest.integration.config.ts` plus acceptance: process/PTY/abduco/daemon suites, real-port boots, and loop-split load | Minutes; shared test lease |
| **E2E** | `bun run test:e2e` | Full-stack server + daemon Vitest files under `tests/e2e/**` with `@podium/source` | Minutes; heavy; no browser |
| **Browser** | `bun run test:browser` | Playwright browser suites under `tests/e2e/browser/**.browser.e2e.ts` | Tens of minutes; heavy; see browser census. Scope one suite with `-- --suite <name>` (do not hand-roll `playwright test`) |
| **Agent smoke** | `bun run test:smoke:agents` | Five real agent CLIs, gated by `PODIUM_REAL_CLI=1` | Real money; explicit human request only |
| **Multi-instance** | `bun run test:multi-instance` | Separate concurrent runtimes plus installer coverage | Minutes; heavy; see [multi-instance.md](../multi-instance.md) |
| **Full Bun lane** | `bun run test:bun` | All `*.bun.test.ts` suites, including compiled-daemon/lifecycle integration | Heavy; `bun test`, never Vitest |

The default package task is the command to run before a commit. It keeps every default
test attributable to an owner and lets Turbo repeat only tasks whose inputs changed.
The root process lanes remain explicit so a green unit cache cannot imply a green server,
browser, multi-instance, or real-agent run.
`test:bun:unit` remains a compatibility probe for the runtime file; normal agents should use
`bun run test` so that file is not run twice.
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

Validation uses a two-permit host budget from a live Podium session:

- Heavy lanes reserve both permits and retain the `test:heavy` advisory lease for
  compatibility with older/manual callers. This includes the default package gate,
  affected, integration, acceptance, E2E, browser, agent smoke, multi-instance, and the
  full Bun lane.
- Focused one-shot tests reserve one permit, so two small probes can coexist when no heavy
  lane or typecheck is admitted. Root changed/related and focused web/mobile/cached entry
  points use this tier, as do direct package test scripts.
- Typecheck reserves both permits because Turbo can run many `tsgo` children. Root and
  direct package typecheck scripts use this tier, so it does not overlap focused tests.
- Watch reserves one permit, forces `PODIUM_TEST_WORKERS=1`, and holds a singleton
  `validation:watch` lease. A second watcher is refused; one focused probe can still use
  the remaining permit.

A short `validation:admission` gate prevents a new focused probe from slipping ahead while
a heavy lane or typecheck is draining the permits. Lock notes name the command, so
`podium lock status` shows which validation is admitted and the admission-gate holder names
the work waiting for capacity. The gate and every partially acquired permit renew while
admission is blocked; timeout, interruption, and errors cancel the active waiter and release
partial acquisition in reverse order. Runtime leases renew while the child runs, and every
path releases only locks that invocation opened.

A lease belongs to the session, which outlives the command that took it, so each wrapper
stamps its own pid into the lock note (`… [pid 1234]`). Before it queues for the gate, a run
settles what its session already holds: leases whose stamped process is gone are released and
reclaimed — the automatic exit from a wrapper killed outright, or from an orphaned
`lock acquire --wait` child granted after its parent died — and a lease whose process is still
running is refused over *without* acquiring, because acquiring is also how you renew, and a
refusal that renews starves everyone queued behind it for the full TTL [POD-675]. Unstamped
notes are somebody else's (an outer manual hold) and are never reclaimed. No manual
`podium lock release` is needed to recover: re-running the validation command *is* the
recovery — an inversion worth knowing, because before this the retry was what made it worse.
A refusal that re-acquired first had already renewed the lease it was refusing over, so a
retry loop held a dead lease open indefinitely and the sessions queued behind it never
advanced. Do not diagnose a strand from a stale expiry: a renew-on-refuse lease looks freshly
taken while being dead. Whether the shared permits are held is the honest signal, and the
owner pid in the note is the direct one.

The two halves of this protocol ship from different places, which is worth knowing before it
surprises you: the lease client is `podium`, which runs from the host checkout, so a change
there reaches every session the moment it lands on main. The wrapper above it runs from
whichever worktree invoked it, so a worktree keeps its old admission behaviour until it
rebases. A rebase changing how your leases behave is that, not a bug.

That split is also how you read a stuck gate. `podium lock status` prints the note, so a
stamped holder (`… [pid 1234]`) is a worktree carrying the reclaim, and a stale one will be
cleaned up by whoever validates next. An UNSTAMPED holder is a worktree that has not rebased:
nothing will reclaim it — deliberately, since that is also what an outer manual hold looks
like — so if it died holding the gate, the TTL really is the only exit and waiting is the
answer. A 30-minute stall you can name beats one you cannot.

Root wrappers export `PODIUM_VALIDATION_RESOURCE_HELD`; Turbo passes it to package children
through `globalPassThroughEnv`, so direct package scripts self-guard without nested
acquisition or changing cache keys. An outer manually-held `test:heavy` remains caller-owned.

`acquire` refuses when a **sibling** — another session on your issue, or any session sharing
your worktree — already holds or is queued for that lock [POD-556]. That is the shared-root
checkout's normal case, and the refusal names the session so you can coordinate; pass
`--allow-sibling` only when serialized multi-session access is genuinely what you want.
Re-acquiring your own held lock renews it rather than queueing.

A hand-rolled Vitest, Playwright, or `tsgo` invocation that bypasses package scripts still skips
admission and will race other heavy work — a direct `bunx tsgo --noEmit` in a package takes no
lease, which is why it stays available when the lease machinery itself is broken, and equally
why it is not a way around a busy host: nothing is accounting for the compilers you start. A
hand-rolled Playwright run also shares the fixed default port 8799 with any other Playwright
run on the host (the lease does not cover that). Prefer the package script when you can.
One-suite verification belongs on the lane (POD-536) so build, selection, and exit status
stay correct:

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

Automatic lease acquisition is identity-gated on `PODIUM_SESSION_ID`. CI and other non-session runs retain the safe two-worker default but do not serialize against live sessions; a dedicated host can opt out explicitly with `PODIUM_TEST_WORKERS=auto bun run test`.

A human running validation in a terminal without `PODIUM_SESSION_ID` takes no automatic
budget lease and can still collide with an agent run. On the shared host, run validation
from a Podium session or coordinate a manual `test:heavy` hold for a heavy command.

### One lane at a time, inside your own session

Admission bounds work **across** sessions. It does not authorize overlapping validation
inside one session: the explicit marker exists for parent/child re-entry, and a same-session
acquire without that marker is refused when the wrapper can identify it. Hand-rolled
commands can still bypass the contract entirely.

So the ordering is still yours to enforce. Run the focused lane, then `bun run typecheck`, then the final `bun run test`
gate — **one after another, each to completion**. Do not background a lane and start the next
(`&`, a second terminal, parallel tool calls) and do not overlap a typecheck with a test run.

Overlapping does not finish sooner on a host shared with a live Podium instance and every
other agent session; it multiplies the peak. The worker ceiling and the `test:heavy` lease
were both sized on the assumption that one session contributes one heavy run at a time, and
a CPU-starved run fails in timeout shapes that read like real regressions — costing a second
full run to disprove.

Never run two heavy things concurrently to save time. If a second heavy run genuinely has to
happen, submit it from another session and let `test:heavy` serialize it — it waits for the
lease and starts when the host is free, which is the outcome you wanted anyway.

## Simple UI and bug changes

A small, local UI or bug fix does not earn a full sweep at every step. The path is:

1. **The smallest focused lane that covers the change.** `bun run test:related -- <file>`
   for a unit-level fix, or `bun run test:web` / `bun run test:mobile` when the change sits
   inside one app package. Extending an existing test beats standing up a parallel suite.
2. **Runtime verification in the running app — mandatory, not a nice-to-have.** A green
   focused lane is not evidence that a UI change works. Drive the surface
   ([driving-podium.md](driving-podium.md)) or run the app and look at the change. A
   `*.browser.e2e.ts` suite counts only if you re-ran it for *this* change; citing an
   earlier run does not.
3. **One full `bun run test` gate at the final substantive integration point** — the commit
   that actually lands the behavior. That is where the standing requirement to run the
   default lane before a substantive commit bites, and it is not skippable: the focused
   lanes in step 1 cannot see the other package tasks your edit may have moved.

This narrows what you run **on the way**, not what has to be green before the change lands.
Nothing here removes the heavier lanes the decision table calls for — a one-line fix in
daemon, PTY, or instance-identity code still owes `test:integration` or
`test:multi-instance`, and a docs-only or otherwise test-independent edit still skips
automated tests entirely with the reason stated in the handoff.

## Decision table

| Situation | Run |
| --- | --- |
| Iterating on changed source | `bun run test:changed` — Vitest's module graph selects tests reachable from the files changed since `HEAD` |
| Iterating on an explicit file list | `bun run test:related -- path/to/file.ts` — add more paths after `--` as needed |
| Repeating edits interactively | `bun run test:watch` — plain watch mode keeps the Vitest process warm |
| Simple, local UI or bug fix | The smallest focused lane (`test:related -- <file>`, or `test:web` / `test:mobile`) **plus** runtime verification in the running app, then one full `bun run test` at the final substantive integration point — see [Simple UI and bug changes](#simple-ui-and-bug-changes) |
| Before every commit | `bun run test` (fast default) — after the focused lane and typecheck have finished, never alongside them ([one lane at a time](#one-lane-at-a-time-inside-your-own-session)) |
| Touched agent-bridge / daemon / server process, PTY, or abduco code | Also `bun run test:integration` |
| Full-stack flows, before landing UI/server interaction work | `bun run test:e2e` |
| Touched instance identity, state roots, port derivation, CLI routing, agent ownership, or lifecycle | Also `bun run test:multi-instance` |
| Changed a web UI surface a `*.browser.e2e.ts` suite covers | Also `bun run test:browser` (scope it: `bun run test:browser -- --suite <stem>` or `-- --suite <stem> --project=chromium-pixel`) — and do not cite a suite as runtime verification without re-running it. Prefer the lane over a hand-rolled `playwright test` invocation: positional filters cannot narrow the full-lane argv, `--project` is variadic (use the `=` form), and piping through `tail`/`grep` masks Playwright's exit status |
| Real agent CLI behavior | `bun run test:smoke:agents` — ONLY on explicit human request |

Always invoke Vitest through the repo's direct Bun entry point (`bun --bun node_modules/vitest/vitest.mjs run ...`), never plain `vitest` and
never `bun test` for vitest files.

The three inner-loop scripts are deliberately a fast approximation, not a replacement
for the full suite. They run only the root unit projects (`node` and
`normalized-wire`); they do not cover the web/mobile, integration, acceptance, or
`bun:test` lanes. Vitest rebuilds its module graph for each invocation, so these scripts
do not provide CI caching. Module-graph selection also cannot discover tests that read a
changed file directly from disk rather than importing it. For example,
`packages/telemetry/src/docs-drift.test.ts` reads `docs/TELEMETRY.md` with
`readFileSync`, so changing only that doc can make `test:changed` pass with no selected
tests. This is a documented limit, not a detected dependency; target the reader with
`bun run test:related -- packages/telemetry/src/docs-drift.test.ts` when needed. Run
`bun run test` before a commit.

## Invariants

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
  ([docs/multi-instance.md](../multi-instance.md)) instead of hand-rolled
  `PODIUM_PORT`/`PODIUM_STATE_DIR` overrides.
- **CI runs the oracle: unit + typecheck + integration + e2e + multi-instance**
  [POD-295]. The light jobs (lint/typecheck/migrations/unit) install with
  `--ignore-scripts`, so node-pty's native addon never exists there; the `oracle`
  matrix job is the exception — it installs fully and adds abduco, because its
  lanes spawn real PTYs. Agent-smoke is NEVER in CI (it bills real LLM quota) and
  runs only on explicit request.
- **The oracle is the rewrite's behavioral contract** [POD-295]: `bun run oracle`
  runs all five lanes locally in one command (sequentially — the heavy lanes bind
  fixed ports). The lane set lives in `scripts/oracle.ts`; a drift guard in
  `scripts/test-configuration.test.ts` pins it against the CI matrix and the
  package.json scripts, so a lane cannot fall out of CI silently. Land-flow
  convention: acquiring the merge lock for main wants a green oracle on the
  candidate sha (see docs/rearchitecture-v3.md) — advisory, with CI as backstop.
