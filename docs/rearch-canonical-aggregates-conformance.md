# POD-365 (1.4b) — canonical aggregates + shared field schemas: ADR conformance review

**Deliverable:** `packages/model/src/fields/` (the shared field schemas) and
`packages/model/src/aggregates/` (the canonical R1 Session and Issue), executed against POD-364's
`docs/rearch-field-schema-inventory.md` §6.

**Base:** `d3dd1a47` on `issue/279-integration`. **No consumer changed.**

---

## 1. The acceptance criteria, each answered

| Criterion | Met | Evidence |
|---|---|---|
| model exports the canonical Session and Issue aggregates plus the shared field schemas named by POD-364's composition plan | **yes** | `SessionAggregate`, `IssueAggregate`, 15 session groups (§6.2), 13 issue groups (§6.3), and the cross-entity `Ownership` / `Attribution` / `PerUserKey`, all exported from `@podium/model`. The wire-golden corpus enumerates them: 123 new cases across 40 new schema names |
| owner, visibility class and the actor/on-behalf-of pair each exist as exactly ONE shared field schema, composing POD-1075's types rather than redefining them | **yes** | §2 below |
| No serializable effective-capability snapshot exists anywhere in the schema set | **yes** | §4.1 — two instruments that fail on *different* mistakes, proved rather than asserted |
| Per-user-state members are absent from the canonical aggregates; the key shape uses POD-301's composite-key helpers | **yes** | §3 below |
| Both canonical aggregates declare a visibility class and participate in the default-closed totality test; an unclassified fixture aggregate fails it | **yes** | §4 below |
| No consumers changed; wire byte-identical for any field that was only re-typed | **yes** | §5 below |
| Representation-policy ADR conformance reviewed, including against ADR 9 D3/D4; oracle green | **yes** | §6 (the matrix) and §7 (lanes) |

---

## 2. The three shared schemas, and what was composed rather than forked

ADR 4 Amendment 1 D9 requires these to be defined once and composed, never re-declared per entity.

| Schema | Where | Composed from |
|---|---|---|
| `Ownership` | `fields/ownership.ts` | `UserIdField` (already in `ids/brands.ts`) + `VisibilityClassField`, which is `z.enum(VISIBILITY_CLASSES)` over **POD-304's existing annotation vocabulary** — not a second enum |
| `Attribution` | `fields/attribution.ts` | `ActorRef` (new, §2.2) + `UserIdField.nullable()` |
| `PerUserKey` | `fields/per-user-key.ts` | `UserIdField` + POD-301's `userEntityKey` / `parseUserEntityKey`, re-exported so there is one answer to "how do I key this" |

### 2.1 Visibility class: one vocabulary, structurally

`annotations/ownership.ts` now exports `VISIBILITY_CLASSES` as a `const` array and derives its
`VisibilityClass` type from it; `fields/ownership.ts` derives the zod enum from the same array and
carries a compile-time assignment pinning `z.infer<typeof VisibilityClassField>` to that type.
Widening either without the other stops compiling.

The field-position schema is named `VisibilityClassField`, not `VisibilityClass`, because the type
of that name already exists and there must be exactly one of it.

### 2.2 `ActorRef` — the one fork this issue had to resolve without an upstream

Inventory §6.1 asserts four things about POD-1075's output, of which (d) is *"`ActorRef` is
distinct from `UserId` so `Attribution` cannot degrade into one nullable id."* POD-1075 is
`backlog`, blocked behind POD-1070, so assertion (d) had **no owner in flight** and `Attribution`
could not be built as a pair without resolving it.

Resolved from the pack, per the fan-out protocol's order (`docs/adr/` first):

- **ADR 9 D1** names exactly four principal kinds. `ActorRef` is a closed discriminated union over
  them: `user` / `agent` / `machine` / `system`. The superagent is deliberately **not** a fifth
  arm — D1 makes it an agent delegation with a broad scope, so D5's rules apply to it unchanged.
- **Not a nullable string**, for three reasons: the four kinds are differently branded; `null` is
  already spoken for on the *other* half of the pair (the machine/system "no human" case); and a
  future redacted arm (ADR 9 §3 O2, cross-boundary references) is then an added member rather
  than a third overload of `null`.
- The `AgentIdentityId` **brand** moved from `@podium/protocol`'s `planes/principal.ts` into
  `ids/brands.ts`, with protocol re-exporting it. This is the `UserId` precedent, and that
  module's own header asked for it: *"`packages/model` gains them with that aggregate or not at
  all."* Zero consumer churn — every existing import path still resolves, and
  `@podium/protocol` typechecks unchanged.

**What was deliberately NOT taken from POD-1075:** the `User`/account aggregate, the account role
enum, the delegation *shape* `(agentIdentity, onBehalfOf, scope)`, and the **grant edge**. Brief
item 1 assigns all four there. `GrantEdge`'s absence is also required by ADR 9 D2 independently: a
grant is its own aggregate, not a field on the granted row, so no session or issue aggregate
composes one — embedding it would be the ADR 4 D7.1 entity-in-entity defect. Its key encoding
(`subjectResourceKey`) and verb vocabulary (`GrantVerb`) already exist in model.

### 2.3 The pair cannot be half-recorded

Inventory §9 catalogues three sites where attribution splits — and POD-367 pinned a live instance
(`a349bf4e`): an optimistic-patch arm stamps `humanQuestionAskedAt` unconditionally but carries
`humanQuestionAskedBy` only when the input happens to supply a string, so it can answer *when* a
question was asked while answering nothing about *who*.

The shape answers this structurally rather than by convention. Three groups nest the timestamp
**inside** the object that carries the actor, optional as a whole:

- `NeedsHuman.asked` — `{ question, options?, at, by, attribution }`
- `SessionTombstone.deleted` — `{ at, source, by, byIssueId? }`
- `SessionNaming.namedBy` — beside `nameSource`, which is a role class and not a person

A value carrying `at` without `by` does not typecheck. This is stronger than making the actor half
non-optional beside a timestamp: the timestamp does not exist outside the object that carries the
actor.

`SessionTombstone` also records the §9 finding that `deletionSource` (`'issue' | 'standalone'`) is
a **code-path label and not attribution at all** — reading it as "attribution is handled" would
leave session deletion with no actor whatsoever. It stays a reason field *beside* the pair.

---

## 3. Per-user state: absent, and proved absent

ADR 4 Amendment 1 D10 / inventory §7.1. The eleven marked members reduce to nine distinct key
spellings, listed as `PER_USER_STATE_KEYS` and checked over both aggregates' shapes by
`classificationViolations()`.

The check is proved to be an instrument rather than a tautology: `registry.test.ts` runs the same
predicate over `SessionAggregate.extend({ readAt })` and requires it to fail.

`deferUntil` is deliberately **not** in the list, and the absence is a decision: unlike
`snoozedUntil` it is a claim about the *work* ("this cannot start before Tuesday"), identical for
every viewer, and the defer/snooze split is already settled in `predicates/issue-stage.ts`.

Inventory §7.2's three open questions are **recorded, not reopened**: `archived` and `workState`
stay `exp-rev` shared session facts per ADR 1 Amendment 1 D10, and the composer draft is **not**
absorbed into the per-user family (doing so would silently delete the collaboration feature rather
than defer it).

---

## 4. Default-closed classification (ADR 9 D3/D4)

Both aggregates declare `personal` — the human decision of 2026-07-29 ("C's mechanism, B's
default") applied to the two classes, matching the `session-identity` and `issue-core` matrix rows
that already exist. Neither is `deployment-substrate`: the tenant-visible floor is deliberately
small (readiness §3.1.1) and neither a session nor an issue is substrate. No new replicated class
was introduced, so no new matrix row was needed.

Three mechanisms carry the rule, and none substitutes for another:

1. **`CanonicalAggregate` has no optional field.** You cannot register without declaring — a
   compile error, the cheapest failure.
2. **`classificationViolations()` checks the declaration against ADR 1's matrix.** A required
   field only forces you to write *something*; this forces you to write *what the matrix says*.
   It is the mechanism that catches the real mistake: a well-typed declaration of
   `deployment-substrate` on a `personal` row.
3. **`visibilityClassOf` still resolves an unknown row to `personal` with every test deleted** —
   POD-304's semantic backstop. The default is **not** the test.

**Proved with a fixture, as the brief requires.** `registry.test.ts` plants `FixtureWidget` — a
real-looking aggregate that simply never got a matrix row, which is what the mistake looks like in
practice — alongside the two correct aggregates, and requires the check to flag exactly it. Keeping
the correct aggregates in the same fixture set is what makes the result meaningful: a check that
flagged everything, or nothing, could not produce it.

**Mutation-tested, zero survivors** (mutate / run / revert as one unit):

| Mutant | Result |
|---|---|
| Delete the missing-matrix-row branch from `classificationViolations` | **killed** — "FAILS a fixture aggregate whose class was never declared on the matrix" reds (1 failed / 21) |
| Drop `Ownership.shape` from `SessionAggregate` and restore `readAt` as a singleton | **killed** — 5 red, including "Session carries no per-user singleton" and "Session composes the Ownership group" (5 failed / 21) |
| Smuggle a frozen grant set onto `SessionAggregate` under the innocent key `ctx` | **killed by the key-set pin only** — 1 red of 24; the name matcher passes, which is the point (§4.1) |
| Grow `SESSION_IMMUTABLE_AFTER_CREATE` to swallow `status` / `lastActiveAt` / … — the well-typed nonsense its `satisfies` clause permits | **killed** — 1 red of 27: "leaves a NON-EMPTY mutable complement" (§8.1) |

### 4.1 No serializable capability — and a correction about how that is checked

ADR 9 D5 A1: effective rights are an agent's own scope intersected with its human's **current**
rights, resolved live at every apply. A snapshot survives the revocation of the person it came
from, with no reaper to trigger.

Two instruments cover this, and the second exists because the first was initially over-credited:

1. **A name matcher** over the aggregates' keys (`capability`, `effectiverights`, `permissions`).
   POD-643 read this as *"an exact key-set assertion [that] catches the innocent-name case my
   name-matcher cannot"*. **It was not.** It was three substring tests — the same class of
   instrument as POD-643's exported `findCapabilitySnapshotKeys`, with the same blind spot. The
   two were corroborating each other, not complementing. Left uncorrected, a reviewer reading both
   green would have concluded the innocent-name case was covered by somebody.

2. **An exact key-set pin** — `SessionAggregate`'s 43 keys and `IssueAggregate`'s 57, sorted,
   `toEqual`. This fails on **any** new key however innocently named, which is the only instrument
   that can catch an authority-shaped value under a bland name (`meta`, `ctx`, `extra`) — the
   realistic miss, rather than someone naming a field `capabilities`.

**Mutant C** (mutate / run / revert as one unit): smuggle `ctx: { allowedVerbs: string[] }` — a
frozen grant set — onto `SessionAggregate`. **Exactly one test reds: the pin.** The name-matcher
test passes, which is the demonstration that the two fail on different mistakes. The innocent-key
test asserts both halves (the pin reds **and** the name matcher returns zero hits on the same
shape) so the pair cannot later be re-read as one check.

POD-643's second caveat is recorded from this side too: `owner` / `actor` / `onBehalfOf` are
deliberately **not** matched by either instrument. A clean result means *"no serialized authority
decision"*, not *"no principal-bearing fields"* — and since ADR 9 D2 requires exactly those
principal-bearing fields, a detector that flagged them would be wrong rather than strict.

The pin is deliberately a chore to update. Those two lists are the canonical durable vocabulary of
the product; growing one should be a deliberate act with a reviewer on the diff, not a side effect
of extending a field group.

---

## 5. No consumers changed, and the wire is byte-identical

`SessionMeta` and `IssueWire` are untouched. The wire is byte-identical **by construction** rather
than by proof-after-the-fact — but the proof was taken anyway, and taken *before* regenerating,
which is the only moment it exists.

Pre-regeneration: 1 of 962 tests failed (the `model` family's deep equality) and the vitest
structural diff contained exactly **one** `-` line — the literal `- Expected` header. Zero existing
lines removed or modified.

Post-regeneration the *line* diff reads 4438 insertions / 1433 deletions, which is the **wrong
instrument**: the corpus is an ordered array, so interleaved insertions read as moves. Semantic
comparison of the committed JSON keyed by `(schema, variant)`, against the **pre-POD-365** corpus:

```
old cases 197  ->  new cases 320
REMOVED existing cases: 0
CHANGED existing cases: 0
ADDED   new cases:    123
family key set unchanged: true
```

Every added case belongs to a schema this issue introduced. **0 changed cases** is the
byte-identity claim. Re-proved unchanged after the later `ops` → `opsTail` rename, where the only
cases that moved were the four schemas this issue introduced that carry that shape.

This is the property the suite's own header says it exists to prove: *"a field added shows up as a
new line; a field whose shape changed shows up as a modified line in place."*

The one non-model edit is `packages/protocol/src/planes/principal.ts`: the `AgentIdentityId`
declaration became a re-export from `@podium/model` (§2.2). No exported name, type or value
changed, and `@podium/protocol` typechecks unchanged.

---

## 6. Representation policy — ADR 4, ADR 4 Amendment 1, ADR 9, ADR 1

| Requirement | Where satisfied |
|---|---|
| ADR 4 **D1** — one vocabulary, **not** one universal record | 15 + 13 field groups; the aggregates are the durable R1 only. `SessionLiveOverlay` and `SessionDerived` are *named* precisely so they can be kept OFF R1 — a storage row and a wire projection never become the same type |
| ADR 4 **D2** — one role per representation | The aggregates declare R1. No projection function is defined here; those are POD-366 / POD-367 / POD-643 |
| ADR 4 **D3.1/D3.2** — field groups; compose, never copy key lists | Both aggregates are built with `.extend()` over named groups. A retyped key list would have been the 25th session representation, not the collapse of the other 24 |
| ADR 4 **D3.3** — propagate or fail compilation | Adding a member to a group propagates into the aggregate; it cannot be forgotten |
| ADR 4 **D3.5** — branded ids | Field-position brands throughout. `machineId` is the carve-out and stays raw: `MachineId.parse('local')` succeeds, so branding a site holding the sentinel would **launder** it (ADR 1 Am2 D16.2) |
| ADR 4 **D3.6** — derived fields are pure functions, never a second write path | `SessionDerived` / `IssueDerived` exist and are excluded from R1; asserted |
| ADR 4 **D3.7** — live-only fields are not R1 members | `SessionLiveOverlay` holds D-9's five fields that `SessionMeta` publishes with **no storage column in any migration**; asserted absent from R1 |
| ADR 4 **D3.8 / Am1 D9.4** — provenance on the envelope, attribution on R1 | Neither aggregate carries `viaHub` / `upstreamStale` / `pendingSync`; asserted. Ownership and attribution are on R1 because they must survive bootstrap, export and re-replication |
| ADR 4 **D7.1** — no entity-in-entity on the wire | `IssueAggregate` carries neither `sessions` nor `sessionSummary`; asserted |
| ADR 4 **Am1 D9** — owner/visibility as shared schemas; attribution a **pair** | §2 |
| ADR 4 **Am1 D10** — per-user state is a keyed shape, not a field | §3 |
| ADR 9 **D1** — four principal kinds | `ActorRef`, §2.2 |
| ADR 9 **D2** — owner / visibility / grants normative; a grant is its own aggregate | §2, and `GrantEdge` deliberately not defined here |
| ADR 9 **D3** — five visibility classes; machine facts inherit | One vocabulary (§2.1); `machineId` / `repoId` documented as inherited on `SessionPlacement` and `IssueWorkspace` |
| ADR 9 **D4** — default-closed, with a totality test | §4 |
| ADR 9 **D5 A1** — no snapshotted capability | No such schema; asserted |
| ADR 9 **D5 A3** — attribution is a pair, stamped from the transport principal | §2.3 |
| ADR 9 **D5 A4** — agent output is owned by the delegating human | Documented on both aggregates' `createdBy`: `owner` is that pair's `onBehalfOf`, never the agent |
| ADR 1 **D5 / ADR 9 §1.2** — not multi-tenancy | No `instanceId`, no tenant discriminator; asserted over every key of both aggregates |
| ADR 1 **Am1 D10** — `archived` / `workState` are shared session facts | Recorded on `SessionLifecycle` / `SessionWorkState`, not reopened |
| ADR 1 **Am1 D12** — `op-stream` reserved, not built | `OpStreamDocument` = materialized `value` + bounded `opsTail`, with ADR 2 D5's constraint carried in the field name (§7 of the inventory's ask) |
| ADR 2 **Am1 / readiness §3.1** — room for principal-dependent projection, not built | `packages/model/README.md` invariant 5 and `fields/README.md` rule 2 |

### 6.1 Two renames on composition (inventory D-2)

`blockedBy` → `blockedByNotes` (it is LLM-authored prose, not the dependency edge set — two things
called "blocked by", one authoritative, is how a tracker comes to lie about why something is
blocked) and issue `origin` / `draft` → `intentOrigin` / `isDraftVessel` (the session keeps the
unqualified names because its meaning matches the plain word). **On composition only** — the wire
keeps its key names until POD-367 re-derives `IssueWire`, and the mapping belongs in that one
documented `toWire` / `fromWire` pair, not at call sites. Both renames are asserted, each with its
counterfactual in the fixture.

---

## 7. Verification lanes

| Lane | Result |
|---|---|
| `bun run typecheck --force` | **22 successful, 22 total, 0 cached** — genuinely uncached, 1m42s |
| `bun --bun vitest run` (unit lane, `CI=true`, isolated) | **456 files passed, 3 skipped; 6148 tests passed, 19 skipped; exit 0** |
| `bun run test` (all three lanes) | exit 0 |
| `bun --bun vitest run packages/protocol packages/model` | 53 files, 965 tests, all passed |
| `bun scripts/check-no-nul-bytes.ts` | exit 0 |
| `bun scripts/check-boundaries.ts` | exit 0 — 58 allowlisted, **0 new** |
| `bun scripts/rearch-audit.ts` | exit 0 — 21 items, 261 sites, **baseline exact** |

**One lane result was not believed on first sight, and it is worth recording why.** An earlier full
`bun run test` reported 4 failed files / 7 failed tests plus a `SIGILL` worker crash, and its
vitest banner named a *different worktree* as the root. Both were treated as instrument problems
rather than findings. The cause was concrete: the `test-lane` lease had expired mid-run and POD-366
had taken it, so two full suites were running on an 8-core box at once. Re-run in isolation the
lane is clean. A separate `--reporter=basic` attempt exited 1 on an invalid flag, not on a test —
also checked before its colour was believed.

---

## 8. One zero-caller export, judged rather than hidden

`SESSION_IMMUTABLE_AFTER_CREATE` (`aggregates/session.ts`) **has no consumer today**. The fan-out
protocol §7 says a new API with zero callers counts as *stopped short*, so it is named here rather
than left for a reviewer to discover.

### 8.1 Why it is not the thing that rule targets — verified, not asserted

§7 targets **mechanism pretending to be a feature**: a flag nothing sets, a conformance suite that
skips the failure path. This is a *derived constant whose derivation is compile-time pinned to its
source*. POD-366 mutation-tested that binding rather than trusting it: `refDraft` → `refDraftTYPO`
in the array makes `packages/model` exit 1 with **TS2820**, so the
`satisfies readonly (keyof SessionAggregate)[]` clause genuinely binds. It cannot go stale while it
waits.

**Different is not exempt**, and POD-366 named the remaining gap precisely: the clause cannot check
that the list *means* anything — a constant naming every key would typecheck and assert that a
session is frozen at birth. Three assertions close it (runtime key membership; a non-empty mutable
complement containing `status` and `lastActiveAt` by name; and the fields whose mutability would be
a correctness bug held explicitly). **Mutant D** grows the constant to swallow the mutable fields:
exactly one test reds.

### 8.2 Why it was kept rather than deleted

POD-366's call, recorded because the reasoning is the substantive part: *it is not four lines of
code, it is four lines of judgement* about which session fields are immutable after create — made
while the whole aggregate and every field group were freshly read. Deleted and reconstructed later
by someone with less context, the likely failure is a list that is subtly wrong (`spawnedBy` or
`createdBy` quietly becoming mutable), which is the class of error nobody notices because nothing
fails.

Its named consumer is POD-366's `SessionDurableState` work, reported outstanding for a stated
reason: `SessionInit` is unbranded and mostly optional as a *constructor* input while
`SessionAggregate` is branded and required, so the Pick changes brandedness and optionality at
every construction site. In POD-366's words, *"it is size, not uncertainty."*

---

## 9. What this issue deliberately did NOT do

| Not done | Owner |
|---|---|
| Any projection function — `toWire` / `toStorage` / `SessionMeta` / `IssueWire` / the R5 ports | POD-366, POD-367, POD-643 |
| The `User` / account aggregate, account role enum, delegation shape, `GrantEdge` | POD-1075 |
| The per-user state family's eleven members | POD-1076 |
| Building op-streams, watermarks, scoped feeds, or any authorization | ADR 1 Am1 D12; POD-1077; Phase 3 (POD-290) |
| Re-pointing `attributionOf` / `capabilityAttribution` at the durable `Attribution` schema | POD-1075 owns `planes/principal.ts`; mailed. Today there is exactly one *field schema* for the pair, and two *readers* that produce it from a `Principal` and a `Capability` |
| Editing `docs/rearchitecture-v3.md` | Phase 1's designated ledger owner — recorded as a `LEDGER-ENTRY` comment on POD-365 per §3.6 |
