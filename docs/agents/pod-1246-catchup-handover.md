# POD-1246 — main catch-up: resolved prefix and honest map

**State: merge IN PROGRESS, not committed. 19 of 109 conflicts resolved.**
Branch `issue/1246-main-catch-up-for-the-rewrite-branch`, merging `main` into it
(never the reverse). Integration untouched. Nothing pushed.

This document is the deliverable for the part that is *not* done. The 19
resolutions are cheap to redo from the decision table below if the merge state is
lost; the analysis is the expensive part and it is all here.

A patch of the staged resolutions is at
`docs/agents/evidence/pod-1246-tranche-abc.patch` (untracked, ~876 KB).

---

## 0. Read this first — three findings that change how the rest must be done

### F1. The 109 conflicts are not the whole job

Files **main added** that reference **integration-removed** modules merge
*cleanly* and break the build with no conflict marker anywhere. Confirmed:

| File (added on main) | References |
|---|---|
| `apps/server/src/modules/issues/conflict.ts` | `@podium/domain` (integration renamed it away) |
| `apps/server/src/migrations/restore.ts` | `@podium/domain` |
| `scripts/architecture-manifest.test.ts` | `@podium/domain` |
| `packages/model/src/issue/fields.ts` | main's own `packages/model` (a different package — see F2) |
| `packages/model/src/issue/__fixtures__/issues.ts` | same |

~39 files on main import `@podium/domain`. **Sweep this set explicitly after the
vertical**; `git diff --diff-filter=U` will never show it.

### F2. `packages/model` is a name collision, not a conflict

Neither side had it at the branch point (`e0272c73`). Both invented it:

- **main** — the L0 wire vocabulary (POD-791/822): `fields.ts`, `ids.ts`,
  `issue/`, `repo/`, `shape.ts`. Keeps `packages/domain` alongside it.
- **integration** — `packages/domain` absorbed and deleted, plus a much larger
  structure: `aggregates/ annotations/ authz/ entities/ fields/ identity/ ids/
  predicates/ projections/ provenance/ representations/ settings/ user-state/`.

Same name, disjoint contents. The decider is in **main's own**
`packages/model/src/index.ts`:

> "ADR 8 D4 records `packages/domain` → `packages/model` as a rename+absorb, so
> this package is that rename's destination, standing up ahead of it."

Both sides agree on the destination; integration *completed* what main declared.
**Integration's `packages/model` is the shell; main's vocabulary is content to
port into it.** Do not take either side wholesale — this is a union, and it is
the largest single job remaining.

One measured semantic difference to resolve during the union: main's
`Revision = z.number().int().positive()` vs integration's
`ChangeRevisionField = z.number().int().nonnegative()`. Different names, and
`0` is legal in one and not the other. Decide deliberately; they may not be the
same concept (entity revision vs change revision).

### F3. On expected-revision, MAIN is ahead — integration would silently regress it

This **inverts the brief's default lean** ("integration's normalized/derived path
is generally the target"). Measured:

- Integration has the stronger *general* engine:
  `packages/sync/src/authority/arbitration.ts` — default-closed, full ADR-1 rule
  matrix, rejects a mutating `exp-rev` write that arrives *without* a revision
  (`expected-revision-required`), throws rather than degrading `op-stream`.
- **But it is wired only into `funnel.ts` and `sessions/service.ts`.**
  `git grep expectedRevision HEAD -- apps/server` returns **nothing**.
- Main's POD-793 enforces exp-rev on **all 39 issue mutations** at the registry
  dispatcher: `registry.ts::checkExpectedRevision` → `conflict.ts` → structured
  409, with `checkExpectedRevision` as a pure predicate in
  `packages/domain/src/issue-concurrency.ts`, and the `concurrency` field
  declared per command def in `packages/protocol/src/commands.ts`.
- Main's one new migration is `20260717092407_issue-revision-and-feed-identity`
  — the storage side of the same feature. It is live.

**Taking integration's registry wholesale deletes shipped optimistic-concurrency
on the issues vertical.** Main's registry is 84 KB against integration's 58 KB,
so "the bigger diff wins" would also have got this backwards.

Recommended resolution (not yet applied):

1. Keep integration's `arbitration.ts` as the engine.
2. **Preserve main's issues enforcement path**: move
   `issue-concurrency.ts` → `packages/model/src/predicates/issue-concurrency.ts`
   (git itself suggests this rename target), rewrite `conflict.ts`'s import to
   `@podium/model`, and carry the `concurrency?: CommandConcurrency` field onto
   integration's L1/L3 command contracts.
3. File **wiring the issues registry onto `arbitration.ts`** as a follow-up
   issue. It is the right end state and it is not a merge resolution.

Note the two policies genuinely differ: main's predicate treats an omitted
precondition as `ok` (deliberate — no client can supply one yet); integration's
engine refuses it. Reconciling that is the follow-up's job, not this merge's.

---

## 1. What is resolved (19)

| File | Decision | Why |
|---|---|---|
| `package.json` | union | Verified programmatically: every script key + dep from both sides present (59 scripts). Only delta is integration's `test` adding `test:mobile`. **Resolve this file FIRST in any catch-up — a conflicted `package.json` breaks the `podium` CLI itself.** |
| `.github/workflows/ci.yml` | keep both | Verified by extracting every job/step/run from both sides. Merged jobs = `browser` (integration, POD-1227) + `lint`, `migrations`, `no-nul-bytes`, `oracle`, `typecheck`, `unit-tests` (main's guardrails). Took integration's NUL step label ("or docs") as the accurate one. |
| `vitest.config.ts` | integration + one main improvement | Integration's alias array is the superset; dropped the `@podium/domain` alias. **Adopted main's regexp anchoring on the composer alias** — integration's own comment on the model/sync aliases gives the reason main was right. |
| `docs/adr/0001` | integration | Every hunk is integration-only addition; its one replacement *contains* main's sentence verbatim. |
| `docs/adr/0002` | integration + main's POD-797 paragraph | Exactly as briefed. |
| `docs/adr/0003`, `0007` | integration | Differ by one line each (integration's "Amended by"). |
| `docs/adr/0004` | **genuine three-way** | Took main's IssueWire representation row (merged into integration's), main's SessionMeta sentence (main is the *landed* fact — POD-797 already deleted it; integration still said "will be deleted at POD-308", now false), and main's whole "Issues-pilot reconciliation" section. **Kept integration's HandoffManifest decision** — it is richer *and* explicitly supersedes main's, because POD-300 moved the manifest to `packages/model/src/entities/handoff.ts`. Taking main's would have re-pointed a landed decision at a file the manifest no longer lives in. |
| `docs/adr/README.md` | integration | Main's only unique text is the older status line integration deliberately replaces. |
| `docs/agents/testing.md`, `docs/rearchitecture-v3.md` | integration | Same reason as ci.yml — integration *built* the browser lane main's text says is in no lane. Carried main's `[spec:SP-c29e]` ref onto the janitor ledger row, since `audit:spec` reads those tags. |
| `scripts/check-boundaries.ts` | integration | Main has zero rules integration lacks. |
| `scripts/check-no-nul-bytes.ts` + test | integration | Strictly broader (adds `docs/`, `.md`). |
| `scripts/architecture-manifest.ts` + test | integration | Main's unique lines are all domain-era, superseded by the absorb. |
| `scripts/test-configuration.test.ts` | integration | Strict superset (adds the POD-1227 browser-lane reachability test); main's delta is formatting only. |
| `scripts/check-boundaries.test.ts` | integration + **2 tests ported from main** | Ported POD-808's `protocol near-leaf` and `model is a true leaf` — real coverage integration lacked on the edge ADR 8 turns on. **Verified: 89/89 pass**, and both assert a specific rule fires, so they are not vacuous. |
| `scripts/boundary-allowlist.ts` | **PROVISIONAL — integration** | See §2. Taken only so the boundary gate could run. **Must be re-measured.** |

**Method used throughout, and worth keeping:** after resolving, run
`git show main:<file> | grep -vxFf <resolved-file>`. Every main line missing from
the result has to be explained out loud. That is what caught the ADR-4
HandoffManifest inversion.

---

## 2. The two files that are MEASUREMENTS, not merge decisions

`scripts/rearch-audit-baseline.json` and `scripts/boundary-allowlist.ts` describe
the tree they sit in. **They cannot be resolved before the vertical is, and both
must then be re-measured, not hand-merged.**

Evidence that this is not theoretical: integration *deleted* allowlist entries for
`WorkerLabel.tsx`, `SidebarUnified.tsx` and `SidebarRail.tsx` because it **fixed**
that debt (brand-tone ternaries → record lookups in `agent-tone.ts`). Main still
has the ternaries. Whether those entries belong depends on which code wins in
tranche D. Main also has an entry integration lacks entirely
(`apps/web/src/features/issues/issue-context-menu.ts`, count 2) — and that file is
itself a tranche-D conflict.

### Deletion-audit baseline: detector sets differ

Integration declares **30** detectors, main **23**. Union = **32**.

- Only in integration (9): `capability-snapshots`, `instance-partitions`,
  `issue-wire-dirty-scoping-shims`, `legacy-wire-v1-adapter`,
  `machine-id-unbranded-fields`, `per-user-singletons`, `raw-string-entity-ids`,
  `representation-registry-rot`, `unbranded-by-decision-ids`
- Only in main (2): `issues-forwarder-transition`, `issues-legacy-local-wire`

Main's two are POD-797 detectors and **both should survive** — a detector reading
0 is a regression ratchet. Two complications:

1. `issues-forwarder-transition` is not a counting detector. It is a
   **registered residue** (`owner` / `expiry` / `sites`) in a separate
   `REGISTERED_RESIDUE` array that **integration does not have at all** — the
   array, its type, its reporting, and its test in `rearch-audit.test.ts` all
   have to be ported. One of its sites is `packages/sync/src/upstream.ts`, which
   **integration deleted**, so the port depends on the tranche-D upstream call.
2. `issues-legacy-local-wire` greps for `toWireMemo|wireCache|…` in
   `apps/server/src`. **Integration still has that path** (its
   `wire-memo.test.ts` is a modify/delete pair against main's deletion). Main's
   POD-797 deleted the legacy local issue wire; integration rebuilt it. So this
   detector will report **> 0** on the merged tree, correctly. That is a real
   finding to act on, not a number to round away.

Lower-per-key floor (union of keys, lower value each) — **a floor, not the
answer; re-measure with `bun scripts/rearch-audit.ts` and make the file match**:

```
adoption-backfill-heals 9   agent-kind-enums 0   capability-snapshots 0
capability-tables 5   change-row-typings 7   cli-launch-plan-debt 1
composition-root-forward-refs 1   durable-host-sync-async-twins 4
instance-partitions 0   issue-shapes 0   issues-legacy-local-wire 0
issue-wire-dirty-scoping-shims 4   legacy-wire-v1-adapter 6
local-placeholders 12   machine-id-unbranded-fields 36   mobile-client-value 1
panel-mode-duality 3   per-user-singletons 0   publish-computed-fanout 0
raw-string-entity-ids 0   reexport-shims 22   representation-registry-rot 0
router-triple-access 18   send-turn-duplicate 0   session-shapes 0
state-dir-defs 0   static-systemd-units 11   superagent-shadow-types 2
unbranded-by-decision-ids 17   upstream-sync-forwarder 0   web-storage-keys 12
```

Checked per key as instructed — integration is **not** lower on every key:
`change-row-typings` (12 vs 7) and `local-placeholders` (16 vs 12) are lower on
**main**. Taking integration wholesale would have absorbed a regression on both.

---

## 3. What remains (90), tranche by tranche

### C-remainder (4 files) — needs the vertical first
`scripts/rearch-audit.ts`, `scripts/rearch-audit.test.ts`,
`scripts/rearch-audit-baseline.json`, `docs/rearch-deletion-audit.md`.
Plus re-measuring `boundary-allowlist.ts` (currently provisional).

### D — the issues vertical (~85 files). The real work.

| Group | Files | The question to answer |
|---|---|---|
| `apps/web/src/features/issues/*` | 19 | Which rewrite of the issues UI wins, per file |
| `packages/client-core/*` | 9 | viewmodels + engine + replica |
| `packages/sync/*` | 7 | Includes 3 **delete/modify**: `upstream.ts`, `upstream.test.ts`, `test-support.ts` — deleted by integration's POD-309 (retired the node⇄hub forwarder), modified by main's POD-822/796 (+30 lines: normalized issue emit, `issueDep`/`repo` entity kinds). Does integration's replacement carry normalized emit? |
| `apps/server/src/modules/issues/*` | 7 | Registry, publish, service/{core,crud,reads,workflow}. **See F3 — do not take integration's registry wholesale.** Includes `wire-memo.test.ts` (modify/delete, integration keeps a path main deleted) |
| `packages/model/*` | 6 | **The union of F2.** `package.json`, `index.ts`, `tsconfig.json`, `tsup.config.ts` are all add/add |
| `packages/protocol/*` | 4 | Includes `commands.ts` **delete/modify** — integration absorbed it into the L1/L3 registry (POD-311); main added +62 lines of POD-793 concurrency contract. Port the `concurrency` field |
| `apps/server/src/modules/messaging/*` | 4 | |
| `packages/domain/src/index.ts` | 1 | **delete/modify.** Integration deleted the package; main added `issue-concurrency` + `git-identity` + `worktree` exports. Relocate, do not resurrect the package. (Main's version also has a duplicate `export * from './snooze'` — a real bug on main; do not carry it over.) |
| relay / funnel / sessions / store / mobile | ~14 | |
| `apps/server/src/relay.upstream-issues.test.ts`, `router.upstream-issues.test.ts` | 2 | **delete/modify** — deleted by integration, modified by main. Their fate follows the `upstream.ts` call above |

### E — migrations. **Good news, already verified.**
Both sides' migrations are additive and **all 12 survive the merge unconflicted**
(integration 11, main 1 — `20260717092407_issue-revision-and-feed-identity`).
Confirmed present in the merged working tree. Only
`apps/server/src/migrations/schema.ts` conflicts, and the manifest must be
regenerated (`bun run migration:check`, `bun run migration:manifest`).

### F — last
`bun.lock`: regenerate with `bun install` after **all** workspace `package.json`
files resolve. Deliberately not hand-merged.

---

## 4. Gate baseline

The committed baseline (`docs/agents/pod-1246-gate-baseline.txt`) lists 11 gates.
**I ran all 28** (every `audit:*`, `lint:*`, `migration:*`). It agrees exactly:
everything green except `audit:phase2-client` (4 open sites, POD-1239, expected).
Use the 28. A gate green there and red after the merge is a real finding.

The full 28 are written out at **`docs/agents/pod-1246-gate-baseline-full28.txt`**
(untracked, in this worktree) so they outlive the scratchpad. Compare against that
file, not the 11.

Gates cannot be meaningfully re-run until the tree typechecks, which it will not
until tranche D is done.

---

## 5. Sequencing note for whoever continues

Integration moved twice while this ran (`d3899451`, then `db7f13c1` for POD-1239,
which touches `apps/web/src/lib/webReplica.ts`,
`packages/client-core/src/replica/replica.ts` and
`apps/web/src/app/store.replica.test.tsx` — all tranche-D files).

Because the merge is mid-flight, a fast-forward is not possible right now. The
clean path is: **finish this merge, then merge the newer integration on top** as
a normal second merge. None of `db7f13c1`'s files are in tranches A–C, so nothing
resolved so far is invalidated. Do **not** abort and restart to pick it up.

Standing constraints, unchanged: never push to main, never `git stash` (the stash
is repo-wide across every worktree here), `git status --porcelain` empty before
every commit, and `bun install` before believing any red.
