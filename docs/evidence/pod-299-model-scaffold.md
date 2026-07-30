# POD-299 — packages/model at L0, absorbing @podium/domain: verification evidence

Branch `issue/299-1-1-scaffold-packages-model-at-l0-absorb`, base `issue/279-integration`
at branch-point `0e583f44`. Commits `3d526e15`, `76d69be1`. 88 files changed,
914 insertions, 405 deletions.

## Acceptance criteria, each answered

| Criterion | Status | Evidence |
|---|---|---|
| packages/model builds standalone with zero workspace deps | **MET** | `bun run build` in the package: ESM 14.35 KB + `dist/index.d.ts` 31.58 KB, exit 0. `dependencies: {"zod":"^3.24.0"}` only. `grep` for `@podium/` in `dist/index.js` = **0**; the 5 hits in `index.d.ts` are doc-comment prose, not imports. |
| domain tests moved and green | **MET** | All 9 model test files, 68 tests, pass: `vitest run --config vitest.unit.config.ts --project node packages/model/`. |
| @podium/domain deleted; no references remain | **MET** | `git mv` (history preserved); package dir gone. NUL-safe workspace sweep finds zero `@podium/domain` outside dated ADR evidence and two deliberate provenance lines in the new package's own READMEs. |
| boundary rule 7 (domain single-home) re-pointed at model | **MET** | `DOMAIN_HOME`→`MODEL_HOME` = `packages/model`; rule id `domain-single-home`→`model-single-home`; rule 3 leaf list re-pointed. **Also fixed a latent gate failure — see below.** |
| issue-color.ts + handoff-target additions to machine-selection.ts included | **MET** | `entities/issue-color.ts`; `predicates/machine-selection.ts` carries `handoffSource`, `handoffAvailability`, `handoffTargets`, `HandoffSession`, `HandoffIssue`, `HandoffRepo`, `HandoffWorktree`, `HandoffMachine`, `HandoffBlocker`, `HandoffRejection`, `HandoffCandidate`, `agentCapabilityRejection`. |
| ISO-vs-epoch twin predicate families collapsed, adapters at the edges | **MET** | `clock.ts`: `Instant` + `toInstant`/`requireInstant`/`toIso`. `isIssueSnoozed` deleted; `isIssueDeferred` is the single name. Server edge adapter: `IssueServiceCore.nowInstant()`. 20 new assertions in `clock.test.ts` + `predicates/issue-stage.test.ts`. |
| authz scope kinds a closed set with compiler-enforced totality; authorize() single; actorSessionId preserved | **MET** | Exhaustive `switch` + `default: assertUnreachable(scope)`; `Record<IssueScope['kind'], …>` in the test as a second checked site; `actorSessionId` byte-identical and asserted. |
| Layout reserves named homes for POD-1075 identity and POD-1076 per-user state | **MET** | `packages/model/README.md` layout table + a README in each reserved dir (`ids/`, `annotations/`, `user-state/`). |
| tsgo --noEmit typecheck script, @podium/source export, turbo task, L0 in layer lint | **MET** | `"typecheck": "tsgo --noEmit"`; `exports["."]["@podium/source"]`; `@podium/model#typecheck` in `turbo.json` (observed executing as its own turbo task); `MANIFEST['packages/model'] = { layer: 0, … }`. |
| Oracle green | **NOT MET, and not achievable at this branch point** | Three independent base-staleness reds, all already fixed on `issue/279-integration` after `0e583f44`. See below. |

## What the change verifiably does NOT break

Method: run each gate on this branch and on a clean checkout of the branch-point SHA
`0e583f44`, then diff. `git stash` is repo-wide and forbidden, so the base was a
separate `git worktree`.

- **check-boundaries** — output **byte-identical** to base except the two lines naming
  the moved file's new path (`packages/domain/src/machine-selection.ts` →
  `packages/model/src/predicates/machine-selection.ts`). Both exit 1. Base was already
  red (POD-1105 owns it). My re-pathed allowlist entry lands in the *allowlisted warn*
  block, so it matches — no stale-entry failure.
- **rearch-audit** — the only counter that moved is `reexport-shims` **24 → 23**, from
  deleting `packages/runtime/src/git.ts`. That is an improvement. **I did not
  rebaseline**: the ratchet may only go down, and the baseline was reconciled on
  integration after my branch point.
- **unit lane, isolated** — my 3 failures are a strict **subset** of base's 5.
- **web lane** — my 12 failures / 8 files vs base's 26 / 17. All 12 of mine are
  `Test timed out in 5000ms`, never an assertion failure. Isolated re-run of the two
  suspect `SidebarUnified` files (a file this change edits): mine 2 failures ⊂ base 5.
- **integration lane** — both red, all failures in PTY / process-tree / memory-snapshot
  tests untouched by this change.

Per the coordinator's broadcast, the machine was swap-thrashing (16GB of swap in use,
run queue >200) and these lanes were unreliable under load. The failures above are load
artifacts, which the base-vs-mine subset relation confirms.

## Why the oracle cannot be green here

Each of these is red on the branch-point SHA and fixed on integration *after* it:

1. **`check-no-nul-bytes` red** — `packages/client-core/src/engine/engine.ts` carries two
   literal NUL bytes. Fixed on integration by `3d31eee7`, which is **not** an ancestor of
   my HEAD.
2. **`architecture-manifest` untagged** — `apps/janitor`, `packages/composer`. Identical
   failure on base.
3. **deletion-audit baseline stale** — reconciled by POD-861 after my branch point.

Per the fan-out protocol I did not rebase onto integration.

## Full lane: queued, not run

I attempted the `test-lane` lease twice (300s each); it was held by issue #370 and then
#727 with ~20 minutes remaining, and #727 sat ahead of me in the queue. Following the
coordinator's explicit instruction — "I would rather have honest targeted-lane evidence
plus a note that the full lane was queued" — this report cites:

- `bun run --filter @podium/model typecheck` → exit 0 (**scoped, not turbo-cached**)
- targeted unit lane, 12 files / **121 tests pass**: all of `packages/model/`,
  `scripts/check-boundaries.test.ts`, `apps/web/test/workspace-resolution.structure.test.ts`,
  `apps/server/src/modules/issues/commands-field-drift.test.ts`,
  `packages/protocol/src/commands.test.ts`
- targeted web lane, 3 files / **135 tests pass**: `derive.test` (session snooze),
  `derive-unified.test` (issue defer, the renamed predicate), `workspace-resolution`
- `bun run test:bun:unit` → **14 pass, 0 fail**

An earlier **uncached** full `bun run typecheck` (before the lease rule existed) was
**green across all 20 packages**; the compiler is what drove every import-site update.

## Response to the standing rule on path-scoped detectors (coordinator broadcast)

**(a) Detectors scoped by path prefix.** Read `scripts/rearch-audit.ts` in full. Its scoping is
`opts.roots` prefix matching, and the only *hard-coded* prefix guard is
`f.file.startsWith('packages/agent-bridge/src/')` (line 528, `durable-host-sync-async-twins` —
POD-396's case). **No detector is scoped to `packages/domain`**; the string `domain` appears once
in the whole file, in an unrelated comment. So this move could not silently zero a detector.

**(b) Verified per-site, not by total.** Full per-site diff of the audit output, base vs mine, is
exactly two things:

1. Three `publishComputed` sites in `service/core.ts` shifted line number (+14, from the added
   `nowInstant()` method). **Same three sites, same count** — a line-number move, not a
   population change.
2. `reexport-shims` 24 → 23, and the per-site listing names the single site that disappeared:
   `packages/runtime/src/git.ts:1  1 re-exports, no other code`. That is the shim this issue
   deleted. **One count down, one named site, explained.**

Nothing else in any detector's per-site output changed.

**(c) Detector spanning both homes.** Not applicable — no detector's subject moved.

**(d) Manifest/ledger parity.** Hit exactly as described: registering `packages/model` in the
manifest without its ledger row failed `architecture-manifest.test.ts > lists no workspace the
manifest does not tag`. Treated as correct and updated `docs/rearchitecture-v3.md`'s row, which
that file's own text requires ("when a phase adds, renames or splits a package, it updates this
table and the manifest in the same commit").

### The same class, caught inside this issue — and it was worse than a count drift

Boundary rule 7's `loadModelExportNames` read only the **top level** of the home package's
`src/`. This issue moves those sources into subdirectories. Measured on the final layout:

| Scan | Names in rule 7's set | Exit code |
|---|---|---|
| Old, top-level-only | **4** — `toInstant`, `requireInstant`, `toIso`, `assertUnreachable` | 0 |
| Fixed, recursive | **48** — all of them | 0 |

The gate would have lost **44 of 48 names (92%)**, including every entity predicate it exists to
protect (`authorize`, `OPERATOR`, `isIssueDeferred`, `normalizeOriginUrl`, `handoffTargets`,
`dedupeSessionsByResume`, …) — and it would still have exited 0 and printed no violations. Not a
counter drifting; a *whole rule* silently reduced to near-nothing. Same family as the
path-prefix detector, different mechanism (directory depth, not prefix).

End-to-end proof the fixed rule works rather than merely recursing: `checkFile` on a synthetic
`packages/client-core/src/fake.ts` that declares `export function authorize(...)` returns exactly
one violation, rule `model-single-home`.

## Response to items 2–4

**2 — abduco labels.** Checked: **no `podium-reaptest-*` socket is held by any process** (the only
textual match on this machine was the coordinator's own mail-send argv quoting the label). Nothing
of mine left to reap; the leak POD-396 traced to this worktree was already reaped by them. I did
find and reap two strays of my own **by explicit PID after confirming `/proc/<pid>/cwd` was this
worktree** — never `pkill -f`, never an `abduco list` sweep. The 248 live `podium-<uuid>` agent
sessions were not touched.

**3 — control bytes.** `git diff --stat` against base shows **no `Bin` marker** on any file, and a
byte scan of every added/modified file finds **zero** control bytes (not just zero NULs). This
change carries no control characters as data.

**4 — a hang is not load.** I had no unexplained product hang; my one full-lane run that hit a
10-minute tool timeout later completed normally in the background, so it was slow, not
non-terminating. But I did have a genuine non-terminating loop, and it was mine: a polling shell
loop `while pgrep -f "vitest.unit.config"; do sleep 20; done` whose **own argv contains the
pattern**, so `pgrep` matched itself and the condition was never false. Exactly the described
shape — it presented as "the machine is busy". Killed by explicit PID.

Applying "what would this look like if it were real?" to my own diff: the only loop this change
introduces is the recursive directory walk in a **CI lint gate**, where a symlink cycle would hang
forever. Tested rather than assumed — built `src/sub/loop -> ../../src` and ran the walk under a
20s timeout: **terminated, exit 0**, and still found the nested export.
`readdirSync(withFileTypes)` reports a symlinked directory as `isSymbolicLink()`, not
`isDirectory()`, so the walk cannot follow a cycle. Bounded and verified.

## Two things found while doing this that were not in the brief

1. **Rule 7 would have gone dark.** `loadDomainExportNames` read only the *top level* of
   the home package's `src/`. Model organises sources into subdirectories, so the rule
   would have silently collapsed to the two files left at the root and reported "no
   violations" — a passing gate that checks almost nothing. Now recurses.
2. **`apps/server/src/repo-id.ts` has its own `normalizeOriginUrl`** (different
   signature: returns `null`, handles default ports). Rule 7 only scans `packages/*`, so
   it does not catch this. Left alone — out of scope, and it is a genuine second
   implementation of repo-origin canonicalisation worth its own issue.

## Deliberately not done

- No new authz scope kinds, no `user`/`owner`/`grant` members, no new action names, no
  `UserId`. The brief reserves those for POD-1075 / POD-1079 / Phase 3; this change only
  guarantees they can be added without a rewrite.
- No `instance_id` or instance-partition concept — multi-user is not multi-tenancy
  (ADR 1 D5 unaffected).
- No rewrite of `packages/domain/src/...` citations in `docs/adr/*` or
  `docs/multi-user-readiness.md`. Those are **dated evidence snapshots** with file:line
  references taken at assessment time; rewriting them would falsify the record.
  `docs/rearchitecture-v3.md`'s ledger row *was* updated, because the manifest test
  enforces ledger↔manifest agreement and the ledger itself says a package rename updates
  it in the same commit.
