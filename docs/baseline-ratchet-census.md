# The ratchet census — which committed numbers can be raised silently

POD-3904, measured at `50aa8a50b` on `issue/3904-ratchet-that-accepts-a-raise`.

POD-3903 filed one finding: `scripts/audit-ambient-principals.ts` is described and
run as a ratchet, but its expectation is a literal in the file the gate reads, so a
regression and a fix produce the same green. The question this document answers is
whether the rest of the repository's guardrails are the same shape.

They largely are, and the reason is more interesting than the count: **a sibling
test is not protection.** Four of the seven threshold constants that have one are
tested *relative to themselves*.

---

## How this was derived

Three passes, none of which match a spelling. A literal search under-reported four
separate times while this issue was being worked, and one of those four was my own
first pass.

1. **Runtime import.** Each script imported in its own subprocess, every exported
   value walked structurally for finite numbers and array lengths.
   26 of 27 `scripts/audit-*.ts` imported; `audit-declared-consumers.ts` was killed
   by the OOM killer (exit 137) and is covered by passes 2 and 3 only.
2. **AST parse of data declarations** (`typescript` 6.0.3): every top-level
   `const`/`let`, exported or not, whose initializer is a literal.
3. **AST parse of comparisons**: every numeric literal that is an operand of
   `<  >  <=  >=`, plus every numeric literal passed as an argument to a
   locally-declared function that compares one of its own parameters.

**Pass 3 exists because passes 1 and 2 both missed `scripts/web-bundle-budget.ts`
entirely.** Its eight byte ceilings are inline arguments — `atMost('eager raw
bytes', report.eager.raw, 1_650_000)` — not declarations, so a census of declared
constants reports that file as carrying no baseline at all. It carries eight.

A fourth pass over `scripts/*.test.ts` classifies each sibling test as **PINNED**
(it asserts the constant against a literal, so an edit to the constant fails the
test) or **FLOATING** (it writes `CONSTANT ± n`, so it moves with the constant).

---

## Correction to the filing brief

The brief said 16 of the 27 `scripts/audit-*.ts` have a sibling `.test.ts`. At
`50aa8a50b` it is **17 of 27**. The ten without one are `ambient-principals`,
`declared-consumers`, `federation-seam`, `fleet-commands`, `god-objects`,
`issue-commands`, `machine-grants`, `mail-commands`, `migration-drift` and
`settings-commands`.

Everything else the brief asserted was re-derived and holds:

| Brief's claim | Re-derived |
| --- | --- |
| `checkDrift` is two-sided; a matching baseline returns `[]` | Confirmed, and kept as a test in `audit-ambient-principals.test.ts` |
| No `scripts/audit-ambient-principals.test.ts` | Confirmed absent at `50aa8a50b`; added by this issue |
| CI runs only the audit against its own in-repo baseline | Confirmed, `.github/workflows/ci.yml` line 57 before this change |
| The baseline rose 41 → 46 at `b12b5bae6` (POD-1669) | Confirmed by reading the literal at each commit that touched the file: **45 → 41 → 46 → 46 → 42** |

The `20556752d` fix the brief cites (re-baselining 42 → 38) is **not an ancestor of
this branch** — it is on `issue/3903-stale-ambient-principal-baseline`. On this
branch the measured count is 40 against a baseline of 42, which is
`ambient-principal-baseline-stale` and **red before this issue's first commit**
(verified by running the unmodified script from a detached worktree at HEAD:
exit 1). This issue does not re-baseline; that is POD-3903's deliverable and
editing the same literal from two branches would collide.

---

## The census

**(a) impossible** — no committed number to raise.
**(b) possible, but a sibling test pins the value**, so the raise is a failing test.
**(c) possible and silent** — nothing anywhere compares the number to its old self.

### Numeric baselines in `scripts/audit-*.ts`

| Script | Committed number | Sibling test | Verdict |
| --- | --- | --- | --- |
| `audit-ambient-principals.ts` | `BASELINE.firstAdminMemberId = 42` | none | **(c)** → fixed by this issue |
| `audit-god-objects.ts` | `THRESHOLD = 600`, 28 × `GOD_OBJECT_LEDGER[].budget` (750–2300), private `MAX_METHOD_LINES = 180`, `MAX_SURFACE_STATE = 2`, `MAX_COUPLED_STATE = 12`, `MIN_ARGUMENT = 180` | none | **(c)** |
| `audit-telegram-binding.ts` | private `MIN_SCANNED_FILES = 500` | exists, does not mention it | **(c)**, but it is a coverage floor — *lowering* it is the escape, not raising |
| `audit-mail-commands.ts` | private `PROBE_COUNT = 17` | none | probe bookkeeping, not a gate over the tree — **(a)** for this purpose |
| the other 23 | none | — | **(a)** |

So within the filed scope the answer is short: **two real ratchets, both (c), and
only one of them is in CI.**

`audit:god-objects` is in `package.json` and in no workflow file — and the script's
own line 11 says *"The gate also runs as a TEST (`audit-god-objects.test.ts`) so CI
executes it."* **That file does not exist.** It was 206 lines and was deleted at
`c1eb67a10` ("Restore all verification lanes", 2026-08-11), an ancestor of HEAD. The
gate has documented a route into CI that has not existed for a month. That is the
POD-1369 class the ambient-principal CI step was itself added to answer, and it is
filed as POD-3907.

### The same shape outside `scripts/audit-*.ts`

Scoping the census to the `audit-` prefix would have missed most of the family.

| Script | Committed number | Sibling test | Verdict |
| --- | --- | --- | --- |
| `web-bundle-budget.ts` | 8 byte ceilings, inline: eager raw 1_650_000 / gzip 520_000 / brotli 447_000 / source 7_000_000, settings raw 105_000 / gzip 30_000 / brotli 26_000 / source 280_000 | none | **(c)** — and its own comments record the ceilings being raised repeatedly (`7_700_000 → 7_800_000 → …`), each time by a convention identical to the one POD-1669 followed |
| `rearch-audit.ts` (the CI "deletion audit ratchet") | `DAEMON_COMPOSITION_ROOT_MAX_LINES = 300` | **FLOATS** (`… + 1`) | **(c)** |
| `rearch-audit.ts` | `RETAINED_REPRESENTATIONS.length` | **PINNED** `.toBe(46)` | **(b)** |
| `entity-id-audit.ts` | `MIN_ID_FIELD_SITES = 1800` | **FLOATS** (`… + 10`, `toBeGreaterThan(MIN_ID_FIELD_SITES)`) | **(c)** — a floor, so the escape is lowering it |
| `verify-client-build.ts` | `CLIENT_FILE_FLOOR.web = 400`, `.mobile = 30` | **FLOATS** (`… + 5`, `… - 1`) | **(c)** — floors again |
| `audit-durable-classes.ts` | `DURABLE_STORES.length` (an allow-list, 100 entries) | **FLOATS** | **(c)** |
| `representation-audit.ts` | `ENTITY_SHAPE_THRESHOLD = 3`, `NOT_A_REPRESENTATION.length` | **PINNED** `.toBe(3)`, `.toBe(39)` | **(b)** — the only threshold in the repo a test actually pins |
| `change-row-audit.ts` | `CHANGE_ROW_THRESHOLD = 2` | references it, does not pin | **(c)** |
| `server-construction-order.ts` | private `ENROLLMENT_THRESHOLD = 40` | exists, does not mention it | **(c)** |
| `store-coverage-census.ts` | the committed census **markdown**, read back by `censusDrift()` | exists | **(b)-ish**, and the closest thing in the repo to the two-file shape POD-3903 suggested |

### The headline

Of the ten threshold constants that live beside a sibling test, **exactly one
threshold is pinned by it** (`ENTITY_SHAPE_THRESHOLD`). The rest are written
relative to the constant under test:

```ts
CLIENT_FILE_FLOOR.web - 1            // verify-client-build.test.ts
MIN_ID_FIELD_SITES + 10              // entity-id-audit.test.ts
DAEMON_COMPOSITION_ROOT_MAX_LINES + 1 // rearch-audit.test.ts
```

Those are good tests of the **check**. They say nothing about the **number**, and
they stay green when it moves. So the brief's category (b) — "possible but caught
by a sibling test" — is very nearly empty, and "add a sibling test" would not on
its own have been a fix for POD-3904. That is why this issue did not ship one alone.

Note also that half the family are **floors**, not ceilings (`MIN_ID_FIELD_SITES`,
`CLIENT_FILE_FLOOR`, `MIN_SCANNED_FILES`). They have the identical weakness pointing
the other way: a coverage floor is silenced by *lowering* it. The mechanism below is
written in terms of direction-of-travel against history, so it covers both, but only
the ambient-principal ceiling is wired up by this issue.

---

## What was built

`scripts/baseline-ratchet.ts`. The measured count is still compared against
`BASELINE`; what is new is that `BASELINE` is compared against **the value on the
commit this branch started from**, which the working tree cannot edit.

- `baseRevision()` — `merge-base HEAD origin/main`, falling back to local `main`,
  and to `HEAD^` when HEAD *is* the merge base (otherwise a run on `main` compares
  the file with itself and can never say no). `PODIUM_RATCHET_BASE` overrides.
  The merge base and not the tip, so a sibling landing a legitimate *lowering* on
  main does not paint an untouched branch red.
- `constantsIn()` — parses the baseline out of the base commit's source with the
  TypeScript AST. No spelling match, and no executing code from another commit.
- `checkRaise()` — a rise needs a `RaiseAuthorisation` naming `from` (the value on
  the base commit), `to`, an issue, and a reason of at least 40 characters. **An
  author cannot fill in `from` without looking up what they are raising.**
- Two escapes that are not a raise are closed with it: `baseline-key-disappeared`
  (a rename carries the value across — demonstrated: `FIRST_ADMIN_USER_ID` became
  `firstAdminMemberId` still holding 46) and `baseline-enforcement-dropped`
  (the key stays, the `enforced: true` beside it does not).
- When history cannot be read — shallow clone, no integration branch, not a repo —
  the run says so by name and `--require-base` turns it into a failure. CI passes
  `--require-base` and its checkout now uses `fetch-depth: 0`.

`probe()` gained planted fixtures for all four new checks, and for the two ways an
authorisation can be a rubber stamp (wrong `from`, one-word reason).

## What was not done

- **`audit-god-objects.ts` was not wired back into CI, and its deleted test was not
  restored** (POD-3907). Nor were the other ratchets converted: The module is written to be reusable and they are the obvious next
  adopters; `web-bundle-budget.ts` has the most history of raises. Filed separately.
- **The floors were not converted.** `checkRaise` guards direction-of-travel upward;
  a floor needs the mirror, which is a small addition and a separate argument.
  *(Closed by POD-3906 — see "The mirror" below.)*
- **The baseline was not re-based to 40.** POD-3903 owns that literal.
- One escape remains and is not closed: renaming the *export* (`BASELINE` itself)
  rather than a key inside it moves the comparison to a name the base commit does
  not have, and the run then reports "no `BASELINE` there" rather than failing. It
  is visible in the printed output on every run, and it is a multi-file diff, but
  it is not mechanically refused.
  *(Closed by POD-3906 for every number in the committed-floor census, by a
  different route — see "The mirror" below.)*

---

## The mirror — POD-3906

`checkRaise` is now `checkBaseline` and takes a **per-key direction**. A
`ceiling` is POD-3904's shape (the measurement must stay at or below the number,
so raising it is the escape); a `floor` is the mirror (it must stay at or above,
so *lowering* it is). There is deliberately **no default**: an enforced key with
no declared direction is reported as `baseline-direction-undeclared`, because a
guessed direction would reintroduce this whole issue one level up — add a floor,
forget to declare it, and lowering it to zero is unguarded again.

**Why the direction is per key and not per instrument.** One instrument can hold
both. `audit-ambient-principals.ts` caps how many places assume a default user,
and could equally carry a floor under how many files its scan must reach before
that count means anything.

**The evidence that the gap was real, not theoretical.** The single
`BaselineAuthorisation` in the repository records `FIRST_ADMIN_USER_ID` 46 →
`firstAdminMemberId` 42 → 38. Three movements, every one of them DOWNWARD, and
`checkRaise` only ever compared upward. The instrument's entire recorded history
was travel in the direction it did not guard.

### Where the floors live now

`scripts/audit-committed-floors.ts` (`bun run audit:committed-floors`, which runs
`--probe` then the real arm, as `audit:ambient-principals` does). A census rather
than a check inside each instrument, because these four have no gate to hang one
on: `entity-id-audit.ts`'s own `main` is a report and its gate lives in
`rearch-audit.ts`, `verify-client-build.ts` has no `main` at all, and the floor in
`audit-telegram-binding.ts` is enforced from inside a scan function. **None of the
four guarded scripts was modified** — the census reads their numbers out of git and
out of the working tree — which also keeps it clear of POD-3905 and POD-3907.

| Number | Direction | Read off |
| --- | --- | --- |
| `entity-id-audit.ts:MIN_ID_FIELD_SITES` = 1800 | **floor** | `out.length < MIN` throws |
| `verify-client-build.ts:CLIENT_FILE_FLOOR` = {web 400, mobile 30} | **floor** | `fileCount < FLOOR[label]` throws |
| `audit-telegram-binding.ts:MIN_SCANNED_FILES` = 500 | **floor** | `wholeTree.size < MIN` throws |
| `baseline-ratchet.ts:MIN_REASON_LENGTH` = 40 | **floor** | `reason.length >= MIN` admits the authorisation |
| `server-construction-order.ts:ENROLLMENT_THRESHOLD` = 40 | **ceiling** | `statements.length < threshold` SKIPS the body |
| `rearch-audit.ts:DAEMON_COMPOSITION_ROOT_MAX_LINES` = 300 | **ceiling** | `lineCount <= MAX` returns no finding |
| `change-row-audit.ts:CHANGE_ROW_THRESHOLD` = 2 | **ceiling** | `matched >= THRESHOLD` counts the row |
| `representation-audit.ts:ENTITY_SHAPE_THRESHOLD` = 3 | **ceiling** | below it, the site is skipped |

### A correction this issue owes its brief

POD-3906's filing brief listed **`ENROLLMENT_THRESHOLD` among the floors. It is a
ceiling.** Bodies *below* it are skipped, so the escape is raising it — 40 → 400
makes the next unwatched wiring body invisible, which is the exact failure
(`wireSessionLifecycle`, POD-1411) the audit was built for. This document's own
census never called it a floor; it listed it as category (c) without a direction,
and the direction was supplied wrongly downstream. That is the argument for making
`direction` a required field that names the comparison it was read off, rather
than something a reader infers from the constant's name.

### The census is itself checked

A hand-kept list is a list that rots, which is its own way of reporting a green
that checked nothing. So: a baseline-shaped constant anywhere under `scripts/`
that is neither registered nor excused **fails**; an exclusion or a registration
naming a constant that no longer exists **fails**; and every exclusion carries a
written reason. Registration-staleness is what closes the export-rename escape
listed above — rename `MIN_ID_FIELD_SITES` to anything at all and the entry stops
resolving, whether or not the new name matches the naming convention.

The scan's limits are named rather than assumed away: it cannot see a bound
spelled as a list's `.length` (`DURABLE_STORES.length`), nor one written inline at
its comparison (`web-bundle-budget.ts`'s eight byte ceilings). Both are in the
table above this section; neither is in the scan. The first spelling of the
pattern also missed `THRESHOLD` (no prefix) and `DAEMON_COMPOSITION_ROOT_MAX_LINES`
(`_MAX_` in the middle) — both of which this document had already listed — which is
why the prose column exists.
