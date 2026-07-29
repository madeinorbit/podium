# ADR 4 — Amendment 1: representation policy under multi-user

| | |
|---|---|
| **Status** | Proposed (human gate on POD-359) |
| **Date** | 2026-07-29 |
| **Deciders** | ADR pack integrator (POD-359); encoding the human decisions of 2026-07-28/29 recorded in `docs/multi-user-readiness.md`; human sign-off before Phase 1 |
| **Issue** | none — **integrator-authored under POD-359**. Closes a gap the pack review found un-owned: ADR 4 D7.3's rationale, and the representation shapes the multi-user decision implies, had no leaf issue assigned to them. |
| **Consumers** | POD-364 (inventory + composition plan), POD-365 (field schemas in `packages/model`), POD-366 / POD-367 (session / issue re-derivation), POD-368 (audit to zero), POD-304 (matrix annotations), POD-293 (replica-side views) |
| **Related ADRs** | ADR 1 (ownership matrix, conflict rule, instance identity), ADR 2 (feed identity, revision, scoping), ADR 3 (principal from transport, apply-time re-authorization, redaction), ADR 6 (replica storage), ADR 8 (package topology), ADR 9 (identity, ownership, sharing — landed under the same POD-359 gate; owns the taxonomy, the visibility classes and the canonical open list this amendment consumes) |
| **Specs** | [spec:SP-3fe2] branded ids; [spec:SP-15aa] multi-instance isolation; [spec:SP-eb60] curated name vs live title |
| **Base tip verified** | `2ddfec21` (issue/279-integration), 2026-07-29 |
| **File discipline** | This amendment owns **only** this file plus a single "Amended by" line in `docs/adr/0004-representation-policy.md`. No index edits, no ledger edits. |

---

## 1. Context

`docs/multi-user-readiness.md` records the human decision of 2026-07-29: **build the
visibility machinery in Phase 2 and default to private** (§3.1, "C's mechanism, B's
default"). That decision reaches ADR 4 in exactly three places, and no further.

**Not multi-tenancy.** Multi-user in one tenant lives **inside** one Authority. **ADR 1 D5
is unaffected**: `InstanceId` remains a deployment partition, not a row-level discriminator.
Nothing in this amendment authorises an `instance_id` column on any aggregate, wire
projection, or per-user state row. An implementer who reads "multi-user" and reaches for
tenant columns has misread this document.

What is true today, verified on tip `2ddfec21`:

- **ADR 4 D7.3 rejects a server-side IVM engine** with the clause *"the client already holds
  the world"* (`docs/adr/0004-representation-policy.md`, §2 D7 rejected-alternatives table,
  line 306). Under a scoped feed the client holds its **slice**, so the clause as written is
  no longer literally true.
- **There is no owner, visibility or grant vocabulary anywhere.** `packages/protocol/src/ids.ts`
  declares `MachineId`, `SessionId`, `IssueId`, `RepoId`, `ConversationId`, `MutationId`,
  `ThreadId` — and **no `UserId`**. `apps/server/src/migrations/schema.ts` contains no
  `owner`, `visibility` or `user_id` column on any table.
- **Attribution today is single-valued and unbranded.** `IssueWire.humanQuestionAskedBy` is
  `z.string().optional()`, documented as *"sessionId of the agent session that asked"* — the
  **actor** half only, with no on-behalf-of half and no brand. `SessionMeta.nameSource` is
  `z.enum(['user','agent'])` — a role class, not a person. `sessions.deletion_source` is a
  bare `text` column.
- **Per-user state is already modelled as singletons.** `pins` is keyed `(kind, id)`;
  `tab_order` is keyed by `worktree`; `session_drafts` and `snoozes` are keyed by
  `session_id`; `read_at` is a plain column on `sessions`, `issues` and `issue_messages`;
  `SessionMeta.readAt` / `snoozedUntil` and `IssueWire.readAt` are singleton wire fields.
  Every one of these is *one row for the whole instance* — i.e. today's shape asserts that
  there is exactly one person.

The scope of this amendment is deliberately narrow: it does **not** decide ownership
semantics, visibility classes, grant evaluation, or which entity classes are personal
(ADR 9 and ADR 1's amendment own those). It decides only how those concepts are **shaped**
so they are defined once instead of hand-restated per feature — which is ADR 4's entire job.

---

## 2. Decisions

Numbering continues ADR 4's sequence (D1–D7 are the base document's).

### Decision D8 — D7.3 stands; its justification narrows to the slice

**Decision.** ADR 4 D7.3 (cross-entity read models are replica-side queries) and its
rejection of a server-side IVM engine are **unchanged**. The rejected-alternatives clause
*"the client already holds the world"* is replaced by: **the client already holds its
slice, and a join that would cross the visibility boundary is a join the principal may not
see anyway.** Replica-local joins remain correct because a join whose result would require a
row outside the slice has no permitted result to compute.

Stated precisely, because the weaker form is the one that misleads: **the slice is not
referentially closed.** D7.1 references are branded ids, and an id may name an entity the
principal cannot see (readiness §3.1.2's cross-boundary graph edge). A replica-side join over
such a reference resolves to *nothing locally* — which is the correct outcome, not a bug to
repair by fetching. Whether the UI then renders the edge as absent or as an opaque reference
is a projection/policy question (open item **O2**), not a join-engine question. Invalidation
stays keyed on ADR 2 D3's revision token; visibility changes are **not** revision movements
and are handled by ADR 2's amended scoping frames, not by ADR 4.

**Rationale.** The decision was never load-bearing on *world*-holding — it was load-bearing
on *locality*: joins over data the client already has, at Podium's derivation-graph size, do
not justify a server-side incremental view-maintenance engine. Scoping shrinks the input set
of every replica-side join; it does not make any of them server-side. Recording this
explicitly matters because the void rationale is the kind of sentence an implementer cites
to reopen a settled decision — and reopening it would put a joined-view engine on the
server, i.e. exactly the O(world) fan-out work D7.2 forbids.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Delete D7.3 and adopt a server-side IVM engine now that the server must scope anyway | Confuses two different pieces of machinery. Scoping decides *which rows a replica receives*; IVM decides *who computes joins*. Adopting IVM would move join maintenance onto the write/fan-out path, which D7.2 makes a testable violation (POD-736 harness), and would re-introduce per-consumer dirty tracking — the POD-772 entry-1 failure this ADR exists to make unrepresentable. |
| Leave the sentence as written and treat it as approximately true | The pack's rule is that a decision survives on stated grounds. A rationale known to be false is how a correct decision gets overturned by the first reviewer who notices — and multi-user readiness §3.1 item 4 names this sentence specifically. |
| Serve cross-boundary joins server-side "just for the edges that cross" | A per-principal server-side join path is a second read path with its own authorization surface, and its results are precisely the rows the principal may not see. The product answer to a crossing edge is an opaque reference (open item O2), which is a projection question, not a join-engine question. |
| Have the replica join and filter locally after receipt | Requires shipping rows the principal may not see, which is the protocol break ADR 2's amendment exists to prevent. Filtering is not a representation concern. |

### Decision D9 — Owner, visibility and grant are shared field schemas; attribution is a pair

**Decision.** The multi-user vocabulary lands as **shared field schemas in `packages/model`**
composed by representations under D3, never as per-entity re-declarations:

1. **`UserId` is a branded id** in the POD-301 family, alongside `SessionId` / `IssueId` /
   `MachineId`. Raw `z.string()` for a person is an audit failure after the flip, exactly as
   D3.5 already rules for entity ids.
2. **An ownership field group** (owner + visibility class + the grant edge shape) is **one**
   field group, composed by every representation of an owned class. Which classes carry it,
   what the visibility classes mean, and how grants evaluate are **ADR 1's amended matrix and
   ADR 9** — this ADR only rules that the group is defined once and composed, and that its
   annotation obligation rides D3.3's propagate-or-fail-compilation rule.
3. **Attribution is a pair, and therefore two fields, not one.** Per multi-user readiness
   §3.1.3 A3, every write records **actor** and **on-behalf-of**. These are **differently
   branded** — the actor may be an agent-session identity, the on-behalf-of is always a
   `UserId` — so the pair cannot collapse into one nullable id field without losing the
   distinction the product already depends on (`nameSource`'s human-outranks-agent rule,
   [spec:SP-eb60]; server-authoritative `humanQuestionAskedBy`). Both values are stamped from
   the transport principal (ADR 3 D7); neither is ever taken from payload.
4. **Attribution is not provenance.** D3.8 moves `viaHub` / `upstreamStale` / `pendingSync`
   to the replicated envelope because they describe *how a value arrived*. Actor and
   on-behalf-of describe *who caused the value* — they are durable entity facts, on R1, and
   they survive re-replication. The two must not be merged onto one carrier.

**Rationale.** Every attribution field on the tip is device-level or role-level and locally
typed (`humanQuestionAskedBy: z.string()`, `nameSource` as a role enum, `deletion_source` as
bare text). Adding a person dimension per feature reproduces exactly the hand-restated field
list ADR 4 exists to delete — except this time the drifting field is a security-relevant one.
Phase 1's thesis is that `packages/model` is the one authoritative definition of every field;
landing Phase 1 with a single-operator vocabulary bakes the wrong model into the one place the
rewrite promises never to redo (readiness §3.2).

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| One `actorId: string` covering both halves | Loses the human-vs-agent distinction the product already ships (human-set `name` outranks agent-set; "did a person or an agent ask this?" must stay answerable). A nullable second meaning on one field is the drift pattern D1 rejects. |
| `owner` as a per-entity ad-hoc column, decided per feature | This is the status quo defect (`read_at` restated on three tables, `deletion_source` as bare text) applied to authorization. A forgotten annotation would fail *open* — the opposite of readiness §3.1.1's default-closed rule. |
| Put owner/visibility on the envelope with provenance | Ownership is durable truth that must survive bootstrap, export and re-replication; envelope fields are per-delivery facts. D3.8's split is about lifetime, and these have the wrong lifetime for it. |
| Defer `UserId` to Phase 3 with the sharing UX | The brand is a wire and storage shape. Phase 3 is after the POD-308 cutover, so deferring it buys a second protocol migration — the specific failure POD-279 exists to end. |
| Model a user as a variant of the existing `Capability` role classes | `Capability` is an authorization decision input, not an identity; `OPERATOR` is a constant. Identity needs its own aggregate (ADR 9), and representations compose the id, not the capability. |

### Decision D10 — Per-user state is a named keyed shape, not a field on the shared entity

**Decision.** State that belongs to a person about an entity is a **per-user state
aggregate**: an R1 aggregate keyed `(userId, entityId)`, with its own R3 encoding and its own
R4 projection, composed from **one** shared key fragment in `packages/model`. It is
explicitly **not** a new role — D2's R1–R6 set stays closed; this is R1 with a composite key
and a matching projection.

Consequences that are ADR 4's to state:

1. **Per-user fields do not ride the shared entity's R4 projection.** A field whose value
   differs per reader cannot be a field of a shape that is broadcast to many readers. Today's
   `SessionMeta.readAt` / `snoozedUntil` and `IssueWire.readAt` are the canonical
   non-compliance, in the same way D7.1 names `IssueWire.sessions`.
2. **One shared key fragment, not one per feature.** `pins`, `tab_order`, `session_drafts`,
   `snoozes` and the `read_at` columns each invented their own keying; under this rule they
   compose the same fragment, so adding the user dimension is one change, not five.
3. **The conflict rule is not ADR 4's.** Which classes move into this shape, and the fact
   that doing so shrinks a conflict inventory, is **ADR 1 D3 and its amendment** (readiness
   §3.3). ADR 4 supplies only the shape.
4. **The composer draft is called out as not obviously in this set.** Readiness §3.3 and §4
   treat a shared-surface draft as collaborative-document state rather than per-user state.
   Which it is, is ADR 1's call with the `op-stream` class; ADR 4 requires only that whichever
   it becomes, it is one composed shape and not a per-feature restatement.

**Rationale.** Naming the shape is the whole point: readiness §3.1.1 lists per-user state as a
first-class set, and without a name every feature re-derives it — a `user_id` bolted onto one
table, a JSON blob on another, a singleton left behind on a third. That is the drift class
1.4 targets, arriving in a family of five tables at once. Keying it also makes the writes
single-writer by construction, which is why the shape is cheap.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Keep per-user fields on the entity and filter them per reader on the wire | Makes the R4 projection reader-dependent, so one entity has N wire values and golden fixtures (POD-360) stop being a meaningful gate. It also puts per-principal work back on the fan-out path, which D7.2 forbids. |
| One generic `user_state` JSON blob keyed by user | Unbranded, unschema'd, untestable for totality — the opposite of D3.1. Field meanings would live in string keys, which is precisely the vocabulary loss D1 rejects. |
| Add `user_id` per feature when that feature needs it | Five migrations instead of one, five keying conventions, and the first feature to forget it silently reintroduces the singleton. Readiness §3.3 is explicit that this is only a simplification if it happens in Phase 1. |
| Treat per-user state as R5 narrow ports | R5 is a structural dependency for one consumer; this is durable replicated truth with its own lifecycle. Wrong role, and it would escape the ownership-matrix totality test. |

---

## 3. Deliberately open — recorded, not answered

These are open in `docs/multi-user-readiness.md` and are **not** decided here. Each is listed
with the representation question ADR 4 will owe an answer to once the policy lands.

> **Numbering is the pack's canonical open list — ADR 9 §3** (POD-359 reconciliation, 2026-07-29).
> **O5** (host-local credentials under a `use` grant) and **O6** (phase ordering of the one
> subscription primitive) raise no representation question and are therefore absent below, not
> closed.

| # | Open question | Representation question it raises for ADR 4 | Who decides | When |
|---|---|---|---|---|
| **O1** | Which existence facts leak (counts, machine session lists, "worktree in use", lock holders, issue ref-letter allocation) — readiness §3.1.2 | Whether a count/aggregate is a D7.4 materialized entity per principal, or is simply absent from a scoped slice | Feature owner, per surface, against ADR 9's visibility classes | Phase 3 policy (POD-290); consistent-error rule already fixed by readiness §3.1.5 |
| **O2** | Cross-boundary graph edge display: hide the edge, or show an opaque reference — readiness §3.1.2 | If opaque references ship, whether "redacted reference" is a distinct R4 projection of the edge or a null-shaped variant of the existing one. ADR 3 D5 redaction is the nearest existing mechanism | Human + feature owner (it is a policy call: the opaque form leaks existence) | Phase 3 policy (POD-290), before any issue-graph wire change |
| **O3** | Is `reparent` a permission-affecting operation, given that subtree scope is dynamic — readiness §3.1.5 case 2 | Nothing new in ADR 4 unless the answer is "confirmation required", which would make it an ADR 3 D2 confirmation shape, not a representation change | Human, on the tracker's behaviour | Phase 3 (POD-290); surfaced in UI at latest |
| **O4** | Per-class owner/grant inheritance on create (child inherits parent's owner+grants vs the actor's) — readiness §3.1.2, §3.1.3 A4 | Whether inheritance is a declared annotation on the ownership field group (D9.2) or command-contract behaviour per class | ADR 1 amendment (matrix annotation) + per-class feature owner | Declared per class as classes land; annotation shape at Phase 1 (POD-304) |

ADR 4 must not pre-empt any of these: each answer changes *policy*, and only O2 and O4 could
change a *shape* — in both cases within the field group D9 already names.

---

## 4. Consequences

### Positive

- D7.3 survives review under the new premise with its justification repaired, so Phase 6
  (POD-293) keeps its replica-side-views plan intact and no server-side join engine enters
  the write path.
- The person dimension enters the model once, as composed field schemas, at the only moment
  (Phase 1) when it costs a schema definition rather than a protocol migration.
- Five hand-rolled per-user tables collapse onto one keyed shape, and the drift audit
  (POD-368) can count restated user-state keys the same way it counts restated session keys.

### Cost

- POD-364's inventory grows: attribution and per-user fields become part of the drift count,
  and `readAt` / `snoozedUntil` on `SessionMeta` / `IssueWire` join `IssueWire.sessions` as
  named non-compliances to delete at the POD-308 cutover.
- POD-365 must land the `UserId` brand and the ownership field group before ADR 9's policy is
  finalised, i.e. the shape is committed slightly ahead of the semantics.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| An implementer reads "multi-user" as "multi-tenant" and adds `instance_id` columns | Stated in §1 and here: ADR 1 D5 is unaffected; multi-user lives inside one instance. POD-304's annotation review rejects tenant columns. |
| Per-user state gets a user dimension in storage but the singleton stays on the wire | Compliance checklist item below; golden fixtures (POD-360) make a leftover singleton field visible as a fixture diff. |
| The actor / on-behalf-of pair is added to some writes and not others | The ownership field group is annotated on ADR 1's matrix with the existing POD-304 totality test; a class that writes without attribution fails it. |
| D8's narrowed clause is read as licence to ship joins that cross the boundary | D8 states the opposite explicitly: a crossing join has no permitted result. The product answer is O2's opaque reference, decided as policy. |

---

## 5. Compliance checklist

Additive to ADR 4 §7. In compliance when:

- [ ] `UserId` is a brand in `packages/model` (POD-301 family); no raw `z.string()` names a
      person in any model or projection schema.
- [ ] Owner / visibility / grant are **one** shared field group, composed — never redeclared
      per entity.
- [ ] Every attributed write carries the pair (actor, on-behalf-of) as two differently branded
      fields, both stamped from the transport principal (ADR 3 D7).
- [ ] Attribution stays on R1; provenance stays on the envelope (D3.8). Neither carries the
      other.
- [ ] No R4 projection carries a field whose value depends on the reader; per-user values live
      in `(userId, entityId)`-keyed aggregates composed from the shared key fragment.
- [ ] No `instance_id` (or equivalent tenant discriminator) column appears on any aggregate,
      projection or per-user state row.
- [ ] D7.3's rejected-alternatives clause reads as narrowed by D8 (slice, not world).

---

## 6. Self-verification record

Checked on integration tip `2ddfec21`, 2026-07-29:

| Claim | Where verified |
|---|---|
| D7.3 rejects server-side IVM with "the client already holds the world" | `docs/adr/0004-representation-policy.md` §2 D7 rejected-alternatives table, line 306 |
| D7.2 forbids O(entities) work on write/publish/fan-out; POD-736 harness gates it | `docs/adr/0004-representation-policy.md` §2 D7.2 and §7 checklist |
| D7.1 names `IssueWire`'s embedded `SessionMeta[]` as the canonical non-compliance | `packages/protocol/src/messages/issues.ts` — `sessions: z.array(SessionMeta)` (line 212), imported from `./runtime-state` |
| No `UserId` brand exists today | `packages/protocol/src/ids.ts` — declares `MachineId`, `SessionId`, `IssueId`, `RepoId`, `ConversationId`, `MutationId`, `ThreadId`; grep for `UserId` returns nothing |
| No owner / visibility / user column on any server table | `apps/server/src/migrations/schema.ts` — grep for `owner`, `visibility`, `user_id` returns nothing |
| Attribution is actor-only and unbranded | `packages/protocol/src/messages/issues.ts` — `humanQuestionAskedBy: z.string().optional()`, comment "sessionId of the agent session that asked" (lines 162–164) |
| `nameSource` is a role class, not a person | `packages/protocol/src/messages/runtime-state.ts` — `nameSource: z.enum(['user','agent']).optional()` (line 84) |
| `deletion_source` is bare text | `apps/server/src/migrations/schema.ts` — `deletionSource: text("deletion_source")` on `sessions` (line 48) |
| Per-user state is singleton-keyed today | `apps/server/src/migrations/schema.ts` — `pins` PK `(kind, id)`; `tab_order` PK `worktree`; `session_drafts` PK `session_id`; `snoozes` PK `session_id`; `read_at` columns on `sessions`, `issue_messages`, `issues` |
| Per-user fields ride today's wire projections | `packages/protocol/src/messages/runtime-state.ts` `readAt` (line 99), `snoozedUntil` (line 135); `packages/protocol/src/messages/issues.ts` `readAt` (line 193) |
| `Capability` is an authorization input with a constant `OPERATOR`, not an identity | `packages/domain/src/issue-authz.ts` — `interface Capability` (line 37, incl. optional `actorSessionId`), `OPERATOR` constant (line 47) |
| ADR 1 D5 makes `InstanceId` a deployment partition, not a row discriminator | `docs/adr/0001-authority-ownership.md` §2 D5 |
| ADR 1 D4's matrix carries the POD-304 totality obligation this amendment hangs annotations on | `docs/adr/0001-authority-ownership.md` §2 D4 |
| Human decision: C's mechanism with B's default; private by default; per-feature policy deferred | `docs/multi-user-readiness.md` header block and §3.1 |
| Open items O1–O4 are recorded as deliberately open upstream | `docs/multi-user-readiness.md` §3.1.2 (existence leaks, cross-boundary edges, inheritance on create) and §3.1.5 case 2 (reparent) |
| Attribution-is-a-pair direction | `docs/multi-user-readiness.md` §3.1.3 A3 |
| Per-user state named as a first-class set | `docs/multi-user-readiness.md` §3.1.1 table and §3.3 |

---

## 7. Status / sign-off path

| Stage | Owner |
|---|---|
| Proposed | integrator, under POD-359 (no leaf issue) |
| Pack reconciliation + index | POD-359 |
| Human approval | POD-359 human gate |
| Implemented | Phase 1 (POD-288 / POD-302 family); exit POD-423 |
