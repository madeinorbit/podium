# ADR 4 — Representation policy

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-17
- **Deciders:** architecture rewrite ADR pack (POD-359); human sign-off before Phase 1
- **Issue:** POD-750 (leaf of POD-359 item 4)
- **Consumers:** Phase 1 packages/model — POD-302, POD-364–368, POD-643 (and scaffolding POD-299/300/301/304)
- **Related ADRs:** ADR 1 (authority/ownership matrix), ADR 2 (sync protocol), ADR 3 (command security & lifecycle), ADR 6 (replica storage), ADR 7 (plane/message inventory), ADR 8 (package topology)

---

## Context

Podium currently restates session and issue field definitions in many places. At the
2026-07-16 drift refresh the inventory is on the order of **~9 session shapes** and
**~7 issue shapes**, including (non-exhaustively):

| Role (today) | Examples |
|---|---|
| Storage | `SessionRow`, `IssueRow` (`apps/server/src/store/types.ts`) |
| Live runtime | in-memory `Session` (registry / PTY ownership) |
| Wire / read | `SessionMeta`, `IssueWire`, graph/orphan/stats projections (`packages/protocol`) |
| Narrow ports | `HostSessionView`, `SessionNoticeInfo` |
| Portable export | `HandoffManifest` (`packages/protocol/src/messages/handoff.ts`) |
| Client viewmodels | e.g. `SessionCardModel`, issue nav views (`packages/client-core`) |

These shapes are **legitimately different**: a storage row is not a live PTY owner; a
wire snapshot is not a hibernation-candidate port; a handoff bundle is not a list card.
The defect is not the existence of multiple types — it is that each hand-restates the
same field meanings (`sessionId`, `title`, `resume`, `needsHuman`, …), so definitions
drift, audits cannot prove totality, and adding a field requires a scavenger hunt.

The 2026-07-13 adversarial review (finding 2, disposition on POD-279) rejected the
earlier "one shape" wording and adopted: **one semantic vocabulary** — one
authoritative definition per field/concept; representations **composed** from shared
schemas; narrow ports kept as named derivations. Deletion-audit items count
**hand-restated field definitions**, not type counts.

This ADR is the binding decision for that policy. Phase 1 implements it; later phases
consume it.

---

## Decision

**One semantic vocabulary, not one universal record.**

1. Every entity field/concept has **exactly one authoritative definition** in
   `packages/model` (L0 — zero workspace dependencies; see ADR 8 for package placement).
2. Four primary representation **roles** are first-class and intentionally distinct:
   - **Canonical durable aggregate** — the entity as domain truth (what is persisted and
     replicated after Authority arbitration).
   - **Live state** — runtime-only ownership and observation (PTY handles, controller
     fan-out, in-process agent phase pipelines, host metrics). Not a second durable
     source of truth for durable fields.
   - **Storage representation** — the physical row/blob shape for a given store
     (server SQLite, client IndexedDB/SQLite per ADR 6). May differ in naming
     (snake_case columns), nullability, and local-only columns.
   - **Wire / read projections** — schemas that cross a protocol boundary or feed a
     read model (`SessionMeta`, `IssueWire`, oplog values, tRPC-derived reads).
3. **Narrow ports remain.** Structural projections that deliberately expose a small
   field set to a single consumer (e.g. `HostSessionView`, `SessionNoticeInfo`) are
   **named derived projections**, composed from the same field schemas. They are not
   a loophole for hand-restated field lists.
4. **Composition, never redefinition.** Storage, live-state, wire/read, and narrow
   ports are built with explicit composition (`Pick` / `Omit` / `extend` / zod
   `.pick()` / shared field-schema objects). Adding a field to the shared schema either
   propagates to every representation that includes that field group **or fails
   compilation** where a deliberate inclusion decision is required.
5. **One documented store-row ↔ wire mapping function per entity** (and the inverse
   where needed). Mapping is code + documentation in model (or immediately adjacent
   store adapter code that imports only model field schemas), not tribal knowledge.
6. **Provenance is not entity payload.** Replica/sync provenance (`viaHub`,
   `upstreamStale`, `pendingSync`, and any future peer-origin flags) lives on a
   `ReplicatedEnvelope<T>` (or successor named by ADR 1 / POD-304), not restated inside
   every entity schema. Entity field schemas stay provenance-free.
7. **Optimistic UI is not a representation role.** Per-command optimistic reducers are
   declared on command contracts (ADR 3, POD-311). Ownership-matrix annotations
   (ADR 1) govern Authority arbitration only; they do **not** derive optimistic
   effects. The upstream-forwarder patch switch is characterized in Phase 1 (POD-367)
   and removed with the forwarder (Phase 2/3), not replaced by a dual path in model.
8. **Ids are branded at the vocabulary boundary.** Shared id field schemas use branded
   types (`SessionId`, `IssueId`, `RepoId`, `MachineId`, … per POD-301/360–363). Raw
   `z.string()` id fields in entity/projection schemas are an audit failure.

### Explicit non-goals

| Non-goal | Why |
|---|---|
| One universal `Session` / `Issue` type used everywhere | Live, storage, wire, and ports have different lifecycle and dependency needs (finding 2). |
| Collapsing live state into the durable aggregate | PTY ownership and in-process handles must not ride the oplog or client replica. |
| Putting storage columns on the wire "as the row" | Wire shapes are protocol contracts (ADR 7); storage may carry local-only columns and different nullability. |
| CRDT / free-merge of divergent field lists | Conflict rules are ADR 1 / Authority; this ADR only places **definitions**. |
| Inventing new product entities | Representation policy is structural; product meaning stays in specs/pspec. |

---

## Representation roles (normative)

### R1 — Canonical durable aggregate

- **Home:** `packages/model`
- **Purpose:** the entity's durable field set and invariants; the type Authority
  revisions describe and Replica materializes.
- **May include:** identity, user-authored and authority-authored durable attributes,
  tombstone/deletion fields, structural children that are part of the aggregate
  boundary (as decided per entity in the ownership matrix).
- **Must not include:** PTY handles, sockets, request resolvers, transport credentials,
  replica provenance flags, pure UI derivation that is not durable.

### R2 — Live state

- **Home:** L3 feature / host runtime (composed **field types** from model; live-only
  fields defined next to the owner).
- **Purpose:** process-local truth that dies with the process (or is re-derived on
  reattach). Examples: controller set, abduco/PTY handle, live geometry pump, agent
  runtime pipeline buffers.
- **Rule:** every durable field that appears on a live object is typed from the shared
  field schema (or the durable aggregate), not redeclared. Live-only fields are
  documented as live-only and never written to storage/wire as if durable.

### R3 — Storage representation

- **Home:** store adapters (server SQLite via drizzle-kit per SP-4428 / ADR 2 note;
  client stores per ADR 6). Field **meanings** still come from model.
- **Purpose:** physical persistence: column names, indexes, JSON blobs, local-only
  columns (e.g. hibernation signal timestamps that are not all on the public wire).
- **Rule:** storage types are compositions/mappings of model field schemas. Divergent
  nullability or encoding (ISO string vs epoch ms) requires an **explicit adapter** at
  the store boundary — not a second semantic definition. Twin predicate families
  (ISO-vs-epoch) collapse to one clock representation in model with edge adapters
  (POD-299).

### R4 — Wire / read projections

- **Home:** schemas defined in model; **frames** (message envelopes, unions, codec,
  handshake, plane taxonomy) stay in protocol (L1) and import entity projections
  (POD-300).
- **Purpose:** what peers and clients exchange: list snapshots, oplog values, lazy
  detail fetches, stats/graph slices.
- **Rule:** each projection is a named composition with a documented purpose (e.g.
  "full session list card", "issue board row", "comment thread body"). Derived
  server-side fields (`unread`, `ready`, `displayRef`, `sessionSummary`, …) are
  either:
  - computed in a pure function exported from model and applied at serialization, or
  - explicitly marked derived on the projection schema with the producer named —
  never silently re-specified with different meaning on another shape.

### R5 — Narrow ports (named derived projections)

- **Home:** co-located with the consumer module **or** in model when reused by ≥2
  consumers; always composed from shared field schemas.
- **Purpose:** dependency inversion — a service depends on a small structural type
  instead of the god registry object (`HostSessionView`, `SessionNoticeInfo`).
- **Rule:** a port that re-lists `sessionId: string` etc. by hand is a defect. Ports
  use `Pick`/shared schemas. New ports require a one-line purpose comment.

### R6 — Portable-export projections

- **Home:** model (entity-shaped); protocol keeps request/result **frames**.
- **Purpose:** durable packages that leave the live system (today: `HandoffManifest`).
- **Rule (POD-643):** `HandoffManifest` is a portable-export projection **composed**
  from shared session (and related) field schemas. The seven handoff request/result
  frames remain protocol frames. Bundle minting, source→target direction, and
  `exportedAt` / `sourceMachineId` provenance are ownership-matrix rows (ADR 1 /
  POD-304), not ad-hoc comments only on the zod object.

---

## Shared field schemas (composition plan)

### Units of authority

A **field schema** is the unit of semantic authority: name, zod (or equivalent) type,
branded id where applicable, nullability, and a short meaning comment. Field schemas
group into **field groups** when they always move together (e.g. needs-human
attribution: `needsHuman`, `humanQuestion`, `humanQuestionOptions`,
`humanQuestionAskedBy`, `humanQuestionAskedAt`).

### Composition operators (allowed)

- Zod: shared `z.object` fragments, `.merge`, `.pick`, `.omit`, `.extend`,
  discriminated unions for variants (`SessionOrigin`, …).
- TypeScript: `Pick`, `Omit`, `Readonly`, mapped types over those fragments.
- **Forbidden:** copy-paste of field lists; parallel `interface` that restates the same
  keys with `string` instead of the branded/shared type "for convenience".

### Mapping functions

For each replicated entity at minimum:

| Function | Responsibility |
|---|---|
| `toWire(aggregate | storage): WireProjection` | Exactly one documented path row/aggregate → wire |
| `fromWire` / `applyRevision` (as introduced by ADR 2 / kernel) | Wire/oplog value → durable aggregate materialization |
| `toStorage` / `fromStorage` | Aggregate ↔ storage row encoding |

Phase-1 acceptance (POD-302/366–368): oracle green; golden wire fixtures
byte-identical across the re-derivation (POD-360 fixtures, including handoff family).

### Server-derived vs durable fields

| Kind | Examples | Rule |
|---|---|---|
| Durable | `title`, `stage`, `issueId`, `name`/`nameSource` | Authority + storage; on wire as stored (after redaction rules from ADR 3) |
| Server-derived read | `unread`, `ready`, `blocked`, `displayRef`, `sessionSummary` | Pure functions in model (or feature pure helpers imported from model types); recomputed; never a second write path that fights durable fields |
| Live-only | controller sets, PTY handles, transient `handoffTarget` overlay while in-flight | Not in durable aggregate; may appear on wire as **ephemeral** fields only with explicit "live overlay" documentation |
| Provenance envelope | `viaHub`, `upstreamStale`, `pendingSync` | Envelope, not entity (POD-304) |

### Attribution and "who asked"

`humanQuestionAskedBy` / `humanQuestionAskedAt` are part of the needs-human **field
group** on the issue aggregate (server-authoritative attribution). They are not replica
provenance. One authoritative definition; every UI/CLI/MCP surface consumes that group.

---

## Inventory obligation (Phase 1)

POD-364 produces the characterization ledger: every current session/issue
representation, each field → authoritative meaning, legitimate role vs drifted
duplicate, and the composition plan (which shared field schemas exist; what each
representation `Pick`s). That plan is reviewed **against this ADR**.

Minimum representations the plan must place (refresh counts at the starting commit;
do not trust 07-13 numbers):

**Sessions (illustrative, non-exhaustive):** storage row; live registry session; wire
`SessionMeta`; agent-state sub-object; narrow ports (`HostSessionView`,
`SessionNoticeInfo`); portable export (`HandoffManifest`); client viewmodels that
currently restate fields.

**Issues (illustrative):** storage row; wire `IssueWire`; comments (lazy detail);
graph/orphan/stats/search projections; closed/patch subsets; panel; any automation
"fresh spawn tuple" that restates session spawn fields (flag as 1.4 candidate).

New shapes that land after this ADR (e.g. future export formats) must declare a role
R1–R6 and compose from shared schemas before merge.

### Scope beyond sessions and issues

Phase 1's cutting edge is sessions and issues (POD-302 family). The **same policy**
applies when other entities enter or move through model: conversations, machines,
automations (`AutomationWire` schedule fields), feature flags, transcript items, and
any future aggregate. Drift-refresh fields (issue colour, needs-human attribution,
`workingMsTotal`, agent colour, daemon ack flags, etc.) are placed by the inventory
into shared schemas — they do not get one-off parallel types. **Instance identity**
(`InstanceId` / SP-15aa) is an identity brand if it is a model concept; whether it is
a first-class vocabulary entity vs a runtime-only concern is decided with ADR 1 and
ADR 8 / POD-645 — this ADR only requires that, if modeled, it not be hand-restated.

---

## Alignment with Phase-1 issues

| Issue | How this ADR binds it |
|---|---|
| **POD-302** | Parent epic of the vocabulary cutover: zero hand-restated field definitions; distinct lifecycle types preserved; one store↔wire map per entity. |
| **POD-364** | Field-schema inventory + composition plan; reviewed against this ADR. |
| **POD-365** | Canonical Session/Issue aggregates + shared field schemas land in `packages/model` with no consumer cutover yet; conformance review cites this ADR. |
| **POD-366** | Session representations re-derived; drifted duplicates deleted; e2e green. |
| **POD-367** | Issue representations re-derived; optimistic-patch switch **characterized only** (not deleted here); reducers land with POD-311. |
| **POD-368** | Audit to zero; every retained representation documented with purpose in model. |
| **POD-643** | `HandoffManifest` = R6 portable-export projection; frames stay protocol; ownership row for bundle with ADR 1. |
| **POD-299 / 300** | Scaffold model; move entity schemas out of protocol — mechanical prerequisites. |
| **POD-301 / 360–363** | Branded ids on shared field schemas. |
| **POD-304** | Ownership annotations + provenance envelope; annotations do not invent optimistic UI. |

---

## Cross-ADR boundaries

| Concern | Owner |
|---|---|
| Who may write a field; conflict rule; tombstones; secrets | **ADR 1** (ownership matrix); model carries annotations, Authority enforces |
| Oplog value shape, cursor/revision, bootstrap snapshots | **ADR 2**; values are R4 projections of aggregates |
| Command I/O schemas, redaction, optimistic reducers | **ADR 3**; I/O field types import model field schemas |
| Client DB engine (IndexedDB/SQLite) | **ADR 6**; storage encoding still maps through model |
| Which messages are control/stream/bulk | **ADR 7**; entity payloads still this ADR |
| `packages/model` placement, typecheck graph | **ADR 8** |
| Server DB migrations tool (drizzle-kit) | Fact (SP-4428); **wire/replica schema version ≠ drizzle journal** (ADR 2) |

---

## Consequences

### Positive

- One place to change a field's meaning; compiler-driven fan-out or hard fail.
- Legitimate multi-shape design without definitional drift.
- Deletion audit becomes meaningful (hand-restated definitions → 0).
- Phase 2+ kernel and commands receive stable types instead of inventing local DTOs.
- Handoff and future export formats join the same discipline (POD-643).

### Negative / cost

- Up-front inventory and composition work (POD-364–368) before behavior changes.
- Some ergonomic "just add a string field on this interface" patches become forbidden;
  agents must extend the shared schema.
- Narrow ports require a little more type machinery (`Pick`/fragments) than anonymous
  structural types.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| "Composition" becomes copy-paste with extra steps | Audit items + review of POD-364 plan against this ADR; greps necessary but not sufficient (ledger §3). |
| Live fields accidentally durable | R2 documentation + ownership matrix offline/live classes (ADR 1). |
| Wire fixtures break silently | Golden fixtures (POD-360) byte-identical gate on POD-366/367/643. |
| Viewmodels restate fields client-side | Client viewmodels either compose from model or take wire projections as input without redeclaring entity fields (POD-368 audit scope includes client restatements of session/issue concepts). |

---

## Compliance checklist (for implementers and reviewers)

A change is **in compliance** with this ADR when:

- [ ] New entity fields are added once in `packages/model` field schemas / aggregates.
- [ ] Every representation that needs the field composes it (or is deliberately omitted
      with a comment).
- [ ] No new hand-restated field list for session/issue (or other model entities) concepts.
- [ ] New narrow ports are named, purpose-documented, and `Pick`/schema-composed.
- [ ] Portable exports (handoff and successors) are R6 projections, not parallel zod islands.
- [ ] Provenance stays on the envelope; optimistic behavior stays on command contracts.
- [ ] Store↔wire mapping for the entity remains a single documented function pair.
- [ ] Wire golden fixtures remain green when representations are re-derived.

A change is **out of compliance** when it introduces a parallel `sessionId: string`
(or equivalent) field list that is not derived from the shared schema, even "just for
this module."

---

## Status and sign-off

| Stage | Owner |
|---|---|
| Proposed | POD-750 (this document) |
| Pack reconciliation + index | POD-359 |
| Human approval | POD-359 human gate (`needs-human` + signed ADR frontmatter) |
| Implemented | Phase 1 (POD-288 / POD-302 family); exit gate POD-423 |

Until human sign-off of the ADR pack, Phase 1 must not treat alternate representation
strategies as authorized. Amendments after sign-off require an ADR update and
POD-359/tracker reconciliation.
