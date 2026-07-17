# ADR 4 — Representation policy

| | |
|---|---|
| **Status** | Proposed (human gate on POD-359) |
| **Date** | 2026-07-17 |
| **Issue** | POD-750 (POD-359 item 4 leaf) |
| **Base tip verified** | `ca361327` (issue/279-integration) |
| **Consumers** | Phase 1 model work: POD-302, POD-364, POD-365, POD-366, POD-367, POD-368, POD-643; scaffolds POD-299, POD-300, POD-301, POD-304 |
| **Forward refs** | ADR 1 (ownership), ADR 2 (sync protocol), ADR 3 (command security/lifecycle), ADR 6 (replica storage), ADR 7 (plane inventory), ADR 8 (package topology) |
| **File discipline** | This leaf owns **only** `docs/adr/0004-representation-policy.md`. No index. No ledger edits (LEDGER-ENTRY comments on the issue if needed). |

---

## 1. Context

### 1.1 Problem

Session and issue **field meanings** are hand-restated across many product types.
Types legitimately differ by role (storage vs live vs wire vs port), but each
redeclares `sessionId` / `title` / `resume` / `needsHuman` / … with independent
`string` / zod literals. Definitions drift; adding a field is a scavenger hunt;
deletion audits that count “number of types” punish legitimate narrow ports.

POD-279 adversarial review finding 2 (disposition on POD-279, 2026-07-13): the
target is **not** one literal record. The defect is **hand-restated field lists**.
Audit items count hand-restated field definitions, not type counts.

POD-359 item 4 requires this ADR to lock: one semantic vocabulary; canonical
durable aggregate, live state, storage representation, wire/read projections
**composed** from shared field schemas; narrow ports remain; **NOT** one
universal record.

### 1.2 Re-derived inventory (integration tip `ca361327`)

**Defining predicate (session representation, 1.4 class):** a named product type
(interface, class, or `z.object`) that independently declares **≥2** session-concept
field keys (identity, cwd, status, resume, agentKind, title/name, machineId, …)
with local type literals — i.e. not composed from a shared model field schema
(because `packages/model` does not exist yet on this tip).

**Core session representations (re-derived; each path verified present):**

| # | Symbol | Path | Role today |
|---|---|---|---|
| 1 | `SessionRow` | `apps/server/src/store/types.ts` | storage (36 keys counted) |
| 2 | `Session` (class) | `apps/server/src/modules/sessions/session.ts` | live runtime + PTY ownership |
| 3 | `SessionMeta` | `packages/protocol/src/messages/runtime-state.ts` | wire/read (44 keys counted) |
| 4 | `HostSessionView` | `apps/server/src/modules/hosts/service.ts` | narrow port (hibernate scan) |
| 5 | `SessionNoticeInfo` | `apps/server/src/modules/notify/service.ts` | narrow port (attention) |
| 6 | `HandoffManifest` | `packages/protocol/src/messages/handoff.ts` | portable export (18 keys) |
| 7 | `RpcSessionView` | `apps/server/src/modules/machines/rpc.ts` | narrow port (daemon RPC) |
| 8 | `ResumableSession` (+ `HeadlessFields`) | `packages/domain/src/session-identity.ts` | structural port (dedupe) |
| 9 | `HandoffSession` | `packages/domain/src/machine-selection.ts` | structural port (target pick) |

**Additional session-shaped ports (same predicate; inventory must place them):**
`ConciergeSessionInfo` (`apps/server/src/modules/superagent/concierge.ts`),
`BtwSessionInfo` (`…/btw.ts`), `FocusSessionInfo` (`…/global.ts`),
`AnswerTargetSession` (`…/answer-delivery.ts`),
`CloudAgentSourceSession` (`apps/server/src/cloud-runtime.ts`),
`LakeReadSession` (`apps/server/src/modules/conversations/service.ts`),
`SessionCardModel` (`packages/client-core/src/viewmodels/session-card.ts` — mostly
UI-derived fields plus restated `sessionId`),
drizzle table `sessions` (`apps/server/src/migrations/schema.ts` — physical storage DDL).

**Count claim:** under the tight predicate, **≥9** distinct session representations
exist on this tip (the nine core rows). Extended ports push the live count into
the mid-teens. Do **not** trust the frozen “~8” from 2026-07-13; POD-364 must
re-count at its starting commit with this predicate (or a documented refinement).

**Defining predicate (issue representation, 1.4 class):** same idea for issue-concept
fields (id, stage, title, repo, needsHuman, …).

| # | Symbol | Path | Role today |
|---|---|---|---|
| 1 | `IssueRow` | `apps/server/src/store/types.ts` | storage |
| 2 | `IssueWire` | `packages/protocol/src/messages/issues.ts` | wire/read (71 keys counted) |
| 3 | `CreateIssueInput` | `apps/server/src/modules/issues/service/types.ts` | command input (hand-restates many issue fields) |
| 4 | `IssuePatch` | same file | mutation patch — **already** `Partial<Pick<IssueRow, …>>` (good composition pattern) |
| 5 | `OrphanIssue` | `packages/protocol/src/messages/issues.ts` | wire projection |
| 6 | `IssueGraphNode` | same | wire projection |
| 7 | `IssueTreeNode` / tree types | `apps/server/src/modules/issues/service/types.ts` | server graph |
| 8 | `HandoffIssue` | `packages/domain/src/machine-selection.ts` | structural port |

**Not counted as entity restatement:** web UI `IssueRow` in
`apps/web/src/features/issues/issue-hierarchy.ts` wraps `issue: IssueWire` plus
depth/expanded chrome — it does not redeclare issue field keys.

**Count claim:** **≥7** issue representations under the predicate (rows 1–8, with
tree types collapsible). POD-364 re-counts at start.

**Verified absences on this tip:** `packages/model` does **not** exist yet (POD-299
creates it). Branded ids exist partially in `packages/protocol/src/ids.ts` but
entity schemas still use raw `z.string()` for ids (e.g. `SessionMeta.sessionId`).

### 1.3 What this ADR decides vs what it does not

| In scope | Out of scope (forward ref) |
|---|---|
| Where field meanings live; how representations compose | Who may write a field / conflict rules → **ADR 1** |
| Roles R1–R6 and composition rules | Oplog cursor/revision/wire version vs drizzle journal → **ADR 2** |
| Store↔wire mapping obligation | Command auth, optimistic reducers on contracts → **ADR 3** |
| HandoffManifest as portable-export projection | Message plane classification of handoff frames → **ADR 7** |
| Model as vocabulary home | Package graph / typecheck topology for new packages → **ADR 8** |
| InstanceId placement *if modeled* | Instance vs machine ownership → **ADR 1** + POD-645; package home → **ADR 8** |

---

## 2. Decisions

### Decision D1 — One semantic vocabulary, not one universal record

**Decision:** Every entity field/concept has exactly one authoritative definition in
`packages/model` (L0). Storage, live-state, wire/read, narrow ports, and portable
exports are **distinct types** composed from shared field schemas. We do **not**
collapse the system onto a single `Session` / `Issue` type used everywhere.

**Rationale:** Live PTY ownership, durable rows, wire snapshots, and hibernate ports
have different dependencies and lifecycles. Forcing one type either leaks handles
onto the wire or erases needed live fields. Finding 2 already rejected “one shape.”

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| **One universal record** (single Session/Issue type everywhere) | Finding 2: storage/live/wire/ports are legitimately distinct; one type causes handle leaks or field loss. |
| **Keep hand-restated parallel types** (status quo) | Documented drift; audit cannot prove field totality; POD-302 ACs fail. |
| **Generate all types from DB schema alone** | Wire and live semantics are not a 1:1 of SQLite columns (derived fields, live overlays, redaction). Drizzle schema is storage DDL (SP-4428), not the semantic vocabulary. |
| **Protocol package owns the vocabulary** | Protocol is L1 frames + transport; entity meanings must be importable by store/domain without pulling wire unions (layering; POD-300 moves entities *out* of protocol). |

### Decision D2 — Representation roles (R1–R6)

**Decision:** Every session/issue (and later every model entity) representation
declares exactly one of:

| Role | Purpose | Home (target) |
|---|---|---|
| **R1 Canonical durable aggregate** | Domain truth Authority revises / Replica materializes | `packages/model` |
| **R2 Live state** | Process-local ownership (PTY, controllers, pipelines); durable fields typed from shared schemas | L3 runtime modules |
| **R3 Storage representation** | Physical row/blob encoding for a store | Store adapters; meanings from model |
| **R4 Wire / read projection** | Protocol payloads and read models | Schemas in model; **frames** stay in protocol |
| **R5 Narrow port** | Small structural dependency for one consumer | Consumer module or model if reused ≥2× |
| **R6 Portable export** | Offline package that leaves the live system | Model entity shape; protocol keeps request/result frames |

**Rationale:** Names the legitimate multi-shape design so audits stop punishing ports
and start punishing hand-restated field lists.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Only “wire + DB” | Ignores live Session and ports that already exist and must stay. |
| Ports as freehand structural types forever | Ports are legitimate; freehand field re-lists are the drift vector. |
| Treat HandoffManifest as a protocol-only one-off | POD-643 / POD-302 drift: it restates session fields; same class as SessionMeta. |

### Decision D3 — Composition rules (shared field schemas)

**Decision:**

1. **Field schema** = unit of authority: name, zod (or equivalent) type, brand,
   nullability, meaning comment. Related keys form **field groups** (e.g. needs-human:
   `needsHuman`, `humanQuestion`, `humanQuestionOptions`, `humanQuestionAskedBy`,
   `humanQuestionAskedAt` — all on `IssueWire` today at
   `packages/protocol/src/messages/issues.ts`).
2. Representations compose via shared fragments / `.pick()` / `.extend()` /
   `Pick`/`Omit` — never by copy-pasting key lists with fresh `z.string()`.
3. Adding a model field either propagates to every representation that includes that
   field group **or fails compilation** where inclusion is a deliberate decision.
4. **One documented store-row ↔ wire mapping function per entity** (and the inverse
   as the kernel lands). Mapping is code, not tribal knowledge.
5. **Ids branded** at the vocabulary boundary (`SessionId`, `IssueId`, `RepoId`,
   `MachineId`, … per POD-301 family). Raw `z.string()` entity ids in model/projection
   schemas are audit failures after the flip.
6. **Server-derived read fields** (`unread`, `ready`, `blocked`, `displayRef`,
   `sessionSummary`, …) are pure functions over durable (+ live inputs where needed),
   documented as derived — not a second write path.
7. **Live-only fields** (controller sets, PTY handles, in-flight `handoffTarget`
   overlay on `SessionMeta` today) are documented live/ephemeral; they are not R1
   durable aggregate members.
8. **Provenance is not entity payload.** `viaHub` / `upstreamStale` / `pendingSync`
   (present on `SessionMeta` / `IssueWire` today) move to a `ReplicatedEnvelope<T>`
   (or successor named by ADR 1 / POD-304). Entity field schemas become
   provenance-free.
9. **Optimistic UI is not a representation role.** Command-specific optimistic
   reducers live on command contracts (ADR 3, POD-311). Ownership annotations
   (ADR 1) govern Authority arbitration only and **must not** derive optimistic
   effects (POD-302 correction; second-round item 5). The upstream-forwarder
   per-proc patch switch is characterized in POD-367 and removed with the
   forwarder — not dual-pathed in Phase 1 model.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Ownership annotations drive optimistic patches | Second-round disposition: arbitration ≠ optimistic effects. |
| Keep provenance flags on every entity schema | POD-304: envelope at replica boundaries; entities stay clean. |
| Multiple ad-hoc mappers per hop | Guarantees drift; POD-302 AC requires one map function per entity. |
| ISO and epoch dual semantics in model | POD-299: collapse twin predicate families to one clock representation; adapters at edges. |

### Decision D4 — HandoffManifest is R6 (portable export)

**Decision:** `HandoffManifest` (`packages/protocol/src/messages/handoff.ts`) is an
R6 projection **composed** from shared session (and related) field schemas in model.
The eight handoff request/result message types remain **protocol frames** (plane
classification is ADR 7; count verified: 4 request/result pairs in
`packages/protocol/src/messages/handoff.ts`). Bundle minting, source→target direction, and
`exportedAt` / `sourceMachineId` provenance are **ownership-matrix rows** (ADR 1 /
POD-304 / POD-643), not comments-only on the zod object.

**Rationale:** Manifest keys today include `sessionId`, `agentKind`, `resume`,
`repoId`, `issueId`, `sourceMachineId`, worktree fields — the same drift class as
SessionMeta. POD-302 drift refresh and POD-643 require composition.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Leave as permanent protocol-only island | Explicitly the drift class 1.4 targets. |
| Fold into SessionMeta | Different lifecycle (portable package vs live list card); wrong role. |
| Move frames into model | Frames are transport/request-reply (L1); only entity-shaped manifest moves (POD-300 rule). |

### Decision D5 — Scope of the vocabulary (sessions/issues first, policy general)

**Decision:** Phase 1 implements the policy for **sessions and issues** (POD-302
family). The **same rules** apply when other entities move into model:
conversations, machines, automations (`AutomationWire` in
`packages/protocol/src/messages/automations.ts` — `scheduleKind`, `cron`, `runAt`,
`targetSessionId`, …), feature state (`FeatureState` in
`packages/protocol/src/features.ts`), transcript items, etc. Automation “fresh”
spawn tuples that restate session spawn fields are 1.4 candidates (POD-364 drift).

**Instance identity:** `packages/runtime/src/instance.ts` defines runtime instance
ids (`DEFAULT_INSTANCE_ID`, `validateInstanceId`, `resolveInstanceId`) under
[spec:SP-15aa]. Whether `InstanceId` becomes a model brand vs stays runtime-only is
**ADR 1 + ADR 8 / POD-645**. This ADR only requires: if it is modeled, it is not
hand-restated across packages.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Policy only for SessionMeta/IssueWire forever | Automations/features already restate ids and schedules; drift will recur. |
| ADR 4 decides InstanceId package home | Ownership + package topology concerns; wrong ADR. |

### Decision D6 — Storage encoding vs semantic definition

**Decision:** Server SQLite schema-as-code is authored with **drizzle-kit**
(`apps/server/src/migrations/schema.ts`, [spec:SP-4428]). That is the **R3 physical**
authoring tool on the server — **not** the semantic vocabulary. Field meanings still
live in model; storage types/columns map through adapters. Wire/replica protocol
version is distinct from the drizzle journal (ADR 2). Client replica stores
(ADR 6) are not drizzle-managed.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Treat drizzle schema as the one vocabulary | Couples domain meaning to one engine; clients and wire cannot share it. |
| Ignore drizzle in representation discussions | Physical columns already diverge from SessionMeta (e.g. hibernation timestamps on `SessionRow` only). Mapping must be explicit. |

### Decision D7 — Normalization and derivation locality (amendment 2026-07-17)

*Added by human decision on POD-279 (2026-07-17), motivated by POD-701/POD-772 entry 1:
`IssueWire` embeds derived member `SessionMeta[]`, so any one-field session change
forces an O(world) rebuild of every issue's wire payload (p50 711ms ×2 per switch at
530-session scale). This is the failure class every mature sync engine (Rocicorp Zero,
ElectricSQL/PowerSync, Replicache/Linear) makes unrepresentable by construction. These
rules make it unrepresentable here.*

**D7.1 — Normalization law (wire).** A replicated entity references other entities by
**branded id only**. An R4 wire/read projection MUST NOT embed another entity's
projection (no entity-in-entity nesting on the feed). Cross-entity read models are not
wire shapes; they are assembled at the replica (D7.3) or materialized as their own
entity (D7.4). `IssueWire`'s embedded `SessionMeta[]` is the canonical
non-compliance and is deleted at the Phase-2 cutover (POD-308).

**D7.2 — Derivation locality (write/fan-out path).** A change to entity X may trigger
recomputation only of projections **of X**. No code on the write, publish, or fan-out
path may perform work O(number of entities) per change. This is a testable invariant:
the switch-latency harness (POD-701/POD-736) gates it — publish cost must be
independent of world size. Interim dirty-set shims (POD-722/723) are scar tissue on
the pipeline POD-308 deletes, not compliance.

**D7.3 — Derived views are replica-side queries.** Cross-entity read models (issue
trees, boards, joined lists) are incrementally maintained views over the client
replica. Invalidation is keyed by `(entityId, revision)` (ADR 2 D3's revision token is
the dependency-tracking key). Implementation is Phase 6's call (POD-293): revision-keyed
memoized selectors + `useSyncExternalStore` bindings, or TanStack DB 0.6 `includes`
(one incremental query graph) pending the 0.6 re-evaluation. Either way the kernel
replica stays UI-framework-agnostic; no transparent-reactivity framework (MobX etc.)
is adopted without a measured-pain spike behind this seam.

**D7.4 — Server-maintained deriveds are entities.** A derived value that cannot be a
replica-side join (e.g. a rollup over data the client does not hold) becomes a
first-class materialized entity: updated **incrementally by the command that changes
its input**, inside the same `Ledger.commit()` transaction, carrying its own
`revision`, flowing through the normal feed. It is never recomputed at fan-out or
read time.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Keep composed wire trees + server dirty-tracking per consumer | POD-772 entry 1: every object type must hand-roll dirty tracking; O(world) recurs by default. |
| Server-side IVM engine (Figma LiveGraph style) serving joined views | Pays for machinery replica-local joins get free at Podium scale; the client already holds the world. |
| Adopt MobX/signals now for D7.3 | Two reactivity paradigms; proxy-semantics bugs are a shipped incident class (POD-170); revision keys suffice at current derivation-graph size. |

---

## 3. Drift-refresh clauses (POD-359 + Phase-1 issues) — explicit absorption

| Source | Clause | How ADR 4 absorbs it |
|---|---|---|
| POD-359 DRIFT 1 (1) | drizzle-kit is fact; wire version ≠ drizzle journal | **D6**: server R3 uses drizzle; vocabulary is model; version split is ADR 2. |
| POD-359 DRIFT 1 (2) | Instance identity place in ownership vocabulary + package topology | **D5**: not decided here; if modeled, no hand-restatement; ADR 1/8/POD-645. |
| POD-359 DRIFT 1 (3) | Handoff family + messaging + workflows more plane surface | Frames → ADR 7; **manifest entity shape** → **D4** R6. |
| POD-359 DRIFT 2 (1) | Build orchestration / tsgo / turbo / source-conditions | ADR 8 only; model scaffold must follow ADR 8 when POD-299 lands (out of this file). |
| POD-359 DRIFT 2 (2) | browser-open + sessionResumeRefAck; host↔server ≠ agent relay | ADR 7 principles; entity fields those messages carry still compose from model when entity-shaped. |
| POD-359 UPDATE | turbo+tsgo landed; source-conditions stay interim | ADR 8 ratification; no representation change. |
| POD-359 DECOMPOSED | One file per ADR leaf; no index by leaf | Obeyed: only this file. |
| POD-302 DRIFT | HandoffManifest ~9th projection; needs-human attribution | **D4**; needs-human field group in **D3**. |
| POD-364 DRIFT 1 | Counts understated; color, needsHuman*, workingMsTotal, agentColor | Inventory §1.2; fields verified on tip: `IssueWire.color`, `needsHuman`/`humanQuestion*`/`humanQuestionAskedBy`/`humanQuestionAskedAt`; `AgentRuntimeState.workingMsTotal`; `SessionMeta.agentColor`. |
| POD-364 DRIFT 2 | DaemonAck.ackRequested?, AutomationWire schedule fields, FeatureState, automation approval spawn tuple | **D5** general policy; inventory places them in POD-364. `ackRequested` verified optional on daemon resume-ref message (`packages/protocol/src/messages/daemon.ts`). |
| POD-300 DRIFT | HandoffManifest entity → model; 8 frames stay protocol | **D4** + R4/R6 split. |
| POD-304 DRIFT | needs-human attribution placement; handoff/bundle ownership row | Attribution = entity field group (**D3**); bundle row = ADR 1 (**D4**). |
| POD-299 DRIFT | issue-color + handoff target selection in domain absorb | Domain predicates move into model (POD-299); field schemas still authoritative for colours/slots. |

---

## 4. Mapping and derived-field rules (normative detail)

### 4.1 Per-entity mapping

For each replicated entity at minimum:

| Function | Responsibility |
|---|---|
| `toWire` | Durable aggregate or storage row → R4 projection |
| `fromWire` / revision apply | Oplog/wire value → R1 materialization (with ADR 2 kernel) |
| `toStorage` / `fromStorage` | R1 ↔ R3 encoding (nullability, JSON columns, split resume fields) |

Example of **today’s** encoding split that composition must preserve: `SessionRow`
uses `originKind` + `conversationId` + `resumeKind`/`resumeValue`; `SessionMeta`
uses `origin: SessionOrigin` and `resume?: ResumeRef`. One mapping function owns
that bijection — not two hand-maintained shapes.

### 4.2 Field kind table

| Kind | Examples (verified on tip) | Rule |
|---|---|---|
| Durable | `title`, `stage`, `issueId`, `name`/`nameSource` | R1 + R3; on wire after redaction (ADR 3) |
| Server-derived read | `unread`, `ready`, `blocked`, `displayRef`, `sessionSummary` | Pure functions; recompute |
| Live / ephemeral wire | `controllerId`, `clientCount`, `busy`, `handoffTarget` | Not R1; may appear on R4 with live-overlay docs |
| Provenance | `viaHub`, `upstreamStale`, `pendingSync` | Envelope (POD-304), not entity |
| Storage-local | `SessionRow.lastOutputAt` / `lastInputAt` / `lastResumedAt`, tombstone columns | R3; ports like `HostSessionView` may expose via composition + epoch adapters |

---

## 5. Phase-1 binding

| Issue | Binding |
|---|---|
| **POD-302** | Parent: zero hand-restated session/issue field definitions; distinct roles preserved; one store↔wire map per entity. |
| **POD-364** | Inventory + composition plan against **this ADR**; re-count with §1.2 predicate at start commit. |
| **POD-365** | Land R1 aggregates + shared field schemas in `packages/model`; no consumer cutover yet. |
| **POD-366** | Re-derive session R2–R6; delete drifted duplicates; e2e green; fixtures byte-stable. |
| **POD-367** | Re-derive issue representations; **characterize** optimistic-patch switch only (no delete here). |
| **POD-368** | Audit to zero; document every retained representation’s purpose in model. |
| **POD-643** | HandoffManifest R6 composition; brand ids; ownership row with ADR 1; fixtures byte-identical. |
| **POD-299 / POD-300** | Scaffold model; move entity schemas out of protocol (frames stay). |
| **POD-301 / POD-360…** | Branded ids + golden fixtures. |
| **POD-304** | Envelope + ownership annotations; no optimistic derivation. |
| **POD-423** | Phase 1 exit gate consumes conformance to this ADR. |

---

## 6. Consequences

### Positive

- One authoritative field definition; compiler-driven fan-out or hard fail.
- Legitimate multi-shape design without definitional drift.
- Deletion audit measures the real defect (hand-restated definitions → 0).
- Later phases receive stable types instead of local DTOs.

### Cost

- Up-front inventory (POD-364) and composition work (POD-365–368, POD-643).
- “Just add a string field on this interface” becomes non-compliant.

### Risks

| Risk | Mitigation |
|---|---|
| Composition becomes copy-paste with ceremony | Audit + POD-364 plan review against this ADR; greps necessary not sufficient. |
| Live fields become durable | R2 rules + ADR 1 offline/live classes. |
| Wire fixtures break | POD-360 golden fixtures; POD-366/367/643 byte-identical gate. |
| Client viewmodels restate entity fields | POD-368 audit includes client restatements of session/issue concepts. |

---

## 7. Compliance checklist

**In compliance** when:

- [ ] New entity fields land once in `packages/model` field schemas / R1 aggregates.
- [ ] Every representation that needs the field composes it (or deliberately omits it).
- [ ] No new hand-restated session/issue field lists.
- [ ] New narrow ports are named, purpose-documented, and schema-composed (R5).
- [ ] Portable exports are R6 compositions; frames stay protocol.
- [ ] Provenance stays on the envelope; optimistic behavior stays on command contracts (ADR 3).
- [ ] Store↔wire mapping remains one documented function pair per entity.
- [ ] Wire golden fixtures stay green across re-derivation.
- [ ] No R4 projection embeds another entity's projection; cross-entity references are branded ids (D7.1).
- [ ] No write/publish/fan-out code path is O(entities) per change (D7.2; gated by the POD-736 harness).
- [ ] Cross-entity read models live replica-side keyed by `(entityId, revision)`, or are D7.4 materialized entities.

**Out of compliance:** a parallel `sessionId: string` (or equivalent) field list not
derived from the shared schema — even “just for this module.”

---

## 8. Status / sign-off path

| Stage | Owner |
|---|---|
| Proposed | POD-750 (this document) |
| Pack reconciliation + index | POD-359 |
| Human approval | POD-359 human gate |
| Implemented | Phase 1 (POD-288 / POD-302 family); exit POD-423 |

Amendments after pack sign-off require an ADR update and tracker reconciliation on POD-359.
