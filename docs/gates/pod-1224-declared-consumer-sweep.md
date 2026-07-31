# POD-1224 — Declared policy fields with no consumer: the repo-wide sweep

**Headline: 113 declarative annotations swept, 23 have a consumer, 90 do not.**

POD-352 found three instances inside one subtree. The sweep finds ninety. The
class, from `docs/agents/rewrite-fanout-ledger.md`:

> A DECLARATION WITH NO CONSUMER IS INDISTINGUISHABLE FROM AN ENFORCED ONE.

The single sentence a reader needs: **all 32 command contracts declare a
confirmation rule, an error-consistency answer, an attribution policy, an
ownership rule, an outbox-reconciliation rationale and an apply-time
re-authorization rationale, and not one of those six is read by any code that
runs in production.** They are asserted by tests, which is not enforcement.

A gate exists, it is sound, and it is proven to say NO. Details in §4.

---

## 1. Method, and why the obvious method is the one that fails

### 1.1 Not a grep

POD-1203 measured the naive implementation failing: matching the bare identifier
flagged eight files, **all of them comments explaining a deletion**. A text
search cannot separate `policy.roleFloor` from "we removed roleFloor" in a doc
comment, from `'roleFloor'` in a string, or — worst — from `roleFloor: 'admin'`,
which is the *declaration*, the very thing whose consumer is being looked for.
Every unread field has dozens of declaration sites. A grep gate on this class
does not merely have false positives; it passes on exactly the evidence that
proves the defect.

The detector (`scripts/declared-consumers.ts`) resolves references through the
**TypeScript checker**. Comments and string literals are not property references
in the AST, so comment-immunity is structural rather than pattern-tuned. Three
positions are distinguished, and the distinction is the whole check:

| Position | Example | Counts as a consumer? |
|---|---|---|
| READ | `contract.policy.roleFloor`, `const { roleFloor } = policy`, `policy['roleFloor']` | **yes** |
| WRITE | `roleFloor: 'admin'` in an object literal | no — this is the declaration |
| TYPE | the property signature itself | no |

Reads inside the **declaring module** do not count, and reads inside **tests** do
not count. Both are reported separately rather than silently dropped. The
justification is POD-352's own precedent: `contract.ts` lints
`redaction.reviewed !== true`, and POD-352 still correctly called `redaction`
"declared and read by nothing", because a lint that validates a declaration is
not a consumer of it — it changes no behaviour.

### 1.2 A resolved reference still only proves PRESENCE — the mutation pass

POD-279 supplied the method upgrade mid-sweep, from POD-423's merged Phase 1 exit
gate:

> A grep for the consumer proves a REFERENCE EXISTS. It does not prove the
> reference DECIDES anything — a consumer that reads a field and then ignores its
> value greps identically to one that acts on it.

A checker-resolved reference is strictly stronger than a grep and is still only
presence. So the 23 CONSUMED verdicts were re-tested by **mutating the declared
value in real source and requiring an outcome to change**, with POD-423's
hygiene: one mutant per call, match count asserted, file hash verified changed,
planted text grepped back, reverted atomically, tree confirmed clean.

**Result: 7 fields mutated with correct aim, 7 REFUSED.** The detector's
CONSUMED column survived value mutation with no false pass.

| Field | Mutation | Instrument | Tests run | Verdict |
|---|---|---|---|---|
| `contract CommandPolicy.roleFloor` | `admin` → `member` | settings/authz.test.ts | 34 | **REFUSED** |
| `contract CommandPolicy.action` | `read` → `write` (on the read+secret contract) | settings/authz.test.ts | 34 | **REFUSED** |
| `contract CommandPolicy.resource` | `secret` → `global` | settings/authz.test.ts | 34 | **REFUSED** |
| `contract DeliveryPolicy.class` | `offline-eligible` → `online-only` | settings/write-plan.test.ts | 21 | **REFUSED** |
| `contract RedactionPolicy.inputPaths` | `['value']` → `[]` | redaction.test.ts | 24 | **REFUSED** |
| `MatrixRow.conflict` | `field-LWW` → `exp-rev` (prefs-instance row) | packages/model | 514 | **REFUSED** |
| `MatrixRow.offline` | `offline-eligible` → `never-enqueue` (prefs-instance row) | classification.test.ts | 19 | **REFUSED** |

### 1.3 The mirror hazard, measured: a MIS-AIMED mutation manufactures a false "nothing decides"

Four of these first came back **green**, and green would have been reported as
"the consumer does not decide" — a finding that would have argued for deleting a
working control. Each was a mis-aimed mutation, not a finding:

- `policy.action` / `policy.resource` — `settings/authz.ts:136` branches only on
  the conjunction `action === 'read' && resource === 'secret'`. The first
  mutation targeted an `action: 'write'` contract, so neither half of the
  conjunction could change. Re-aimed at the one `read`+`secret` contract
  (`contracts.ts:739`): **REFUSED**.
- `MatrixRow.offline` — `settings/classification.ts` reads only the three
  settings-tier rows. The first mutation targeted `issueCore`, which that
  consumer never looks at. Re-aimed at `preferencesInstance`: **REFUSED**.
- `MatrixRow.conflict` — `arbitration.test.ts` selects rows *by rule*
  (`rowWith('exp-rev')`), so it is robust to any single row's rule changing, by
  design. Re-aimed with `packages/model` as the instrument: **REFUSED**.

This is worth recording beside POD-423's finding as its mirror. POD-423 showed a
mutation catching a declaration nothing acted on. This shows the same technique
producing a **false** "nothing acts on it" when the mutation misses the row or
the conjunction the consumer actually reads. **A green mutation is only evidence
if you have shown the instrument covers the mutated value.** Both mutation
results here were only trustworthy after checking what the consumer reads.

### 1.4 Two limits of the detector, both stated rather than hidden

**One-hop.** A field read by an accessor *inside its own declaring module* looks
unread, because reads in the declaring module are excluded by design. The
accessors were therefore resolved by hand:

| Accessor | Product callers? | Consequence for its field |
|---|---|---|
| `isExposedOn` / `commandExposure` | **yes** — relay.ts:958, sessions/trpc.ts:379/418, presence-registry.ts:396 | `CommandDef.exposure` is CONSUMED; the detector's "unread" is wrong |
| `visibilityClassOf` | **yes** — aggregates/registry.ts, representations/checks.ts, settings/classification.ts | `MatrixRow.visibility` CONSUMED |
| `conflictRuleFor` | **yes** — sync authority/arbitration.ts:170 | `MatrixRow.conflict` CONSUMED |
| `commandVisibility` | **no** — tests only | `CommandDef.visibility` genuinely unconsumed |
| `grantVerbsOf` | **no** — tests only | `MatrixRow.grants` genuinely unconsumed |
| `isTenantVisible` | **no** — tests only | unconsumed |
| `permitsFieldLww`, `requiresExpectedRevision`, `FIELD_LWW_CLOCK` | **no** — tests only | unconsumed |

**Casts.** `apps/server/src/modules/fleet/authz.ts:200` enforces the machine verb
through `(policy as { machineVerb?: MachineVerb }).machineVerb`. The cast erases
the symbol link, so the checker sees a read of a fresh anonymous type and the
semantic count is zero — a false unread on a field that is genuinely enforced.
The detector therefore reports a **shadowed reads** bucket (same spelling,
different symbol) so this surfaces for review instead of standing as a confident
zero. That is how `machineVerb` was caught.

### 1.5 The false negative this nearly shipped with

The first working detector reported `CommandPolicy.roleFloor` as having **zero**
product reads. That is false — `settings/authz.ts` enforces it, and it is one of
POD-352's original three that POD-421 fixed.

The cause was module resolution. This worktree has no `node_modules`, so
`@podium/model` resolved **up and out into the neighbouring main checkout** at
`/home/mgw/src/other/podium`, and `@podium/commands` did not resolve at all.
Every cross-package read was invisible and the detector reported a confident,
entirely wrong zero for the whole fleet — this class's own failure mode, turned
on the instrument.

Resolution is now pinned (explicit `paths` over the workspace globs, subpath
exports included — mapping only bare package names still leaked 87 files) and
then **asserted**: `assertInstrumentHealthy` refuses to report unless every
workspace package resolved inside this checkout AND a canary field with a known
cross-package consumer is observed being consumed.

**Sibling-relevant:** a git worktree without its own `node_modules` silently
resolves `@podium/*` into the main checkout. Any tool a sibling builds that
resolves modules itself has this hazard.

---

## 2. What was searched — so the next person can tell coverage from luck

**Declaring modules swept** (every `PropertySignature` in each, 113 after
excluding structural plumbing — `input`, `__out`, the reducer's parameter bag):

| Module | What it declares |
|---|---|
| `packages/commands/src/contract.ts` | ADR 3 D1 command contract: policy (action, roleFloor, resource, confirmation, machineVerb), exposure, delivery, redaction, ownership, attribution, errorConsistency, visibility |
| `packages/commands/src/framework.ts` | the earlier `CommandDef` and POD-380's four facets (policy, exposure, offline, redaction) plus conflict, decision, visibility |
| `packages/model/src/annotations/ownership.ts` | `MatrixRow` — ADR 1 D4's ownership-matrix columns, plus `OwnerRule`, `GrantRule`, `AttributionRule`, `InheritanceOnCreate`, `VisibilityMutability` |

**Search scope:** every tracked `.ts`/`.tsx` under `packages`, `apps`, `services`,
`scripts`, `tooling`, `tests` — 5,338 source files in one TypeScript program.

**Also checked by hand, outside the property sweep:** the exclusion lists and
named constants (`MACHINE_USE_OFFLINE_EXCEPTIONS` — empty, and its emptiness is
asserted; `SERVED_NOWHERE`; `LOCK_COMMAND_NAMES` — no product reader), the matrix
resolver functions (table in §1.4), and the existing ratchet idiom
(`scripts/rearch-audit.ts` + `rearch-audit-baseline.json`,
`scripts/audit-scoped-feed.ts`).

**Not covered, and named so nobody assumes otherwise:**

- **Structural consumption.** A field reached by `JSON.stringify(contract)`,
  `{...policy}` or `Object.entries` is consumed without being named. The detector
  cannot see this. It fails toward *over*-reporting unread, which is the safe
  direction for a ratchet but means a baseline entry can be wrong.
- **Deferrals recorded by issue name.** In-code `POD-xxx` deferral markers were
  not swept as a population; only those attached to the three declaring modules.
  This is the one part of the brief's "for every declarative annotation" I did
  not complete, and it should be a follow-up.
- Zod schema fields, DB columns, and config keys are out of scope.

---

## 3. The disposition table

Every one of the 90 is argued individually in
**`scripts/declared-consumers-baseline.json`** — key → argument. Grouped here.

### 3.1 The split POD-279 asked for: "read only by tests" is NOT "read by nothing"

| Group | Count | What it means | Usual disposition |
|---|---|---|---|
| **G1 — read by tests only** | 54 | The field is asserted somewhere, so somebody cared; nothing in production consults it | (a) ship the consumer |
| **G2 — read only by the declaring module's own lint** | 1 | `CommandContractBase.version` | (a) or (b) |
| **G3 — read by nothing at all** | 35 | No reference of any kind outside its declaration | (b) delete, or (c) retire on a schedule |

### 3.2 (a) SHIP THE CONSUMER — the field claims a behaviour nothing performs

The sharpest results, each argued on its own terms:

- **`contract CommandPolicy.confirmation` — the single sharpest result.** ADR 3
  D2's confirmation rule for destructive or out-of-scope writes, declared on
  every contract, **read by nothing of any kind**. A real confirmation mechanism
  exists — `issue-authz`'s `overrideScope` → confirm-required, and the outbox's
  `confirmation-required` refusal with a durable `EnvelopeConfirmation` — but it
  is keyed off issue scope, *not* off this field. So the contract column is a
  second, inert statement of a policy that is enforced elsewhere by different
  means. That is worse than absent: a reader auditing the contract sees a
  confirmation rule and reasonably concludes it governs.
- **`contract ErrorConsistency.callerSuppliedTargetId` and `.invisibleFailsAs`** —
  Amendment 1 D20's existence-oracle rule. Zero readers. Handlers decide
  invisible-vs-nonexistent individually, which is precisely the ad-hoc state D20
  was written to end. `.distinguishesUnauthorizedFromUnreachable` is read only by
  the contract lint, so readiness M5 has no runtime enforcement either.
- **`contract CommandContractBase.visibility`** — POD-382 made this required on
  every contract as "the question a scoped feed and a share dialog both ask".
  Neither asks it: the scoped feed reads the *matrix* through `visibilityClassOf`.
  The contract copy is inert, and the two can drift with nothing to notice.
- **`MatrixRow.grants`** — `grantVerbsOf` exists and is correct but has no product
  caller; grant checks run off `identity/grant`. The matrix column is
  documentation of a rule enforced somewhere else.
- **22 further `contract` columns** (attribution pair, ownership/inheritance,
  outbox reconciliation, apply-time re-authorization, redaction review flag …) —
  same shape: declared on all 32 contracts, asserted by tests, enforced nowhere.

### 3.3 (b) DELETE

- **`framework CommandDef.visibility`** — superseded by `contract.ts`'s
  `visibility`; its only reader `commandVisibility` is called by tests alone.
  Two visibility declarations, neither enforced, is strictly worse than one.

### 3.4 (c) SCHEDULED RETIREMENT — counted by the ratchet

Recorded the way POD-308's `legacy-wire-v1-adapter` and POD-1077's
`DeviceGradeUnscopedPolicy` are: named owner, named deletion condition, counted
so the cost of the window is visible.

- **14 × `framework.ts` `CommandDef` facets** — owner **POD-311**, deletion
  condition: `CommandDef` is folded into `contract.ts` and the file is deleted.
  POD-380's four facets (`offline`, `conflict`, `redaction.fields`, `decision`)
  are read by nothing but tests on the legacy contract type. These should not be
  given consumers; they should die with the file.
- **28 × `MatrixRow` and its rule types** — owner **POD-385 / POD-1194**, deletion
  condition: the column gains a resolver with a product caller, or is struck from
  `MatrixRow`. ADR 1 D4 columns, asserted by `matrix.test.ts`, read by no runtime
  code: `home`, `idMinting`, `writers`, `tombstone`, `systemWriter`,
  `inheritanceOnCreate`, `reservedConflict`, `interimDefect`, `open`, `sites`,
  `section`, and the rule types' members.
- **17 × required free-text justifications** (`note`, `rationale`, `reason`,
  `*Note`) — owner **none**, deletion condition **none**, and this is a
  deliberate keep. Their only job is to force an author to argue, and the
  contract lint that rejects an empty string is their whole enforcement. They are
  correctly "unread" and must never be cited as controls. They are counted anyway
  so the ratchet's number is honest.
- **2 × detector limits** — `CommandDef.exposure` (consumed via `isExposedOn`) and
  `contract CommandPolicy.machineVerb` (consumed via a cast). Recorded in the
  baseline so nobody deletes a working control on the strength of a zero.

---

## 4. The gate

**A sound gate IS possible.** `scripts/audit-declared-consumers.ts` — a ratchet
over `scripts/declared-consumers-baseline.json`, 90 entries, each with its
argument. It counts **declared-but-unconsumed**, so the number rises when someone
adds a facet with no consumer; a ratchet that counted *consumers* would reward
deleting declarations, which is the wrong incentive.

### 4.1 Proven to say NO, on the real tree

Per POD-423: *"a detector that only fires on its own fixture proves the fixture,
not the tree."* So the proof was run on real source, with full hygiene (hashes
verified, planted text grepped back, reverted atomically, tree confirmed clean).

| Step | Tree state | Gate |
|---|---|---|
| baseline | unmodified | **exit 0** — 90 unread, no new ones |
| plant `CommandPolicy.auditFloorProbe` in `contract.ts`, no reader | mutated | **exit 1** — names the new field |
| add a file comment mentioning `auditFloorProbe` three times, incl. `policy.auditFloorProbe` | mutated | **exit 1 — still refuses** |
| replace the comment with a real read `policy.auditFloorProbe === 'no'` in `settings/authz.ts` | mutated | **exit 0** |
| revert both files | clean | **exit 0** |

Row 3 is the point. **This is POD-1203's measured failure mode, reproduced at
repo scale and defeated.** The gate is not fooled by prose that names the field,
including prose in the exact `policy.<field>` form a grep would match.

### 4.2 And proven to say YES about its own classifier

`scripts/declared-consumers.test.ts` — 11 tests, all passing, each a pair of
"finds the real read" and "declines the lookalike": comment, string literal,
declaration site, same-named property on an unrelated type, test-file read,
declaring-module read, and a cast-erased read landing in the shadowed bucket.

The probe earned its place: it **found a real defect** — destructured reads
(`const { roleFloor } = policy`) resolve to the new local binding, not the
property, so every destructuring consumer was being counted as unread. Fixed by
resolving the property off the type being destructured.

### 4.3 Wiring, and an honest gap

Added to `package.json` as `audit:declared-consumers`. **It is not yet in
`.github/workflows/ci.yml`.** That matters more than usual here: CI runs
`audit:rearch`, `lint:architecture` and `lint:no-nul`, and **none of the other
twenty `audit:*` scripts**. A gate nothing invokes is the same defect one level
up. The unit-lane test (§4.2) does run in CI; the repo-wide ratchet does not
until a step is added. It takes ~60s (one TypeScript program over 5,338 files),
which is why it belongs in its own step rather than bolted onto the fast lint
job — this is a decision for the coordinator, not one to take unilaterally
against a shared CI file mid-fan-out.

---

## 5. Count

| | |
|---|---|
| Annotations swept | **113** |
| With a consumer | **23** (+2 by hand: cast- and accessor-mediated) |
| **Without a consumer** | **90** |
| — read by tests only | 54 |
| — read by the declaring lint only | 1 |
| — read by nothing at all | 35 |
| Value-mutation checks on consumed fields | 7 aimed, **7 refused** |
| Mis-aimed mutations that produced a false green | 4, all corrected |
| Known instances before this sweep | 3 (POD-352) |

**Ninety, against three.** The ledger's judgement that this "has to be someone's
job" is confirmed, and the ratchet is the mechanism that makes it recurring
rather than a one-off.
