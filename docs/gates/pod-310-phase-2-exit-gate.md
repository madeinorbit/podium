# POD-310 — Phase 2 exit gate: one sync kernel, verified

**VERDICT: HELD OPEN.** Phase 2 does not exit today, and POD-289 may not close. Four things
refuse, listed in §1. None of them is "a test went red" — the lanes and the audits are in
better shape than the brief expected. What refuses is that two of this issue's four
acceptance criteria are *unwritten*, one audit is red with **no open issue owning it**, and
the AC's literal sentence contradicts a deliberate Phase-2 design decision in a way only the
coordinator may resolve.

**Measured at `7f01445d`**, branch `issue/310-2-6-live-upgrade-rehearsal-local-topolog`.
At session start this was **0 ahead / 0 behind `issue/279-integration`**. It is now
**0 ahead / 10 behind** — siblings landed mid-run. Per the fan-out rules the base was **not**
merged in. The drift is auditable and does not touch anything measured here: all ten commits
are `docs/agents/*` plus one new `scripts/check-merge-shadowing.ts` and its `package.json`
entry — **no product code, no audit script, no baseline, no conformance suite**
(`git diff --stat HEAD...issue/279-integration` = 4 files, 636 insertions, 0 deletions).

**This gate changed no files.** Every mutation below was reverted atomically and the tree
verified clean (`git status --porcelain` empty) before the next one was applied.

---

## The method, because the verdict depends on it more than on the counts

POD-423 set the bar and this gate inherits it verbatim: **a zero is worth nothing until the
thing that reports it has been made to report a one.** Every detector named in this issue's
AC was **mutated on the real tree** — never on a fixture inside the detector's own test —
with the match count asserted before the edit landed, the edit grepped back, the file hash
recorded, and the revert hash-verified.

**Twenty-two mutants. Twenty-one said NO. One did not, and it is a real finding (§3).**

| # | Mutation planted on the real tree | Instrument | Said NO? |
|---|---|---|---|
| M1 | `funnel.publishComputed(...)` call added to `gateway/feed-serving.ts:126` | `publish-computed-fanout` | **YES** — `baseline 0 → now 1`, named the line |
| M2 | anchor pattern's `publishComputed` branch renamed | anchor | **YES** — throws, names the unmatched control |
| M3 | anchor pattern's `fanOutSnapshot` branch renamed | anchor | **YES** — throws, names the other control |
| M4 | `PUBLISH_COMPUTED_ROOTS` → a directory that does not exist | anchor | **YES** — "scanning nothing; its zero is a phantom" |
| M5 | anchor pattern's `UpstreamSync` **declaration** name broken | anchor | **YES** — throws, names 1 control |
| M6 | anchor pattern's **construction** branch (`new `) broken | anchor | **YES** — throws, names **both** construction controls |
| M7 | `UPSTREAM_RETIREMENT_ROOTS` → directories that do not exist | anchor | **YES** — "scanning nothing" |
| M8a | `export class UpstreamSync {}` planted in `apps/server/src/upstream-retirement.ts` | `upstream-sync-forwarder` | **YES** — `0 → 1` |
| M8b | `new UpstreamForwarder({})` planted in the same real file | `upstream-sync-forwarder` | **YES** — `0 → 1` |
| M9 | a 7th `LegacyWireV1Adapter` reference added to `wire-feed-edge.ts` | `legacy-wire-v1-adapter` | **YES** — `6 → 7` |
| M10 | a 13th hand-restated change row planted in `feed-serving.ts` | `change-row-typings` | **YES** — `12 → 13` |
| S1ⁿ | `readonly epoch` → `readonly epochRenamed` | `audit:seam` S1 | *(mis-aimed — see §3.1)* |
| S1′ | `readonly epoch: string` → `readonly generation: string` (real deletion) | `audit:seam` S1 | **YES** — `S1-feed-identity` |
| S2′ | `causationId` **deleted from the change schema**, docstring left alone | `audit:seam` S2 | **NO — §3.2** |
| S2″ | same, plus the docstring word | `audit:seam` S2 | **YES** — isolates the cause |
| S3 | reserved node strategy made to return `ok: true` | `audit:seam` S3 | **YES** — "that is H2 product behaviour, not a seam" |
| S4 | `@trpc/client` type import baked into a kernel file | `audit:seam` S4 | **YES** — `S4-kernel-ports-neutral` |
| R | `upstreamMirrorFor(node)` re-grown in real server source | `audit:seam` R | **YES** — `R-retirement-holds` |
| P2 | gate names renamed throughout `apps/web/src/lib/kernelReplica.ts` | `unattributed-store-read` | **YES** — `4 → 5` |
| P3 | same, **code lines only, all 2 docstring mentions left intact** | `unattributed-store-read` | **YES** — `4 → 5` |
| P4 | same code-only strip on `apps/mobile/.../MobileClientProvider.tsx` | `unattributed-store-read` | **YES** — `4 → 5` |
| C1 | one gate's conformance case turned into `it.skip` | `assertGatesCovered` | **YES** — "1 Phase-2 sync gate condition(s) have no test", named |

Two harness refusals are worth recording as evidence the harness itself works: an attempt to
plant M8 on a non-unique anchor and an attempt to plant S2 on a wrong occurrence count were
both **rejected before touching the file** by the match-count assertion. A mutant that never
applied reports the same green as a detector that missed.

---

## §1 — What refuses

### R1. Two of the four acceptance criteria are UNWRITTEN, not merely unexecuted

AC1 (runbook) and AC3 (quantitative checks) are documentation deliverables that this issue
owes and that do not exist:

- `docs/rearchitecture-v3.md:450` promises "This document, Phase 2 section (runbook
  committed by POD-310)". **There is no runbook.** The only occurrences of the word in the
  file are the three forward-references that promise one.
- `docs/rearchitecture-v3.md:1193-1197` states the ledger obligation in the imperative:
  *"quantitative release-criteria THRESHOLDS are fixed in this section during Phase 2
  (measured at POD-337)"* — cold startup, DB growth rate, sync lag, outbox age +
  dead-letter count, gap-heal time, bootstrap snapshot time, reconnect-storm behaviour,
  render counts, memory per pane, zero-data-loss crash tests. **No threshold value is fixed
  anywhere in the Phase 2 section.** Grepping lines 1176–1596 for numeric budgets returns
  the *criteria names* and the switch-latency *methodology*, and no numbers.

This one matters more than it looks. POD-337 is written to *measure against thresholds fixed
here*; if Phase 2 exits without fixing them, POD-337 has nothing to compare to and will
either invent them at gate time — which is marking your own homework — or discover the gap at
the very end of the programme. **Fixing the thresholds is genuinely Phase-2 work and is
genuinely not done.** It also does not need the VPS, so unlike the rehearsal it is not
blocked by anything.

### R2. `audit:phase2-client` is RED with four sites and NO open issue owning them

`bun run audit:phase2-client` exits **1**. Three of its four items are ZERO; the fourth,
`unattributed-store-read`, stands at 4 of 6 composition roots:

```
apps/web/src/lib/desktopReplica.ts:135          (file's only issue marker: POD-789)
apps/web/src/lib/shadow/runner.ts:110           (POD-1223)
apps/web/src/lib/webReplica.ts:63               (POD-1223, POD-1239, POD-307, POD-377/378)
packages/client-core/src/replica/legacy-snapshot.ts:124   (POD-377)
```

The brief describes this as "RED BY DESIGN — two of six closed". The two closures are real
and I proved it rather than reading it (P3/P4 above: stripping the gate call from *code only*,
leaving every docstring mention intact, moves the count 4 → 5 in each). **But "red by design"
requires a design that names an owner, and there is no owner.** `podium issue search --text`
returns exactly one issue for this item — **POD-1239, which is `done`** — and nothing for
"unattributed". The item is red, it is not on anyone's list, and the phase that owns it is
being asked to exit. A red with no ticket is indistinguishable from a red nobody noticed.

Note the sharper point, which the detector cannot see and which is recorded in its own
source: `packages/client-core/src/replica/legacy-snapshot.ts` is **platform-neutral shared
code and cannot host its own fix** — attribution needs the current principal, which
client-core has no way to know. POD-1239's recorded resolution for the identical case was to
*move the construction* to a platform file. So that site is not "one more of the same"; it is
a site whose fix is a relocation someone must decide on.

### R3. The AC's literal sentence cannot be satisfied, by Phase 2's own design

AC4 reads "Phase-2 audit items all zero". The deletion audit maps exactly four items to
Phase-2 children (`--phase POD-308` / `POD-309`):

| Item | Phase | Count | Status |
|---|---|---|---|
| `publish-computed-fanout` | POD-308 | **0** | verified, anchored, mutation-proven |
| `upstream-sync-forwarder` | POD-309 | **0** | verified, anchored, mutation-proven |
| `legacy-wire-v1-adapter` | POD-308 | **6** | **non-zero BY DESIGN until Phase 7** |
| `change-row-typings` | POD-308 | **12** | ratchet, non-zero |

`bun run audit:rearch --phase POD-309` → **exit 0, "clear to close"**.
`bun run audit:rearch --phase POD-308` → **exit 1**, naming both non-zero items.

So POD-308 — a *closed* Phase-2 child — cannot pass its own phase-close gate, and the
recorded rule in `docs/rearch-deletion-audit.md` is unconditional.

**This is a contradiction in the plan, not a defect in the tree.** POD-308's *job* was to
create `legacy-wire-v1-adapter`: a temporary N/N-1 translation whose expiry is declared as
data (`expiresWhenMinSupportedReaches: 2`, `deleteByPhase: 'POD-279 Phase 7'`) and whose
retirement is Phase 7's. An item that Phase 2 is *supposed* to birth non-zero is mapped to a
Phase 2 issue and graded by a rule that says Phase 2 may not close while it is non-zero.

**I did not re-phase it.** Moving `legacy-wire-v1-adapter` from POD-308 to POD-337 would make
this gate pass, and a gate that edits a mapping in order to close itself is precisely the
"instrument that cannot say NO", one level up — the defect this whole run is about. Escalated
to the coordinator instead, with a recommendation in §5.

### R4. The oracle is RED — but the RED is the named flake, held to the standard

`bun scripts/oracle.ts` → **exit 1**: typecheck GREEN, **unit RED (394s)**, integration GREEN
(82s), e2e GREEN (22s), multi-instance GREEN (17s).

The unit lane's node project passed clean — **603 files, 8747 tests**. The single failure was
`apps/web src/features/setup/RepoScanFlow.machine.test.tsx`, one of the flakes the brief names
(POD-1238, web-lane contention). I did not accept that on the brief's word, because
pass-after-the-fact is a coin flip: **`bun run test:web` re-run three times in isolation was
`179 passed (179)`, exit 0, all three times.** That is consistent with contention and not with
a real defect, so R4 does not independently hold the gate shut — but the oracle's recorded
result at this commit is exit 1 and an exit gate does not get to quietly relabel that.

---

## §2 — What actually holds, verified rather than quoted

Everything below was re-measured on this tree, not read off a child's report.

| Lane / gate | Result |
|---|---|
| Workspace typecheck, `--force` | **exit 0** — `23 successful, 23 total` / **`Cached: 0 cached, 23 total`** / 57s (the oracle's own typecheck lane was a 1s cache hit; this is the uncached evidence) |
| `bun run audit:rearch` | **exit 0** — 30 items, **180 sites**, baseline exact. No rebaseline performed by this gate |
| `audit:{seam,wire-adapters,serving-path,scoped-feed,router-mutations,derived-families,durable-classes,declared-consumers,machine-grants,browser-reach,client-secrets}` | **11/11 exit 0** (each runs `--probe` first) |
| `check-boundaries` / `check-no-nul-bytes` | exit 0 (56 allowlisted, 0 new) / exit 0 |
| Sync conformance, **all three instantiations** | **exit 0 — 21 files, 225 tests** |
| oracle integration / e2e / multi-instance | GREEN / GREEN / GREEN |
| `audit:phase2-client` | **exit 1** — see R2 |
| `audit:rearch --phase POD-308` | **exit 1** — see R3 |

### The hub seam is preserved, not built

`audit:seam` exits 0 and I broke it four different ways on real source (S1′, S3, S4, R above)
to establish that it can refuse. Its five ADR-5-D8 elements are present in **code**, not just
in prose — I checked that specifically by stripping comments and re-counting every token:
`interface FeedIdentity`, `readonly feedId`, `readonly epoch`, `ChangeProvenanceFields`,
`originId`, `causationId`, `mutationId`, `role: 'node'`, `reason: 'role-not-implemented'` all
have at least one live code occurrence. The reserved node role **refuses**
(`role-not-implemented`) and the audit fires if it is made to return `ok: true` — so nothing
in Phase 2 shipped federated product behaviour, and the retirement guard fires on a re-grown
`upstreamMirrorFor`. **The seam is genuinely a seam.**

### The conformance suite is a closed set with a totality test

`PHASE_2_SYNC_GATES` registers **28** gate conditions as data, including all six the POD-289
AC names as gate conditions: `scoped/grant-mid-session`, `scoped/revoke-mid-session`,
`scoped/gap-heal-exact-slice`, `scoped/revoked-offline-with-queued-writes`,
`scoped/slow-scoped-replica-converges`, `scoped/crash-with-watermark-in-flight`. It is keyed
on stable ids rather than test titles, so renaming a test cannot silently un-register a gate;
it counts **per instantiation**, so one hop cannot borrow another's coverage; and
`assertGatesCovered` throws rather than returning a boolean. Three instantiations drive it
(in-memory, IndexedDB, mobile-SQLite) and all three are in the unit lane. C1 proves it reports
a miss by name.

### The legacy adapter is a scheduled retirement, not permanent debt

Confirmed as the brief asked. The expiry is **data, not a docstring**:
`expiresWhenMinSupportedReaches: 2` with `deleteByPhase: 'POD-279 Phase 7'` and a written
rationale. The condition is a fact about the support floor — `MIN_SUPPORTED_VERSION` is
currently **1**, so the expiry has not arrived — and `audit:wire-adapters` enforces the
coupling in **both** directions: its probes confirm it fires on "expired adapter still
present", on "expiry is only a docstring", on "adapter declares itself permanent", on a call
site outside the allowlist, on the detector losing its control string, **and** on
`floor-follows-deletion` (the adapter deleted without raising the floor). That is a real
scheduled retirement with a named, mechanical condition. **It is not quiet permanent debt.**

---

## §3 — Findings the mutation campaign produced

### 3.1 — A mis-aimed mutant of my own, recorded because it nearly became a false finding

My first S1 mutant renamed `readonly epoch` → `readonly epochRenamed` and the seam audit
stayed **green**. The detector was never challenged: the check is `source.includes('readonly
epoch')`, and `readonly epochRenamed` still *contains* that substring. Re-aimed as a real
deletion (`readonly epoch: string` → `readonly generation: string`), S1 fired immediately.
A green from a mutant that did not actually remove the thing is not evidence of anything.

### 3.2 — REAL FINDING: `audit:seam` S2 is satisfied by a docstring

**Deleting `causationId` from the change schema leaves `bun run audit:seam` GREEN.**

`packages/model/src/fields/change.ts:131` is the live schema field. Line 119 is a **comment**
that happens to contain the word. `changeProvenancePresent` tests `source.includes(token)`
against the **raw file text**, so the comment alone satisfies the check. Isolated by
counterfactual: renaming only the schema field → green (S2′); renaming the field *and* the
comment word → `S2-origin-causation` fires (S2″).

Two of S2's four tokens are prose-shadowed this way — `causationId` and `mutationId` — and
`causationId` is, by the check's own docstring, *"the one most likely to be dropped: nothing
in H1 reads it except overlay retirement, so 'unused field' is a plausible cleanup, and it is
precisely the field a future hub needs for loop prevention."* The check names its own most
likely failure and then cannot see it.

**This is latent, not live** — I verified every S2/S1/S3 token has a real code occurrence
today, so the seam does hold. And the fix is already present *in the same file*:
`retirementHolds` (line 306) strips comments before matching. The technique is known and
simply is not applied to the four presence checks. **This does not hold the gate shut** — the
seam is intact today — but it is exactly the class of defect this run exists to catch and it
should be an issue.

### 3.3 — CORRECTION: "main has 7, this branch has 12" is not a comparison

The brief asks me to say plainly that Phase 2 exits with a `change-row-typings` count the
other branch beats. **Measured, that turns out to be false, and in the opposite direction.**

The two numbers come from **two different detectors asking two different questions**:

- **main's** `change-row-typings` counts *exported names in the change-row family* over the
  roots `['packages/protocol/src/messages/sync.ts']` — **one file**. Main has no
  `scripts/change-row-audit.ts` at all.
- **this branch's** counts *hand-restated change-row field lists* — an `op` key beside ≥2
  other change-vocabulary keys — repo-wide. It was **redefined at POD-305**, and the redefinition
  commit is explicit that the code did not change, the detector's definition did.

Different unit, different population, different scope. So I ran **this branch's detector
against both trees**: checked main out into a throwaway detached worktree, pointed
`loadContext(repoRoot)` at it, and called `changeRowRestatements` on each.

```
HEAD (integration)   change-row-typings (HEAD detector) = 12
main                 change-row-typings (HEAD detector) = 22
```

**Under the same instrument the integration branch is at 12 and main is at 22.** The rewrite
has removed ten restatements, not added five. The "7" is main's old single-file name-count and
is not commensurable with anything on this branch. The throwaway worktree was removed and
pruned; `git worktree list` and `git status` are clean.

I am recording this rather than repeating the premise because an exit gate that passes a
misleading number through is doing the opposite of its job — and because a ratchet file is a
*measurement*, so the only way to compare two of them is to re-run one tool over both trees.

**This correction lands on a live coordination belief, so it needs to reach POD-1246.** The
ledger's section *"The rewrite branch is not ahead on every axis — measured, against my own
claim"* records exactly two keys where integration is said to regress against main:

```
    change-row-typings   integration 12   main 7
    local-placeholders   integration 16   main 12
```

Both figures are read off the two branches' **baseline files**, i.e. two different
instruments' outputs. Re-measured with **one** instrument (integration's) over **both** trees:

| key | detector identical across branches? | ledger's figures | one instrument, both trees |
|---|---|---|---|
| `change-row-typings` | **NO** — redefined at POD-305; main has no `change-row-audit.ts` | integration 12 / main 7 | **integration 12 / main 22** — integration is ahead by 10 |
| `local-placeholders` | **YES** — byte-identical `collect` | integration 16 / main 12 | **integration 16 / main 15** — integration is behind by 1 |

So the ledger's conclusion is **wrong on the first key and overstated ~4x on the second**. Its
own bullet already anticipated this — *"THE DETECTOR SETS DIFFER (30 integration / 23 main /
32 union), so 'lower per key' is not even well-defined until the SCRIPT merges"* — and the
prose above that bullet then asserts the regression as fact anyway. The bullet was right.

The `local-placeholders` gap is worth one further note, because it is not a stale baseline and
someone will otherwise assume it is: **main's own audit on main's own tree is `baseline
exact` (22 items, 259 sites, exit 0).** Main's `12` is a *true* count under *main's*
instrument; integration's instrument counts `15` on that same unmodified tree. The +3 is a
difference in the measuring apparatus (`grep`/`loadContext`), not drift in the code. Which
means the ledger's own recorded rule — *the baseline is a measurement of the merged tree, not
a merge decision* — is the operative one for both keys, and neither branch's baseline file
should be taken wholesale on the strength of a per-key comparison that was never like-for-like.

The causal story the ledger tells for the regression (main's POD-797 deleted the legacy local
issues wire; integration rebuilt it) may still be true as a description of the code. What the
measurement refutes is the *inference from the numbers* — those two baseline figures cannot
support it, because they were not produced by the same instrument.

### 3.4 — The two closed client sites are genuinely closed

Recorded because "two of six closed" is the kind of claim a no-op could satisfy. Both closures
survive the sharp counterfactual: stripping `decideLegacyAdoption` / `migrateLegacyReplica` /
`LegacyIdentityEvidence` from **code lines only**, leaving every docstring mention intact,
moves the count 4 → 5 in each root. Unlike the seam's S2, this detector runs on
`withoutCommentsOrStrings(source)` — so prose does not hold it up. The rows are discarded, not
no-op-passed.

---

## §4 — The live rehearsal, and why not attempting it is the correct outcome

**AC2 is not attempted, deliberately, and this is not timidity.** The rewrite is not on main:
`issue/279-integration` is ~830 ahead / ~81 behind, and the catch-up (POD-1246) has resolved
36 of 109 conflicts. A live upgrade rehearsal today would rehearse upgrading the running
instance to a branch that the remaining **73 conflicts will materially change** — the
rehearsal would be invalidated by its own prerequisite before anyone read the evidence. It
also needs the real VPS, a physical phone and deploy credentials, which no autonomous agent
can self-serve.

The correct sequencing is: finish POD-1246 → write the runbook and fix the thresholds (R1,
neither of which needs hardware) → then book the human for a rehearsal that measures something
that will still be true afterwards.

**What is NOT excused by that**, and what I want on the record so it is not lost when the
rehearsal is eventually scheduled: R1's runbook and thresholds are blocked by *nothing*. They
were owed by Phase 2 regardless of when the hardware becomes available.

---

## §5 — What the coordinator must decide (I did not decide these)

1. **`legacy-wire-v1-adapter`'s phase mapping (R3).** Its expiry points at Phase 7 and its
   retirement condition is POD-337's; its deletion-audit mapping points at POD-308. One of
   the two is wrong. **Recommendation: re-phase it to POD-337 with the reason recorded**, the
   mechanism the codebase already used to move `change-row-typings` from POD-302 to POD-308.
   The alternative — amending AC4's wording — hides the same fact in prose. **I did not do
   this myself; a gate that re-phases to let itself close is a detector that cannot say NO.**
2. **`change-row-typings` at 12 (R3).** Also mapped to POD-308 and also non-zero. §3.3 shows
   it is a healthy ratchet (22 → 12 against main under the same instrument), but "ratcheting
   well" is not "zero". Either re-phase with a reason, or accept it and say so in the ledger.
3. **An owner for the four `unattributed-store-read` sites (R2).** Three are platform files
   that can host their own fix; the fourth (`client-core/src/replica/legacy-snapshot.ts`)
   structurally cannot and needs a relocation decision.
4. **Whether `audit:seam` S2's prose-shadowing (§3.2) is fixed now or filed.** One-line fix,
   already-present technique.

---

## §6 — Limits: what a green run here does NOT mean

1. **`publish-computed-fanout` and `upstream-sync-forwarder` are anchored on control
   STRINGS, not on surviving code.** That is the correct design for a zeroed detector and
   both anchors were proven to throw (M2–M7). But the anchor proves the *pattern* still
   matches text it was written to match; it cannot prove the pattern is still the *right*
   pattern. A fan-out re-grown under a different name is invisible to both.
2. **`publish-computed-fanout` scans `apps/server/src` only.** Justified in-source (all
   thirteen original sites were there, so a home outside it would be a relocation). M4 proves
   the root is real; it does not prove the fan-out could not live elsewhere.
3. **The conformance gates are a closed set, and closed sets can be incomplete.** The
   totality test proves every *registered* gate has a test. It cannot know about a gate
   nobody registered.
4. **Conformance runs against three STORAGE instantiations, not against a second hop.** That
   is exactly what "hub deferred" means and S5 keeps the suite parameterized — but "one suite
   runs against every instantiation" is today a claim about three storage adapters.
5. **`audit:seam` is a text-presence gate.** It asserts the seam's *elements exist*, not that
   they are *wired correctly*. §3.2 is the sharp end of that.
6. **The oracle result quoted here is exit 1**, and my three isolated green web-lane runs are
   evidence about contention, not a repair. POD-1238 is still open.
7. **Measured at `7f01445d`, now 10 behind the base.** I audited the drift (docs + one lint
   script) and it touches nothing measured, but the next gate should re-measure rather than
   cite these numbers.

---

## Re-running everything behind this verdict

```bash
bun install
bun run typecheck --force                       # 23/23, 0 cached
bun run audit:rearch                            # 30 items / 180 sites, baseline exact
bun run audit:rearch --phase POD-309            # exit 0 — clear to close
bun run audit:rearch --phase POD-308            # exit 1 — R3
bun run audit:phase2-client                     # exit 1 — R2
bun run audit:seam                              # exit 0 (probe first)
bun run audit:wire-adapters                     # exit 0 — the expiry is mechanical
bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts \
    --project node packages/sync/src/conformance packages/sync/src/adapters   # 21 files / 225 tests
bun run test:web                                # 179/179 in isolation (POD-1238 under contention)
bun scripts/oracle.ts                           # exit 1 — unit, via RepoScanFlow only
```
