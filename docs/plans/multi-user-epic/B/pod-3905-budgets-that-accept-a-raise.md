# POD-3905 — Budgets that accept a raise

Receipt. Everything below was re-derived in this worktree; where a number is
quoted from a brief rather than reproduced, it is labelled.

- Branch `issue/3905-budgets-that-accept-a-raise`, deliverable at **1bec35f4f**
- Branched from **223218f5f** (`origin/issue/pdm-107-multi-user`, resolved by
  `git ls-remote`, not taken from the brief)
- Default ratchet base on this branch: `merge-base HEAD origin/main` = **89574f1c8**

## What was done

Eight byte ceilings in `scripts/web-bundle-budget.ts` and twenty-eight review
budgets in `scripts/audit-god-objects.ts` could each be edited upward to turn a
red gate green, with nothing comparing either number against its previous value.

They did **not** get a second mechanism. POD-3906's `audit-committed-floors.ts`
already reads guarded numbers out of the base commit; both sets were invisible
to it for one reason — neither had a *name*. An inline call argument has none,
and an array element is addressed by an index that shifts on reorder. So:

| | before | after |
|---|---|---|
| `web-bundle-budget.ts` | 8 inline literals | one `WEB_BUNDLE_BUDGET` record |
| `audit-god-objects.ts` | `budget:` inside 28 array elements | `GOD_OBJECT_BUDGET` keyed by module path |
| census | 9 numbers | **50** |

The census's five `NOT_A_COMMITTED_BASELINE` entries that POD-3906 had left
open by name for this issue (`THRESHOLD`, `MIN_ARGUMENT`, `MAX_SURFACE_STATE`,
`MAX_COUPLED_STATE`, `MAX_METHOD_LINES`) became registrations.

**No verdict changed.** The god-object audit reports the same 97 findings, byte
for byte, before and after the hoist (`diff` of the two runs is empty apart from
the probe banner).

Splitting the budget out of the entry cost the one thing a single object had for
free, so `checkLedgerBudgets` fails both drifts — an entry with no budget is a
module nothing bounds; a budget with no entry is a number the ratchet guards and
no audit reads. Both are planted in `--probe`.

Both gates got their **first sibling test**. `web-bundle-budget.ts` cannot be
imported (it reads `apps/web/dist` at module scope — its own header records that
this is why it never had a test), so its test parses it exactly as the census
does, and asserts no `atMost()` call has gone back to an inline literal.

## The decision the coordinator asked me to argue

> *guard the budgets as they stand, or say they cannot be guarded until they
> mean something?*

**Guard them.** The 20-of-28 blown budgets are the argument *for* guarding, not
against, and the ledger's own history settles it rather than my judgement.

Replaying `GOD_OBJECT_LEDGER` across all 17 commits that have touched that file
(`scripts/ledger-history` replay, reproduced below in *Evidence*):

```
entries added 5 · entries REMOVED 1 · budgets RAISED 4 · budgets lowered 0
```

Three of the four raises sit in commits whose **own subject line says what the
raise was for**:

| commit | subject | raise |
|---|---|---|
| `00a343f96` | *fix(scripts): restore package-gate guardrail audits on main* | `machines/rpc.ts` 1000 → 1200 |
| `cdfb02424` | *fix(scripts): clear the two red audits on main* | `store/issues.ts` 1000 → 1100, `server.ts` 800 → 900 |
| `c1eb67a10` | *Restore all verification lanes* | `machines/service.ts` 800 → 850 |

None carries a re-review; the `review:` field beside each still names the
original POD-1385 sitting. This is not a hypothesis about the future — it is the
recorded behaviour of this exact number, four times, in the author's own words.

So the coordinator's worry — *"a ratchet placed on top of them would freeze a
number nobody believes"* — inverts the situation twice:

1. **The ratchet does not freeze the number, it prices it.** A raise is still
   available; it costs a record naming the old value, the new value, an issue
   and a reason ≥40 characters.
2. **A blown budget is the debt marker, not noise.** `server.ts` at 2451 against
   a budget of 900 is a claim that 1551 lines of growth were never re-reviewed.
   Raising it to 2451 does not make the number meaningful — it launders the
   unreviewed growth into "reviewed" and erases the marker. Freezing the last
   *honestly reviewed* figure is exactly right.
3. **The pressure lives where the budget is already red.** A budget comfortably
   met has no raise pressure. All 20 live invitations are on blown ones.

And the master escape is not a budget at all: `THRESHOLD = 600` selects the
population. Raising it does not argue with a finding, it deletes them. Measured:
at `THRESHOLD = 4000` the audit reports **0** items instead of 97 — a one-token
diff. That number is now guarded, and is guarded *today* (see below).

## What is guarded today, and what waits for the landing

PDM-325's claim is real and I reproduced it on my own work: `checkBaseline`
skips a key absent on the base commit (`if (was === undefined) continue`), and
the base is `merge-base(HEAD, origin/main)` for the life of the epic.

| numbers | at base `89574f1c8`? | guarded on this branch now |
|---|---|---|
| `THRESHOLD`, `MIN_ARGUMENT`, `MAX_SURFACE_STATE`, `MAX_COUPLED_STATE`, `MAX_METHOD_LINES` | yes — never renamed | **yes, 5 numbers, proven live** |
| `GOD_OBJECT_BUDGET` (28), `WEB_BUNDLE_BUDGET` (8) | no — new names | **no, 36 numbers, until this lands** |

Proven both ways: raising `THRESHOLD` with no override fires
`baseline-raised-without-authorisation` and exits 1; raising a `GOD_OBJECT_BUDGET`
entry with no override exits 0 and reports nothing. The 36 become live the moment
this reaches a commit that becomes the base. The mutation evidence for them below
uses `PODIUM_RATCHET_BASE=1bec35f4f` and is **labelled as such** — it demonstrates
the mechanism, it does not claim the branch is guarded.

## Findings

### F1 — a retired baseline key has no authorisation that clears it
`baseline-ratchet.ts` (PDM-325's file). A key present at base and absent now
yields `baseline-key-disappeared`, and **no** `BaselineAuthorisation` clears it:
a retirement without `renamedTo` is ignored, and a `renamedTo` pointing at a
key that does not exist is relabelled as a *raise* against a phantom. Proven by
executing `checkBaseline` directly, three shapes.

Why it matters here specifically: `GOD_OBJECT_BUDGET` is keyed per module, and
**decomposing a module — the outcome the audit exists to produce — removes its
key.** A ratchet that punishes its own desired outcome, unrecordably, teaches
people to delete the census entry.

Measured frequency before calling it urgent: 1 removal in 17 commits, and that
one (`issues/registry.ts` at `6d04f98d7`, re-added at merge `1f664e8c5`) is a
branch-merge blip, not a decomposition. So: **real, rare, not blocking.**
Suggested repair for whoever owns that file — accept a retirement authorisation
with `renamedTo` omitted, so a decomposition can be recorded as one.

### F2 — the brief's "the export-rename escape is closed, so re-derive the inline claim"
Re-derived: **the original claim stands.** Two different escapes. The census's
registry self-check closes *rename* (a renamed export surfaces as
`committed-baseline-unregistered` plus `…-registration-stale`). It does nothing
for *inline arguments*, because a convention over **names** cannot match a value
that has none — `audit-committed-floors.ts` says exactly this in its own header,
naming `web-bundle-budget.ts` as the example. The only available repair was to
give the eight a name, which is what this issue did. That header paragraph has
been updated, since its example is no longer true.

### F3 — corrections to the brief and the coordinator addendum
All re-derived in this worktree:

- **"POD-3906/3907 LANDED."** Their branch *tips* (`169a8c910`, `004f80efd`) are
  ancestors of neither `origin/main` nor the epic branch. The *content* landed as
  rebased commits on `origin/issue/pdm-107-multi-user` @ `223218f5f`. My branch
  was **62 commits behind** that and carried none of it; fast-forwarded first.
  Nothing of POD-3904/3906/3907 is on `origin/main`.
- **"92 findings at origin/main"** (author-reported) → **97** at the epic head:
  41 `unexplained-god-object`, 36 `exception-predicate-failed`, 20
  `review-budget-exceeded`, 0 `stale-ledger-entry`. The "36 oversized modules
  with no ledger entry" is now **41**.
- **"20 of your 28 budgets already blown"** → **confirmed exactly, 20.**
- Individual figures have drifted: `server.ts` 2307 → **2451**, `relay.ts`
  3592 → **3630**, `messages/service.ts` 2994 → **2996** (all vs unchanged
  budgets 900 / 2300 / 2100).
- **"28 ledger budget entries, 750–2300"** → confirmed: 28 entries, 28 *distinct*
  file keys, min 750, max 2300. (A naive `grep -c "budget:"` gives 32 — four are
  probe fixtures. Worth noting since that is how the figure would be re-checked.)
- **"eight ceilings at lines 549-551 and 691-695"** → confirmed, exactly 8.
- **API names in the brief are stale**, renamed by POD-3906:
  `checkRaiseAgainstBase` → `checkBaselineAgainstBase`, `RaiseAuthorisation` →
  `BaselineAuthorisation`, `checkRaise` → `checkBaseline`.
- **"census registers nine numbers"** → confirmed 9; now **50**.

## Evidence

Commands as run, in this worktree, tree clean at `1bec35f4f` unless a mutation is
named. Exit codes are the command's own.

| # | command | exit | covered |
|---|---|---|---|
| E1 | `bun run audit:committed-floors` | **0** | probe + gate; 50 numbers guarded |
| E2 | `bun scripts/audit-god-objects.ts --probe` | 0 (probe line) | every check found its planted fixture *and spared the clean one* |
| E3 | `bun scripts/audit-god-objects.ts` | **1** | 97 findings — identical set to pre-hoist |
| E4 | `bun scripts/validation-admission.ts focused -- … vitest run … audit-god-objects.test.ts web-bundle-budget.test.ts audit-committed-floors.test.ts baseline-ratchet.test.ts` | **0** | **4 files, 77 tests passed** |
| E5 | `bun run typecheck -- --filter @podium/scripts --concurrency=1` | **0** | 17/17 tasks; scope justified below |

**E5 scope, written before running:** only `scripts/` changed, and
`grep -rn` over the tree confirms nothing outside `scripts/` imports these three
modules (`apps/web`'s build string invokes `web-bundle-budget.ts` as a CLI, with
its arguments unchanged). `@podium/scripts` is therefore the smallest justified
package. No source file was added to `apps/server`, so the shard manifest needed
no regeneration.

**E5 was exit 137 twice before it passed.** A 137 is the machine killing the
process, never the compiler's opinion, so both are reported as **not-run**, not
as failures. The third attempt — same tree, same command, every other package a
cache hit so `@podium/scripts` ran alone — returned 17/17 and exit 0. Box load
average was ~26 on 7 cores from sibling sessions throughout. The `test:heavy`
lease was held for E5 and released the moment the lane ended.

### Mutation evidence — every new guard proven able to say NO

A gate whose negative case is never exercised is not evidence when it says yes.
Each mutation was applied to the committed tree and restored with `cp`.

With `PODIUM_RATCHET_BASE=1bec35f4f` *(labelled: this override is what makes the
36 new keys comparable at all today — see "guarded today" above)*:

| mutation | census says |
|---|---|
| `GOD_OBJECT_BUDGET['…/server.ts']` 900 → 2500 | `baseline-raised-without-authorisation  audit-god-objects:GOD_OBJECT_BUDGET.apps/server/src/server.ts` |
| `THRESHOLD` 600 → 4000 | `baseline-raised-without-authorisation  audit-god-objects:THRESHOLD` — and the audit drops 97 → **0** findings |
| `MIN_ARGUMENT` 180 → 0 | `baseline-lowered-without-authorisation` — the **floor** direction, firing downward |
| `WEB_BUNDLE_BUDGET.eager.sourceBytes` 7_000_000 → 7_800_000 (the exact historical raise) | `baseline-raised-without-authorisation  web-bundle-budget:WEB_BUNDLE_BUDGET.eager.sourceBytes` |

With **no override**, i.e. what holds on this branch right now:

| mutation | census |
|---|---|
| `THRESHOLD` 600 → 4000 | fires, **exit 1** |
| `GOD_OBJECT_BUDGET['…/server.ts']` 900 → 2500 | silent, exit 0 — key absent at base (F1/PDM-325) |

The two new tests, proven armed rather than merely green:

| mutation | result |
|---|---|
| re-inline `budget: 3700` into the `relay.ts` ledger entry | `audit-god-objects.test.ts` → **1 failed, 11 passed**, on *leaves no budget written inline in a ledger entry* |
| re-inline `30_000` into the settings-gzip `atMost()` call | `web-bundle-budget.test.ts` → **1 failed, 7 passed**, on *passes every atMost() its budget by name* |
| break `checkLedgerBudgets`' orphan arm | `--probe` → `THE INSTRUMENT IS BROKEN — budget-orphaned missed its planted violation` |

Each mutation failed exactly one test, so the tests are targeted rather than
blanket, and each restored cleanly (`git status --porcelain` empty after every
round).

### Ledger history replay (source of the argument above)

```
9f3b190ba 2026-08-02  n=24  (first)
37e716a11 2026-08-02  + issues/registry.ts @ 1400
6d04f98d7 2026-08-02  + messages/service.ts @ 2100   - issues/registry.ts  <-- merge blip
1f664e8c5 2026-08-02  + issues/registry.ts @ 1400
65634712c 2026-08-03  + store/messages.ts @ 750
00a343f96 2026-08-07  ^ machines/rpc.ts      1000 -> 1200   <-- RAISED
cdfb02424 2026-08-07  ^ store/issues.ts      1000 -> 1100   <-- RAISED
                      ^ server.ts             800 ->  900   <-- RAISED
c1eb67a10 2026-08-11  ^ machines/service.ts   800 ->  850   <-- RAISED
9a3c05ba2 2026-08-16  + operations/engine.ts @ 800
```

## What I did NOT do

- **Did not touch `scripts/baseline-ratchet.ts`** — PDM-325 owns it. F1 is a
  finding against that file, not a change to it.
- **Did not add a `BaselineAuthorisation`** for any of the 20 already-blown
  budgets. Retro-authorising them would be inventing a review that never
  happened; the ratchet compares against the base commit, not full history, so
  none is needed.
- **Did not re-review or adjust any budget value.** Every number is exactly
  where it was; only its address changed.
- **Did not run a whole-package or full-suite lane.** Four named test files and
  one filtered typecheck, for the reasons written above.
- **Sent no mail.** Standing instruction from the user on this work is to report
  to them directly rather than to other sessions; F1 is written up here for
  whoever picks it up instead.

---

## Addendum — two inbound claims, re-derived (2026-09-13, after the work landed)

Three messages arrived after the deliverable stood. One was already satisfied;
two change what a rebase of this branch costs. Each claim below was re-derived
here rather than relayed.

### A1 — "your worktree is cut from the wrong base" (issue:#107)
**Already done, before any code was written.** The worktree was at `50aa8a50b`;
it was fast-forwarded to `223218f5f` (`origin/issue/pdm-107-multi-user`, resolved
with `git ls-remote`) as the first act of this issue. All work sits on top of
POD-3904, POD-3906 and POD-3907. No action.

### A2 — after PDM-325 lands, 36 of these keys will need a genesis record
PDM-325 is adding `baseline-introduced-without-authorisation`: a key enforced but
absent at the base commit will require a `BaselineAuthorisation { key, from: null,
to, issue, reason }`. That is the same hole this receipt reports under "What is
guarded today" — it is being closed, which is good, and it has a price here.

Re-derived split, by `git show 89574f1c8:scripts/audit-god-objects.ts`:

| keys | at base | cost after PDM-325 |
|---|---|---|
| `THRESHOLD` 600, `MIN_ARGUMENT` 180, `MAX_SURFACE_STATE` 2, `MAX_COUPLED_STATE` 12, `MAX_METHOD_LINES` 180 | present, **and every value identical to HEAD** | **free** — ordinary raise/lower path |
| `GOD_OBJECT_BUDGET` (28) + `WEB_BUNDLE_BUDGET` (8) | absent — new export names | **36 genesis records** |

**These cannot be written today.** `BaselineAuthorisation.from` is typed
`readonly from: number` at `223218f5f`; `from: null` does not exist until PDM-325
lands. So the 36 records are work for whoever rebases this branch past it, and
they are the *intended* cost of registering a new key, not a defect in this work.
Nothing here needs redesigning to accommodate them — same ledger, same shape.

**Textual conflict risk: none expected.** PDM-325 states it touches only `probe()`
in `audit-committed-floors.ts`, in the block between the last `expect(...)` call
and the comment beginning "A lowering authorised at the WRONG `from`". This issue
did not touch `probe()`. It did move `qualify` *above* `COMMITTED_BASELINES` in
that file (it is now called from the census via `everyKeyIs`, so it can no longer
be declared after it — a temporal-dead-zone error otherwise). That is a move, not
an edit, and it is nowhere near their hunk.

### A3 — `audit:committed-floors` runs in no CI workflow — **confirmed**
Independently re-derived, not taken on report. `grep` over `.github/workflows/*.yml`
at this head returns exactly five audit steps — `audit:rearch`,
`audit:ambient-principals`, `audit:expand-only`, `audit:hidden-reads`,
`audit:migration-drift` — and the string `committed-floors` appears nowhere under
`.github/` at all. `audit-committed-floors.test.ts` never calls
`auditCommittedBaselines` (0 references), so the comparison-against-git executes
in CI by **no route**. `audit:god-objects` is likewise absent, which is POD-3907's
finding standing unrepaired.

**What this does and does not do to this issue's claims.** It does not change a
single verdict reported above: every run here was executed locally and its exit
code recorded. It does mean the sentence "the census now guards 50 numbers"
describes a gate nobody runs on a pull request yet.

One thing partly offsets it, and only partly: the two sibling tests added here
call `checkBaseline` directly (2 and 4 call sites), and `@podium/scripts` tests do
run in CI's unit-tests job — so the *refusal mechanism* for these ceilings gains a
CI route it did not have. But those tests build a synthetic base out of the
working tree, so they prove the machinery refuses a raise; they do not compare
this branch against `origin/main`. Only `audit:committed-floors` does that, and it
runs nowhere. **Wiring it into a workflow is not in this issue's scope and should
not be inferred from this receipt; it is named here so nobody reads "50 numbers
guarded" as "50 numbers guarded in CI".**

### A4 — PDM-325 is built; the genesis cost measured exactly, and it is 37, not 36

PDM-325 reports its change built at `ec055a80c` on `issue/pdm-325-genesis-record`.

**I could not execute it.** That branch is on no remote reachable from here
(`git ls-remote` against both `origin` and `flatblock` returns nothing matching
`pdm-325`/`genesis`), the object `ec055a80c` is not in this repository, and there
is no sibling worktree holding it. So nothing below is a run of their code — it
is their rule, which is fully specified, evaluated against the base commit
`89574f1c8`, which I can read. Labelled as derived, not reproduced.

Every key in `COMMITTED_BASELINES` at this head, split by whether it exists at
that base:

| | count |
|---|---|
| present at base → ordinary raise/lower path, **no genesis record** | **13** |
| absent at base → **one `BaselineAuthorisation { from: null }` each** | **37** |

All 13 present keys carry values **identical** at base and head, so none of them
takes a raise or lower path either — and the shape PDM-325 named as the one real
bug in their change (a genesis finding for a key that *is* on the base commit)
cannot arise from this branch.

**The 37 is one more than either of us predicted, and the extra one is not mine.**

- 36 are this issue's: `GOD_OBJECT_BUDGET` (28) and `WEB_BUNDLE_BUDGET` (8).
- **1 is `MIN_REASON_LENGTH`** — POD-3906's registration of the ratchet's own
  floor, which lives in `scripts/baseline-ratchet.ts`. That file **does not exist
  at `89574f1c8`** (`git cat-file -e` fails), so its key is absent at base exactly
  as mine are.

So PDM-325's gate fires on an **already-landed registration in PDM-325's own
file**, independent of this issue: the epic branch needs that record even if
POD-3905 is never merged. That is the gate working correctly, not a defect — but
it means "eight genesis keys for the web-bundle hoist" understates the landing
cost, and the first red after PDM-325 lands will include a key whose owner is
neither of us. Worth knowing before it is read as my bug.

PDM-325's specific #2 — which they said they had deliberately not checked rather
than report a number they had not seen printed — is **confirmed, per key**:

```
THRESHOLD          base 600  head 600  same
MIN_ARGUMENT       base 180  head 180  same
MAX_SURFACE_STATE  base   2  head   2  same
MAX_COUPLED_STATE  base  12  head  12  same
MAX_METHOD_LINES   base 180  head 180  same
```

All five are present at `89574f1c8` with unchanged spellings and unchanged
values, so all five are free.

The 36 records still cannot be written here: `BaselineAuthorisation.from` is
typed `readonly from: number` at `223218f5f`, so `from: null` does not compile
until PDM-325 lands. The full enumerated list of 37 keys with their `to` values
is derivable in one command from this head — iterate `COMMITTED_BASELINES`,
`qualify(constantsIn(git show 89574f1c8:<path>, exportName))`, and take the keys
the base does not have.

---

## A5 — the genesis records, written (the work the landing sent back)

The coordinator landed the naming work and returned the issue, correctly: this
receipt had said the 36 keys "go live when this lands". They did not go live —
they reported as violations, and a number that reports as a violation is not
guarded, only visible. Done now, at the integrated tree.

**Reproduced before writing anything.** `bun scripts/audit-committed-floors.ts
--require-base` at `b9fad5911`: **36 `baseline-introduced-without-authorisation`
+ 1 `baseline-base-unavailable`**, exactly the split the coordinator measured.

**Correction to A4 above:** A4 called all 37 "one `BaselineAuthorisation
{ from: null }` each". The count and the identification of the 37th were right;
the *kind* was not. The 37th is `baseline-base-unavailable`, not a genesis
finding, because `scripts/baseline-ratchet.ts` is missing at the base **as a
whole file** — so `base === null` and `checkBaseline` returns before it consults
any authorisation.

### The 37th cannot be repaired with a record — tested, not assumed

The coordinator offered: *if it is a one-line record you can write correctly,
take it; otherwise leave it.* It is not. I added a well-formed genesis record for
`MIN_REASON_LENGTH` and re-ran:

```
baseline-base-unavailable  baseline-ratchet      exit=1      (unchanged)
```

There is no per-key remedy because the defect is not per-key: the file is absent,
so no key in that instrument has a base to be compared against. It resolves when
`scripts/baseline-ratchet.ts` exists at the merge base — i.e. when the epic
reaches `main` — or under `PODIUM_RATCHET_BASE`. **Left for the coordinator to
place, as offered.**

### 36 records, and four of them refuse to argue

All 36 written into `BASELINE_AUTHORISATIONS`. `--require-base` now reports **0**
genesis findings; the only remaining finding is the 37th, which is not mine.

Each reason carries that key's own measured facts rather than a shared sentence:

- **20 budgets are recorded as debt markers.** Each names its own gap — e.g.
  `server.ts` starts at **900 while the module measures 2451**, and the reason
  says that starting at 2451 would silence `review-budget-exceeded` and launder
  1551 unreviewed lines into "reviewed" in one edit. This is the receipt's own
  argument for guarding, put where the gate enforces it.
- **8 budgets are recorded as live ceilings with headroom** (e.g.
  `issues/registry.ts` 1394/1400 — six lines of room), carried forward unchanged.
- **4 eager bundle ceilings cite real measurements** — the POD-2730 paydown's
  1,458,334 / 460,501 / 395,176 / 6,189,048 and the clearance each left.
- **4 settings ceilings are FLAGGED, not argued.** Replaying all 29 commits that
  have touched `web-bundle-budget.ts`, `settings.raw/gzip/brotli/sourceBytes`
  have **never moved**, and unlike their eager siblings they carry no comment, no
  measured headroom and no paydown. The file records nothing about where 105,000
  / 30,000 / 26,000 / 280,000 came from. Their records fix the value and say
  exactly that — no endorsement. **Flagged to the coordinator as asked:** these
  four are the ones to spend a build on re-deriving. Writing a confident sentence
  for them would have been the rubber stamp the ledger exists to refuse.

### The records are load-bearing — mutation-tested

| mutation | result |
|---|---|
| a record's `to` changed 900 → 2451 (the laundering value) | genesis finding returns for `server.ts` (and `store/sessions.ts`, which shares the value) |
| one reason shortened below `MIN_REASON_LENGTH` | genesis finding returns for `WEB_BUNDLE_BUDGET.eager.sourceBytes` |
| one record deleted | genesis finding returns for `GOD_OBJECT_BUDGET.…/relay.ts` |

So the records cannot be satisfied by a placeholder, a stale number, or an
absence.

### A second correction to this receipt: "seven movements" was an undercount

This receipt and the code comment both said the eager source ceiling had moved
**seven** times, read off the call-site prose. Replaying all 29 commits from git
gives **fifteen** (nine upward), and six each for the other three eager ceilings.
The prose undercounts because a comment is written by whoever moved the number,
and a merge that moves it back is nobody's edit to narrate. Corrected in
`web-bundle-budget.ts`, with that gap noted there as its own argument for reading
a baseline out of git rather than out of a comment.

### Confirmed, not relayed: the `@podium/scripts` lane does run in CI

`.github/workflows/ci.yml:390` — `- name: unit tests (cached package tasks)` runs
`bun run test:full`. So the two sibling tests added by this issue execute in CI.
`audit:committed-floors` itself still runs in no workflow (POD-3908).

### Verification at the integrated tree

| command | exit | covered |
|---|---|---|
| `bun run audit:committed-floors` | **0** | probe + default gate |
| `bun scripts/audit-committed-floors.ts --require-base` | 1 | **0 genesis findings**; the one remaining is the 37th, not this issue's |
| `bun scripts/audit-god-objects.ts` | 1 | 97 findings — 41/36/20, unchanged by the records |
| focused vitest, 4 ratchet files | **0** | **4 files, 89 tests passed** (77 before; +12 from PDM-325's own additions) |
| `biome check` on both changed files | 0 | clean |
