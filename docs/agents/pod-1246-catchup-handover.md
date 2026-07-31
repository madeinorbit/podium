# POD-1246 — main catch-up: resolved prefix and honest map

**State: merge IN PROGRESS, not committed. 38 of 109 conflicts resolved.**
(Groups (a) model union, (b) sync/upstream, and (c) partial — registry structure
taken, declarations mapped in §2e and not yet applied.)
Branch `issue/1246-main-catch-up-for-the-rewrite-branch`, merging `main` into it
(never the reverse). Integration untouched. Nothing pushed.

This document is the deliverable for the part that is *not* done. The
resolutions are cheap to redo from the decision table below if the merge state is
lost; the analysis is the expensive part and it is all here.

A patch of the staged resolutions is at
`docs/agents/evidence/pod-1246-tranche-abc.patch` (untracked, ~876 KB).


## 0b. READ BEFORE TRUSTING ANY TYPECHECK IN THIS MERGE

**While a single conflict marker exists anywhere in a project's source, `tsgo`
reports ONLY SYNTAX errors and performs NO SEMANTIC CHECKING.** Measured, not
inferred:

- `apps/server` typecheck emits 294 errors: **290 × TS1185** (conflict marker) and
  **2 × TS1128**. Zero semantic errors.
- A blatant `const __probe: number = "not a number"` appended to `registry.ts`
  produces **no error at all** in that run.
- The identical probe in `packages/model` — which has no markers and no workspace
  deps — is correctly reported as **TS2322**.

### What this invalidates, including my own claims

| Claim | Status |
|---|---|
| Group (a): `@podium/model` typechecks clean | **VALID.** Zero-dependency leaf, no markers in its graph — semantic checking was live, and the probe proves it. |
| Group (b): "zero errors from `packages/sync` itself, only protocol markers" | **NOT EVIDENCE.** Re-tested with a probe in `ledger.ts`: not reported. The run emitted 36 × TS1185 and nothing else. The statement was literally true and meaningless — the instrument could not have said no. |
| Group (c): `conflict.ts` "resolves, no errors" | **NOT EVIDENCE**, same reason. The import is *plausibly* fixed; it is not verified. |

This is the `[[instrument-must-say-yes-first]]` failure, made while citing that
principle elsewhere in this document. A green from an instrument that cannot go
red is not a weak signal — it is no signal.

### Consequences for the remaining work

1. **"A group is done when its consumers compile" is UNACHIEVABLE mid-merge.** The
   compile signal is syntax-only until the last marker in the dependency graph is
   gone. Per-group typecheck still catches *syntax* damage, which is worth having
   — just do not call it verification.
2. **The registry's compiler-driven enumeration cannot run yet.** The tripwire is
   installed (`def()`'s `ContractDeclaresConflict` constraint) but **INERT** until
   `apps/server` and its deps are marker-free. It has NOT been proven to fire.
   Prove it before relying on it: with markers cleared, remove one contract's
   `conflict` and confirm the compiler names that call site.
3. **Sequence accordingly:** clear every remaining marker in `apps/server` +
   `packages/protocol` FIRST, even resolving some files provisionally, then let the
   compiler enumerate. Applying 43 declarations before the compiler can check them
   is the memory test this whole mechanism exists to avoid.
4. The only trustworthy mid-merge instruments are the ones that do not depend on
   semantic analysis: `bun run lint:shadowing`, the unit lane on marker-free
   packages, and targeted `git show main:<f> | grep -vxFf` audits.


## 0c. THE EXP-REV CHAIN HAS FIVE LINKS. INTEGRATION HAS ONE, AND IT IS THE WRONG ONE.

Every earlier note in this document said "preserve main's enforcement". That
undersells it and could produce a WORSE outcome than dropping exp-rev entirely.
Measured across the merged tree:

| # | Link | Where | State in the merged tree |
|---|---|---|---|
| 1 | `issues.revision` COLUMN | migration `20260717092407` | **PRESENT** — additive, survives the merge, `DEFAULT 1 NOT NULL` |
| 2 | The INCREMENT on every write | `apps/server/src/store/issues.ts` | main only — **CONFLICTED**, resolvable now. Main calls it "THE revision assignment (ADR 2 D3) … the issues table's only SQL … a fresh revision with no call-site cooperation". Integration's copy: `grep revision` → nothing. |
| 3 | The FIELD on the entity/wire | main: `IssueWire.revision: Revision.optional()` | main only — integration's `packages/model` has **no revision field anywhere** on the issue entity, wire or projection |
| 4 | The DECLARATION per command | `conflict: 'exp-rev'` on the contract | main only — integration declares **0 of 43** |
| 5 | The ENFORCEMENT → 409 | registry dispatcher → `conflict.ts` | main only |

**The column exists and nothing writes it, nothing reads it, and nothing declares
against it.** That is not a neutral half-state — it is a trap:

- `DEFAULT 1 NOT NULL` means **every row reads revision 1, forever**, because
  nothing increments it.
- If a later change wires enforcement (POD-1247) without link 2, every write
  carrying `expectedRevision: 1` MATCHES and every other value is refused. The
  guard would pass exactly the writes it exists to catch, and look like it is
  working — a green concurrency check over a frozen counter.

**So a PARTIAL preservation is worse than none.** Resolving `store/issues.ts` to
integration's side, on its own, is the single most damaging call available in this
merge, and nothing in the tree would report it: no conflict (it is a resolution),
no shadowing (one definition), no typecheck (semantic checking is off — §0b), and
`issues.expected-revision.test.ts` cannot run while markers remain.

**Rule for whoever resolves the rest:** links 2–5 land together or not at all. If
context runs out mid-chain, say which links are in and which are not — a chain
described as "exp-rev preserved" when link 2 is missing is the most expensive
sentence this handover could contain.


## 0d. `protocol/messages/sync.ts` IS BLOCKED — and the block is the second partial-mechanism trap

Protocol is otherwise clear (`commands.ts` deleted as absorbed into
`packages/commands/framework.ts`; `messages/issues.ts` resolved to integration,
since POD-300 moved the 391-line vocabulary to `@podium/model` as both sides
planned). **`sync.ts` is the last protocol file and I deliberately did NOT
resolve it.**

Five of its seven hunks are mechanical: integration refactored repetitive zod arms
into helpers (`metadataChangeArm(...)`, `changesSinceDeltaArm/SnapshotArm`) — same
content, less repetition, integration wins.

**Hunks 2 and 6 are not mechanical.** Main ADDED three entity kinds to the change
feed and to the snapshot (POD-796 / POD-822): `issueProjection`, `issueDep`,
`repo`. Integration's arm list has **none of them**, and the payload types are
absent from integration entirely:

| Type | Integration |
|---|---|
| `IssueProjection` | **ABSENT** |
| `IssueDepProjection` | **ABSENT** — needs main's `issue/dep.ts` |
| `RepoProjection` | **ABSENT** — needs main's `repo/` |

Those last two are exactly the **group (a) port-back debt** — deleted there because
they were coupled to consumers, and this is the consumer. The coupling was real.

**Why I did not resolve it to integration's structure:** doing so silently drops
POD-796/822's normalized issue feed, which is the §0c pattern again — the newer
branch's form is right, the older branch's content is missing, and taking the form
loses the content with nothing reporting it. Resolving hunks 2 and 6 requires
first deciding the dep/repo entity port-back.

**A grep trap here, recorded because it nearly misled me:** integration's
`packages/sync/src/change-log.ts:130` exports a FUNCTION called `issueProjection`
that strips volatile fields to compute a dirty key. It is not main's
`IssueProjection` TYPE and answers a different question. A name search for
"issueProjection" over integration returns a hit and reads as "integration has
this". It does not.

### Practical consequence for the marker-clearing sequence

§0b says clear all markers so semantic typechecking comes back, then let the
compiler enumerate. `sync.ts` cannot be cleared without the dep/repo decision, so
that decision is now on the critical path for EVERYTHING downstream — it gates the
typechecker, which gates the registry tripwire, which gates the 43 declarations.
It is the next thing to do, and it is a modelling decision rather than a merge one.

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

## 2b. GROUP (a) DONE — and the port-back debt it left

`packages/model` union resolved (9 files). Integration is the shell, as predicted.
Verified: model typechecks clean, 520 tests / 35 files pass, the relocated
`predicates/issue-concurrency.test.ts` confirmed running by name (5 cases).

What the union actually reduced to:
- Integration's `ids/brands.ts` already covers all of main's `ids.ts` → deleted.
- Main's `fields.ts` had exactly two symbols integration lacks — `Revision` and
  `Timestamp` → ported to `packages/model/src/fields/primitives.ts`.
- `packages/domain` fully removed; main's duplicate `snooze` export not carried.

**Trap recorded in the new file:** `Revision` (positive — an entity that exists
was written once) is NOT `fields/change.ts`'s `ChangeRevisionField` (nonnegative —
a stream position). They disagree about `0`. Do not merge them. Likewise
`Timestamp` (field schema) is not `clock.ts`'s `Instant` (runtime epoch-ms +
adapters); integration inlines `z.string()` at every `*At` field, which is the
restatement `Timestamp` exists to collapse — migrating those call sites is
follow-up, not a merge edit.

### PORT-BACK DEBT — three things of main's deleted, none covered, all coupled

Deleted rather than left staged because main's `issue/`+`repo/` import
`../fields`; keeping them while deleting main's `fields.ts` leaves dead code that
does not typecheck.

| Main content | Integration has | Decide with |
|---|---|---|
| `issue/dep.ts` — issueDep as a FIRST-CLASS entity (`IssueDepId`, `asIssueDepId`, `issueDepShape`, `IssueDepProjection`, `issueDepToWire/FromWire`) | only `IssueDepWire` + `ISSUE_DEP_TYPES` — a wire shape, no entity. POD-822, **main ahead** | groups (b)/(c): protocol + server projection |
| `repo/` — `repoIdentityFields`, `repoDurableShape` (Repo prefix entity, POD-822) | repo only in `annotations/matrix` | groups (b)/(c) |
| `shape.ts` — `WireShape`/`wireShape`, `dropNullValues`/`restoreNullValues` | its own approach inside `replica.ts` + `removal-family.test.ts` — **both sides solved null-encoding differently** | group (d): `replica.ts` |

## 2c. GROUP (b) DONE — the upstream call, and what it decided

**The call: integration's POD-309 retirement WINS, and it is complete.** Verified
rather than assumed — the four surviving `UpstreamSync` mentions in integration
are all *comments explaining the deletion* (the `[[detector-mention-is-not-a-call]]`
shape), plus one real import of `reportParkedUpstreamMutations` from a dedicated
`upstream-retirement` module that dead-letters anything left queued. A retirement
with a migration path for parked writes, per ADR 5 D8.

Main's +30 lines on `upstream.ts` were **defensive no-op arms**
(`case 'issueProjection': break`), added only to keep `change satisfies never`
exhaustive after POD-822 introduced entity kinds — not new capability. The value
was the interlock comment, which dies with the module it guarded.

Deleted with it (the `[[proves-versus-records-on-a-delete-list]]` call — these
PROVE the doomed writer): `upstream.ts`, `upstream.test.ts`,
`src/test-support.ts`, `relay.upstream-issues.test.ts`,
`router.upstream-issues.test.ts`.

Also resolved: `sync/index.ts` (integration's header + `feed/index` exports),
`adapters/sqlite/sync-repository.ts` (integration's paths + main's fuller doc
comment naming `sync_feed`), `ledger.ts` + `ledger.test.ts` (integration's
Authority-delegating rewrite — main's `conversationProjection` / `minAvailableSeq`
additions are already absorbed into integration's `authority/` + `change-log.ts`).

**Main's flat `feed-identity.ts` + test retired** as superseded by integration's
`feed/` directory (registry, `assertOpaqueEpoch`, visibility, publisher). Both
sides mint opaque UUID epochs, so both were correct; integration's is simply the
richer structure and is what `index.ts` exports.

**Verified:** `bun run --cwd packages/sync typecheck` reports **zero errors from
`packages/sync` itself** — the only failures are unresolved conflict markers in
`packages/protocol/src/messages/sync.ts`, which is group (c).

### Two F1 hazards caught here — the sweep is real, not theoretical

1. `packages/sync/src/feed-identity.test.ts` (main, merged CLEAN) imported
   `./test-support`, which integration had **moved** to
   `adapters/sqlite/test-support.ts`. No conflict marker anywhere.
2. `apps/server/src/migrations/restore.ts` (main, merged CLEAN) consumes
   `ensureFeedIdentity` from main's now-deleted `feed-identity.ts`. **Still
   outstanding — must be repointed at integration's `feed/identity.ts` when
   group (c) reaches `apps/server`.**

## 2d. GROUP (c) PARTIAL — the carry-forward, a group-(b) defect, and the registry strategy

37/109. Group (c) is NOT complete: `registry.ts` (48 hunks) and 9 other files remain.
What follows is worth more than the file count.

### The carry-forward is fixed — and I had named the wrong symbol

`apps/server/src/migrations/restore.ts` did **not** import `ensureFeedIdentity`
(that grep hit two comments — the `[[detector-mention-is-not-a-call]]` shape, in
my own earlier finding). The real break was **`remintEpoch`**, which group (b)
deleted with main's `feed-identity.ts`.

Fixed by mirroring `relay.ts:389`'s canonical wiring: `FeedIdentityRegistry` over
a `{readIdentity, writeIdentity}` port on `SyncRepository`, bumping with cause
`'restore'` — which integration's `EpochBumpCause` defines for exactly this
[spec:SP-4428] runbook. Integration's `bump()` also *refuses* a mint that returns
the epoch it is replacing, a guard main's helper lacked. Also repointed the table
probe `sync_feed` → `feed_identity` and six stale doc references.

### A REAL DEFECT I INTRODUCED IN GROUP (b), found here

`sync-repository.ts` had **`readFeedIdentity()` defined TWICE** — main's against
`sync_feed`/`id=1` and integration's against `feed_identity`/`singleton=1`. Git
auto-merged them as separate method blocks (the conflict was only in the header
and imports), the second silently wins, and **tsgo reports nothing**. My group (b)
"typecheck clean" claim was true as stated and still missed this.

Resolved by measurement: main's `initFeedIdentity`/`setEpoch` have **zero callers**
in the merged tree; integration's pair is live in `relay.ts` + two suites. Deleted
main's trio. Both migrations survive, so `sync_feed` remains as an unused table —
harmless, but note it before anyone reads it as live.

**Lesson for the remaining groups — now a gate, not a note.** Three ways a merge
goes wrong and only two report themselves:

| | what | who tells you |
|---|---|---|
| CONFLICT | both sides edited the same lines | git |
| BREAKAGE | one side edited lines the other DEPENDS on | typechecker |
| SHADOWING | both sides ADDED the same declaration | **nobody — and it runs** |

`scripts/check-merge-shadowing.ts`, wired as **`bun run lint:shadowing`**, is the
detector. Proven against controls before being believed: it fires on a synthetic
duplicate, fires on THE REAL DEFECT reconstructed from git (correct lines 26/299),
and is silent on the fixed file. Currently **clean across 2018 files**.

Two things about it that matter operationally:
- **It skips files still carrying conflict markers** — both sides' text is present
  there by construction, so every duplicate would be a false hit. It is therefore
  only meaningful on RESOLVED files: **run it after each group, not once at the
  end.** This defect was introduced in group (b) and surfaced in group (c).
- The first draft returned 164 findings (object-literal properties matched by a
  too-loose indent rule) and I nearly shipped it. A detector with that
  false-positive rate is worse than none — it becomes a green tick over an unread
  list. Only the controls distinguished the noisy version from the tight one.

This adds a 29th gate to the baseline list. It passes today, so it is additive to
the green-before/green-after comparison rather than a change to it.

### `packages/protocol/src/version.ts` — resolved, union, one stale claim caught

Both sides expanded the docs complementarily (integration: the support-window
architecture; main: the three version namespaces, ADR 2 D4). Hunk 2 was a genuine
disagreement, settled by measurement: `isProtocolCompatible` has **zero**
production callers, `versionSupport` is the live gate (`ws-server.ts`,
`negotiation.ts`), so main's `@deprecated` is correct.

**Caught a claim that main wrote true and the merge made false:** "MIN_SUPPORTED_
VERSION === WIRE_VERSION === 1" — integration's `WIRE_VERSION = 2` survives, so
the window is now `[1,2]` and the two checks genuinely disagree for a v1 peer.
Rewrote it to say so. 6/6 tests pass.

### THE REGISTRY STRATEGY — this is the important part

48 hunks, but they are NOT 48 judgements. **37 touch concurrency, and almost all
have the shape `ours = empty, theirs = N lines`**: main ADDED a concurrency
declaration (`concurrency: EXPECTED_REVISION`) and an envelope merge
(`.merge(rev)`) to each of ~35 command defs; integration restructured the file
and has none of it (`grep -c concurrency` over integration's registry: **0**).

So the resolution is not "pick a side" — it is **take integration's structure and
re-apply main's concurrency declarations onto it.**

**TWO TRIPWIRES MAKE THIS SAFE, AND BOTH ALREADY EXIST:**

1. **Compiler.** Main's `registry.ts:161`:
   `} & (K extends 'mutation' ? { concurrency: CommandConcurrency } : { concurrency?: never })`
   Preserve this conditional type and **the compiler lists every mutation def
   missing a declaration.** 35 careful judgements become a compiler-driven
   checklist that cannot be silently incomplete.
2. **Test — already survived the merge, clean.**
   `apps/server/src/issues.expected-revision.test.ts` (12 cases: 409 CONFLICT with
   the current revision reported, rebase-and-retry, LWW when omitted, append-only
   with no precondition). It is IN THE MERGED TREE NOW. **The registry job reduces
   to "make this test pass," and dropping main's enforcement cannot satisfy it.**

#### CORRECTION — the vocabulary ALREADY EXISTS, under a different name

My first pass said integration has "zero concurrency" and the vocabulary needs
re-creating. **That was wrong, and wrong in the exact way this merge keeps
punishing.** I grepped the registry for the NAME `concurrency` instead of asking
what question the symbol answers.

Integration deleted `protocol/commands.ts` by ABSORBING it — its own
`packages/commands/src/index.ts` says so: "`protocol/commands.ts` is
`framework.ts`". And `framework.ts:166` declares:

```ts
export type ConflictClass =
  | 'exp-rev' | 'field-LWW' | 'single-writer' | 'append' | 'cmd' | 'op-stream'
```

with `conflict?: ConflictClass` on `CommandDef`. That answers the **identical**
question as main's `CommandConcurrency` and is **richer** — 6 ADR 1 classes
against main's 3. Main's only unique payload is the `rule: string` on
`command-specific`.

So the three parts come apart cleanly, and only two are missing:

| Part | integration | main |
|---|---|---|
| Vocabulary | **`ConflictClass`, 6 members — the target** | `CommandConcurrency`, 3 members |
| Declarations on issue commands | **NONE** (`grep -c "conflict: '"` on `issues/contracts.ts` → 0) | ~35 defs |
| Enforcement (dispatcher → 409) | **NONE** | yes, + the surviving test |

**Revised registry resolution:**

1. Keep integration's `ConflictClass` as the vocabulary. Do NOT resurrect main's.
2. Map main's declarations onto it per def:
   `concurrency: EXPECTED_REVISION` → `conflict: 'exp-rev'`, `{kind:'append'}` →
   `'append'`, `{kind:'command-specific', rule}` → `'cmd'` (carry `rule` into the
   adjacent comment, or extend the type — a deliberate call, not a silent drop).
3. Preserve main's enforcement, re-pointed at `def.conflict === 'exp-rev'`.
4. **Keep main's tripwire and adapt it:** integration's `conflict?` is OPTIONAL,
   which is exactly the hole main's `registry.ts:161` conditional type closes.
   Re-declare it over `ConflictClass` so a mutation def still cannot omit it:
   `} & (K extends 'mutation' ? { conflict: ConflictClass } : { conflict?: never })`
   Without this the compiler stops enumerating the missing defs and the work
   becomes 35 manual checks again.
5. `CommandEnvelope` / `RevisionedCommandEnvelope` / `byIdRev`: integration's issue
   contracts already inline `mutationId: z.string().max(128).pipe(MutationIdField)
   .optional()`, so only the `expectedRevision` half is genuinely absent. It
   composes `Revision`, which group (a) ported to
   `packages/model/src/fields/primitives.ts`, and `MutationId`, which integration
   already has in `@podium/model`'s `ids/brands.ts`.


## 2e. THE REGISTRY MAPPING — extracted from main, verified, 43/43

Group (c) continued. `registry.ts` is resolved to **integration's structure**
(`git checkout --ours`), which is correct: all six non-concurrency hunks favour
integration, including main's `issueWrite` hub-forwarding, which POD-309 retired
(consistent with the group (b) call). What remains is re-applying the declarations.

### Where they go — one layer down from where the method said

Integration's `def()` merges `input` and `action` **from the L1 contract**
(`ISSUE_CONTRACTS` in `packages/commands/src/issues/contracts.ts`). So the
declaration belongs on the CONTRACT, not the registry def, and the tripwire must
sit there too. Note `CommandContractBase` (`contract.ts:305`) has **no `conflict`
field at all** — the `conflict?: ConflictClass` seen earlier is on framework.ts's
older `CommandDef`, a parallel type the issue contracts do not use.

`contract.ts`'s own header gives the argument for making it REQUIRED rather than
optional, in integration's words about `visibility`: *"a missing X must mean Y …
and that default is not reachable if the field can simply be absent."* There is no
safe default merge policy — integration's `arbitration.ts` says exactly that — so
`conflict` has the same claim to being required. Making it required on
`CommandContractBase` cascades to every namespace; scoping the requirement to the
issue table avoids that. **That choice is the one open design decision left here.**

### THE `rule` STRING IS NOT OPTIONAL — settled by integration's own engine

Main's `cmd(...)` declarations carry a rule string; integration's `ConflictClass`
is a bare union with no payload. This looked like a "decide deliberately" call and
it is actually decided by evidence: `packages/sync/src/authority/arbitration.ts:116`
says a command rule is **REQUIRED** for `cmd` rows and the module **throws** rather
than waving one through — *"otherwise it is a synonym for unchecked."* So the 15
rule strings must survive as DATA (an extra contract field), not as comments.
Dropping them would hand POD-1247 fifteen rows its own engine refuses to arbitrate.

### The complete mapping, extracted from main (23 exp-rev / 5 append / 15 cmd)

A parse that missed the `cmd('…')` helper form initially reported 15 as
undeclared. They are not — main's conditional type makes a declaration mandatory
for every mutation, and all 43 have one. Verified against the source before use.

| command | conflict | main's `rule` (cmd rows only) |
|---|---|---|
| `action` | `cmd` | git action; guarded by branch/worktree state, not a revision |
| `addComment` | `append` | — |
| `addSession` | `cmd` | live-path spawn; guarded by worktree/session state, not a revision |
| `addShell` | `cmd` | live-path spawn; guarded by worktree/session state, not a revision |
| `answerQuestion` | `exp-rev` | — |
| `applySuggestion` | `exp-rev` | — |
| `archive` | `exp-rev` | — |
| `attachSession` | `append` | — |
| `claim` | `exp-rev` | — |
| `cleanup` | `cmd` | local git cleanup; guarded by closed+merged+clean checks, not a revision |
| `clearNeedsHuman` | `exp-rev` | — |
| `close` | `exp-rev` | — |
| `create` | `append` | — |
| `defer` | `exp-rev` | — |
| `delete` | `exp-rev` | — |
| `depAdd` | `exp-rev` | — |
| `depRemove` | `exp-rev` | — |
| `dismissSuggestion` | `exp-rev` | — |
| `duplicate` | `exp-rev` | — |
| `integrate` | `cmd` | local git integrate; guarded by worktree/branch state, not a revision |
| `mailClaim` | `cmd` | message status machine; guarded by the claim check, not an issue revision |
| `mailInbox` | `cmd` | mailbox read-and-mark; per-message delivery state, not an issue revision |
| `mailSend` | `append` | — |
| `markRead` | `cmd` | field-LWW read-tracking; last stamp wins, no precondition |
| `markUnread` | `cmd` | field-LWW read-tracking; last stamp wins, no precondition |
| `panelApply` | `exp-rev` | — |
| `promote` | `exp-rev` | — |
| `refreshAssistant` | `cmd` | assistant recompute; derives from current state, no caller-read baseline |
| `reparent` | `exp-rev` | — |
| `restore` | `exp-rev` | — |
| `setCoordinator` | `exp-rev` | — |
| `setLabels` | `exp-rev` | — |
| `setNeedsHuman` | `exp-rev` | — |
| `setState` | `exp-rev` | — |
| `setTucked` | `cmd` | field-LWW sidebar curation; last tuck state wins |
| `start` | `cmd` | live-path spawn; guarded by worktree/session state, not a revision |
| `stop` | `cmd` | live-path stop; guarded by session/worktree state, not a revision |
| `subscriptionAdd` | `append` | — |
| `subscriptionRemove` | `cmd` | own-row delete; guarded by the ownership check, not an issue revision |
| `subscriptionSetEnabled` | `cmd` | own-row flag toggle; guarded by the ownership check, not an issue revision |
| `supersede` | `exp-rev` | — |
| `undefer` | `exp-rev` | — |
| `update` | `exp-rev` | — |

### Remaining steps
1. Add `conflict` (+ the rule field for `cmd`) to the 43 mutation contracts above.
2. Make it required for issue mutations so the compiler enumerates omissions.
3. Add `expectedRevision` to the 23 `exp-rev` contract inputs — it composes
   `Revision` from `model/fields/primitives.ts` (ported in group (a)); `mutationId`
   is already inlined on integration's contracts.
4. Restore main's dispatcher enforcement, re-pointed at `def.conflict === 'exp-rev'`.
5. **`apps/server/src/modules/issues/conflict.ts` still imports `@podium/domain`**
   (main's, merged CLEAN — a live F1 hazard). Repoint to `@podium/model`.
6. Acceptance: `apps/server/src/issues.expected-revision.test.ts`, already in the
   tree, 12 cases. Then `bun run lint:shadowing` and typecheck the dependents.

## 3. What remains, tranche by tranche

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
