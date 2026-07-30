# POD-1162 — Phase 1 guardrail probe gate: evidence

**Commit under test:** `4affdb0a` (`issue/1162-phase-1-guardrail-probe-gate`, tree clean before and
after every probe)
**Date:** 2026-07-30

Every probe below **plants deliberately bad code, observes the gate fail, reverts, and verifies the
file hash is restored**. One mutant per invocation; the runner aborts if the mutation anchor matches
anything other than exactly once, if the file hash does not move when it should, or if the revert
does not restore the original bytes — a failed-to-apply mutant otherwise reads as a survivor.

Passing on clean code proves nothing, so no probe is graded on a green run. Where a check could pass
for the wrong reason, the probe was designed so that **only** the guardrail under test can produce
the failure.

---

## Verdict

| Probe | What was planted | Result |
|---|---|---|
| **P1** Visibility-class totality, both directions | 6 mutants | **PASS 6/6** |
| **P2** No serializable effective-capability snapshot | 3 mutants | **PASS 3/3** |
| **P3** No per-user state as a singleton | 6 mutants | **4 PASS, 2 FAIL** — detector defect confirmed |
| **P4** No `instance_id` | 3 mutants | **2 PASS, 1 FAIL** — missing guardrail |

**Two real defects found**, both of the exact class this gate exists to catch. Neither is a reason to
hold Phase 2 — see *Gate decision*.

---

## P1 — Visibility-class totality, BOTH directions

POD-365's mutant E is the precedent: `aggregateVisibilityOf("Session") === "personal"` held whether
or not `Session` was registered, because the default-closed fallback answers `personal` for anything
it has never heard of. The pass value and the failure value were the same string. So the missing
declaration and the direction are probed **separately**, and the direction is probed by flipping the
default rather than by asserting it.

| # | Mutant | Gate | Fired with |
|---|---|---|---|
| P1a | Third name added to `CANONICAL_AGGREGATE_NAMES` with no `AGGREGATE_BY_NAME` entry | `tsgo --noEmit` | `TS2741: Property 'Machine' is missing in type … but required in type 'Record<"Issue" \| "Machine" \| "Session", …>'` |
| P1b | **Real** `Session` aggregate pointed at a matrix row that does not exist | model suite | `kind: "no-matrix-row"` on `Session` |
| P1c | Matrix fallback flipped `personal` → `deployment-substrate` | model suite | 4 failures incl. the tenant-visibility assertions |
| P1d | Aggregate fallback flipped `personal` → `deployment-substrate` | model suite | `reads the DECLARED class, not the default` |
| P1e | **Real** `Session` declares itself `deployment-substrate` | model suite | `classifies both canonical aggregates as personal, not substrate` |
| P1f | Representation fallback flipped `personal` → `deployment-substrate` | model suite | `resolves an unclassified representation to PERSONAL, never to tenant-visible` |

**P1b is the non-vacuity probe.** The planted row does not exist, so `visibilityClassOf` resolves it
to `personal` — which is exactly what `Session` declares. The declaration and the default agree, so
the disagreement check is blind by construction and **only** the missing-row check can see it. It
did. This is mutant E's scenario, and the gate now fails it.

P1c/P1d/P1f establish **direction**, not merely presence: if the default-closed fallback were
reversed, the suite goes red in all three registries. A check that merely errors does not establish
which way it fails open; these do.

---

## P2 — No serializable effective-capability snapshot

ADR 9 D5 A1: effective rights resolve **live** at every apply (ADR 3 D8). A snapshot survives the
revocation of the person it was derived from, with no reaper to trigger.

Planted in **every arm** of a discriminated union, which is the exact hole POD-1153 found:
`HandoffManifest` is `z.discriminatedUnion('format', [V1, V2])` and both arms spread
`HANDOFF_BUNDLE_CORE`, so a field added there lands in both.

| # | Mutant | Result |
|---|---|---|
| P2a | `effectiveRights` into the shared core → **both arms** | Fires. Graded in isolation against only the capability check: `carries serialized authority at effectiveRights, effectiveRights` — **named once per arm** |
| P2b | `delegation: { scope }` into the **format-2 arm only** | Fires: `carries serialized authority at delegation.scope` |

P2b is the important one: the arm carrying a new field is the arm a reviewer has not read yet. Before
POD-1153's fix the audit answered `[]` here — not a clean bill, a detector that stopped looking.

**No missing guardrail against POD-1075.** The check fires on the object case, the every-arm case and
the single-arm case.

---

## P3 — No per-user state surviving as a singleton

### Violation direction — PASS

`readAt` planted as a singleton on a session representation in the tree. The ratchet moved
`8 → 9` and named the site:

```
per-user-singletons (POD-1076)   baseline 8 → now 9
   apps/server/src/pod1162-probe.ts:4  Pod1162SessionRow.readAt
```

### POD-1076's `archived` / `workState` decision — APPLIED, verified positively

The recorded decision (ADR 1 Am1 D10: both are **shared session facts at `exp-rev`**, not per-user
view state) is not merely written down — it is load-bearing in two independent places:

| # | Mutant | Fired with |
|---|---|---|
| P3b1 | `workState` removed from the aggregate | `SessionAggregate carries exactly these 43 keys and no others` |
| P3b2 | `archived` removed from the aggregate | same key-set pin |
| P3b3 | `session-labels` conflict regressed `exp-rev` → `field-LWW` | `removed everything D10 moved OUT of field-LWW` |

Both fields are members of the canonical aggregate, neither is in `PER_USER_STATE_KEYS`, and the
shared-fact conflict rule is pinned. The decision was applied, not merely made.

### False-positive direction — **FAIL. Confirmed exactly as POD-1160 predicted.**

POD-1160 warned that the detector keys on *"carries key K"* alone, blind to whether `PerUserKey` is
composed — so POD-1076's **correct** shapes will read as violations. They do.

Probed with POD-1076's actual fixed form, composing the one shared key fragment:

```ts
export const Pod1162SessionUserState = perUserKey(SessionIdField).extend({
  readAt: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  tuckedAt: z.string().nullable(),
  pinned: z.boolean(),
})
```

This is the re-key that **fixes** the debt. The audit reads it as four new violations:

```
per-user-singletons (POD-1076)   baseline 8 → now 12
   packages/model/src/user-state/pod1162-probe.ts:8  Pod1162SessionUserState.readAt
   packages/model/src/user-state/pod1162-probe.ts:8  Pod1162SessionUserState.snoozedUntil
   packages/model/src/user-state/pod1162-probe.ts:8  Pod1162SessionUserState.tuckedAt
   packages/model/src/user-state/pod1162-probe.ts:8  Pod1162SessionUserState.pinned
issue-shapes (POD-302)           baseline 0 → now 1
   Pod1162SessionUserState hand-declares 3 issue keys: readAt, tuckedAt, pinned
```

The same holds for the interface form (`userId` + `entityId` + `readAt` → still flagged, `8 → 9`).

**Two distinct detector defects**, both in `scripts/representation-audit.ts`:

1. `perUserSingletons` cannot distinguish a per-user singleton from a per-user **row keyed by
   `(userId, entityId)`**. The fix and the defect produce the same finding.
2. `unregisteredRestatements` counts the fixed form as a hand-restatement of issue vocabulary. A
   per-user family row composing `PerUserKey` is not a restatement of an issue.

The schema-level twin in `packages/model/src/representations/checks.ts` has the same blindness (it
tests `shape.includes(key)` with no `PerUserKey` exemption) and will hit the moment POD-1076
registers the family.

**Why this matters more than the count.** This is the "8 → 11" symptom POD-1151 already hit once. When
POD-1076 lands, the ratchet goes **up**, and the tempting response is a rebaseline — which would
launder the ratchet and destroy the one instrument that measures this debt. The detector must learn
`PerUserKey` **before** POD-1076 lands, not after.

Today the existing fixed shapes (`SessionSnoozeState`, `PinState`, `TabOrderState`) escape only
because they sit below the 3-key entity-shape threshold. They are not recognised as fixed — they are
merely too small to be seen. That is luck, not a guardrail.

---

## P4 — No `instance_id`

ADR 1 D5 stands; multi-user is not multi-tenancy.

| # | Mutant | Result |
|---|---|---|
| P4a | `instance_id` **field** on a session representation in the tree | **Fires**: `instance-partitions baseline 0 → now 1` |
| P4b | `instanceId` on a **registered schema** (every arm of `HandoffManifest`) | **Fires**: `kind: "instance-partition"` |
| P4c | `instance_id` **DDL column** on the `sessions` table | **DID NOT FIRE** — closed by POD-1168, see below |

### P4c — missing guardrail, recorded explicitly

```ts
export const sessions = sqliteTable("sessions", {
	instance_id: text("instance_id"),
	…
```

Green across: `rearch-audit` (baseline exact), the full `packages/model` suite (334 passed),
`tsgo --noEmit`, the migration suites (`applier`/`backup`/`convergence`/`integrity`/`proposed-backfill`)
and `store.test.ts` — 78 tests, all passing with the tenant column in place.

The cause is structural: `representation-audit.ts` skips `/migrations/` by design (past migrations
are immutable history), so the DDL layer is outside every instance-partition detector. The **field**
direction is guarded; the **column** direction is not.

The claim in `docs/rearch-vocabulary-audit.md` §5 that there is "no `instance_id` column in any
migration" is a true **observation**, but it is not backed by a guard — nothing would catch the next
one.

**CLOSED by POD-1168.** Two causes, both fixed. (1) `isFrozenFile` skipped all of `/migrations/`,
which froze the live `apps/server/src/migrations/schema.ts` along with the immutable SQL history;
narrowed to `/migrations/drizzle/` (2f648000). (2) Even unfrozen, the detector read only the KEYS of
entity-shaped declarations, and a drizzle table is a call expression whose columns are never keys —
so P4c stayed green after the unfreeze. `physicalTableColumns` now parses the `sqliteTable("<name>",
{ … })` form itself (56 tables, 479 columns) and `instancePartitions` tests the TS key and the SQL
column name against the same `INSTANCE_PARTITION_KEY`. Re-running P4c verbatim now yields:

```
instance-partitions (POD-302) — Instance/tenant partition on a representation or a physical table
    baseline 0 → now 1   [one instance_id/tenant_id-shaped key or table column]
    apps/server/src/migrations/schema.ts:22  sessions.instance_id (column)
```

exit 1; reverted, exit 0 and `25 items, 222 sites (baseline exact)`.

---

## Wire-fixture deltas — every delta attributed, measured semantically

A line diff lies on an ordered corpus: interleaved insertions read as moves. Every delta below is
keyed by `(schema, variant)` and compared on the **encoded bytes**.

**Across the whole epic** (first capture `6cdb05c2` → `HEAD`):

```
cases at first capture: 635
cases at HEAD:          827
SURVIVING with IDENTICAL bytes: 632
BYTES CHANGED: 1        DISAPPEARED: 2
```

All three deltas are handoff, and each names a child's decision:

| Case | Delta | Attribution |
|---|---|---|
| `HandoffManifest/full` | → `full/arm0…arm3` | POD-1153 — the sampler emits one case per union arm. A refinement into more cases, not a removal |
| `HandoffExportResultMessage/full` | → `full/arm0…arm3` | POD-1153 — embeds the manifest, same cause |
| `HandoffImportResultMessage/full` | one key **added**: `"refusal":"unauthorized"` | POD-643's refusal arms. The `full` variant samples all optional fields, so it grows. Purely additive |

**Zero pre-existing cases lost. Zero incompatible modifications.**

Per-commit, semantically:

| Commit | removed | changed | added | Attribution |
|---|---|---|---|---|
| `e6b1f86c` | 137 | 0 | 139 | POD-300 relocation — family re-key only; bytes preserved (proven by the family-independent check above) |
| `f085f6da` / `bc2650d9` | 14 | 0 | 50 | POD-361 — `ids` family cases re-homed to `model`; bytes preserved |
| `f2618d4e` | 0 | 2 | 2 | POD-643 handoff manifest |
| `7b35b572` | 0 | 0 | 123 | POD-365 — **independently re-verified below** |
| `ce014033` | 0 | 7 | 0 | POD-365 `opsTail` rename. All 7 are schemas introduced *within* the epic, which is why none appears in the byte-stability result |
| `9bf63ea9` | 2 | 0 | 15 | POD-1153 format-2 arms |
| `7ec5766d` | 0 | 0 | 8 | **POD-380** — 96 insertions, **0 removed, 0 changed**. The brief's claim, confirmed |

`46445392`'s 26+/25− in `wire-golden.fixtures.ts` is import-symbol reshuffling plus one docstring
line — no payload change. This is the "re-typed, not changed" case; branding is compile-time.

### The regeneration claim, re-derived rather than cited

`7b35b572` reads `4438+ / 1433−` and its message asserts a semantic comparison. A regeneration is
precisely how a wire change hides, so the claim was re-computed independently here:

```
old cases 197 -> new cases 320
REMOVED existing cases: 0
CHANGED existing cases: 0
ADDED   new cases:      123
added cases on PRE-EXISTING schemas: []   (all 123 belong to 40 newly-introduced schemas)
```

The commit message's claim holds exactly.

---

## The three open handoffs — all still OPEN

| Handoff | Status |
|---|---|
| POD-364's existence-leak list → Phase 3 (POD-290) | **OPEN.** ADR 9 §3 still lists **O1** with owner "Phase 3 policy (POD-290)". 7 matrix rows still cite O1. POD-290 is `backlog`, blocked |
| POD-367's cross-boundary graph-edge question | **OPEN.** ADR 9 §3 still lists **O2** ("Human + tracker feature owner", "Phase 3 policy, before any issue-graph wire change"). 1 matrix row cites O2 |
| POD-1076's scoped-feed requirement → POD-1077 | **OPEN.** Recorded in `docs/rearch-visibility-mutability-inventory.md` ("handed from POD-304 to POD-1077"). No scoped feed, watermark or rescope/evict signal is built. POD-1077 is `backlog`, blocked |

None was answered inside Phase 1.

---

## Audit items at zero — 3 of 4, and the fourth is named, not waved through

Measured at `4affdb0a`; `rearch-audit` exits 0 at **25 items / 219 sites, baseline exact**. Nothing
rebaselined.

| Original Phase-1 item | Detector | Count | Verdict |
|---|---|---|---|
| Hand-restated field definitions | `session-shapes`, `issue-shapes`, `representation-registry-rot` | 0, 0, 0 | **ZERO** |
| Agent-kind tables | `agent-kind-enums` (POD-303, done) | 0 | **ZERO** |
| Duplicate `stateDir` | `state-dir-defs` | 0 | **ZERO** |
| **Raw-string ids** | POD-363's AC | — | **NOT ZERO** |
| Capability tables | `capability-tables` | 5 | Out of Phase-1 scope — see below |

**Raw-string ids are not at zero.** POD-363 ("1.3d … AC: raw-string-entity-id audit item reaches ZERO
repo-wide") is `backlog`, **blocked** on POD-362, which is still `in_progress`. `bun run inventory:ids`
over 1,775 files reports 14,009 sites, of which **1,856 are `A-schema-flip`** and 117
`B-helper-adoption` — the two owners that POD-362/363 exist to drive to zero. (The sweep deliberately
over-reports, so the raw total is not the audit item; but the item is plainly not closed and its
issue is not done.)

**Capability tables (5) are correctly outside this gate.** `capability-tables` is phased `POD-325`,
which is **5.3** — Phase 5, "split agent-bridge, fold capability tables into manifests". Phase 1's
half of that item is `agent-kind-enums`, which is at zero. This gate therefore claims agent-kind
enums at zero and does **not** claim capability tables at zero; the fold is POD-325's.

### Cited, not re-derived

Per the binding 2026-07-17 ruling, the integrator's landing-run evidence at this commit is cited
rather than re-run: typecheck 23/23; `apps/server` 197 files / 2786 passed; boundaries OK 56
allowlisted / 0 new; deletion audit OK 25 items / 219 sites baseline exact; NUL gate ok including
docs. Two known reds are **not** regressions and were not re-investigated:
`apps/daemon/…/composer-sync.smoke.test.ts` (POD-1157 — the rewrite's only change to that file is an
erased `import type`, so it provably cannot be the cause) and
`scripts/loop-split-load.integration.test.ts` (load-sensitive; fails around load 29, passes in
isolation).

The lanes re-run here were run **because they are the probe** — a guardrail is graded on the mutant,
and a cited green run cannot show a gate failing.

---

## Gate decision

**The four probes were run. Ten of thirteen mutants were caught; three were not, and all three are
the same two defects.**

Neither defect blocks Phase 2, and both are recorded rather than waved through:

- **P3's false positive** is a defect in a *ratchet*, not in the vocabulary Phase 2 consumes. It
  cannot corrupt POD-351's walking skeleton. It **will** misfire the moment POD-1076 lands, and the
  tempting response — a rebaseline — is the one the brief forbids. Filed against the detector's
  owner so it is fixed *before* POD-1076, not after.
- **P4c** is a missing guardrail in the DDL layer. Nothing today carries an `instance_id` column;
  what is missing is the guard that would catch the next one. Filed.

Phase 1's vocabulary — which is what POD-351 and POD-305 actually need — is intact and, for the first
time, **demonstrated** intact: the totality checks reject an unclassified class in both directions,
the capability audit sees into every arm of a versioned union, the per-user ratchet catches a planted
singleton, and 632 of 635 pre-existing wire cases are byte-identical with all three deltas
attributed.
