# The branded-id flip — POD-361 deliverable record

**Issue:** POD-361 (1.3b Flip model schemas to branded ids; composite-key helpers move to model),
Phase 1 child of POD-301. **Follows** POD-360's characterization (`docs/rearch-id-inventory.md`).
**Feeds** POD-362 (server + daemon adoption), POD-363 (clients + CLI, audit to zero), POD-1075
(user accounts and identity model), POD-1076 (per-user state family), POD-318 (retire the machine
sentinels).

**Governing decisions:** ADR 4 Amendment 1 D9/D10, ADR 1 Amendment 2 D16.2, ADR 9 D2/D3/D6,
`docs/multi-user-readiness.md` §3.1.3 A3 / §3.1.4 M1 / §3.2 / §3.3. Where the brief and the
readiness doc differed, the readiness doc won — it added `UserId` and the two key shapes to this
issue's scope.

---

## 1. What landed

| | |
|---|---|
| Brands + composite keys | Moved from `@podium/protocol` (`ids.ts`, `planes/principal.ts`) to `packages/model/src/ids/`, the L0 root. API documented in `packages/model/src/ids/README.md`. |
| Id fields flipped | Every id field in `packages/model/src/entities/` that names a Podium-minted entity, **except** the machine-id carve-out (§2). |
| `UserId` | Defined here, beside the other seven brands (§5). |
| Key shapes | `(UserId, EntityRef)` and `(GrantSubject, EntityRef)` as first-class shapes, no caller-side concatenation (§6). |
| Attribution | Flipped to the correct **current** brand; the cohort handed forward as a list (§4). |
| Wire | **Unchanged.** 137 pre-existing golden cases, 0 missing, 0 changed, 50 added — the added ones are the new id schemas themselves. 26 of 27 family files byte-identical, the 27th insertions-only. |
| Consumers | **None adopted.** 63 marked edge casts keep the repo green; enumerated in §7 for POD-362/POD-363 to remove. |

Two schemas per brand, and it matters: `SessionId` is the `.min(1)` validating boundary the ADRs
quote; `SessionIdField` is the brand with **no added validation**, for use inside a schema. Every id
field was a bare `z.string()` and at least one producer relies on that (`apps/server`'s
`sessions/service.ts` builds `{ kind: 'resume', conversationId: r.conversationId ?? '' }`), so
putting `.min(1)` on a field would turn a payload that parses today into a parse failure — a
behaviour change wearing a type change's clothes. `brands.test.ts` pins it per schema.

---

## 2. The `MachineId` carve-out — adopted at ZERO fields

ADR 1 Amendment 2 D16.2 rule 2 is normative and this is the whole of it:

> POD-318's migration must retire `local` and `__local__` BEFORE `MachineId` branding is applied at
> any site that can hold either value. … If branding must land first for an unrelated reason, the
> sentinel sites are carved out and left as raw strings until the migration lands.

`MachineId` validates length, not shape, so `MachineId.parse('local')` **succeeds**: branding a
sentinel launders it rather than flagging it, and afterwards no type, test or reviewer can tell it
from a real identity.

**The carve-out is all seven sites, not a subset** — each is downstream of one of the three column
DEFAULTs (`sessions.machine_id`, `conversations.machine_id`, `repos.machine_id`) or of
`LOCAL_MACHINE_ID = 'local'`:

| Site | Sentinel reaches it via |
|---|---|
| `MachineWire.id` | `ensureLocalMachine` upserts the row with `id: 'local'` — the sentinel's source |
| `SessionMeta.machineId` | `sessions.machine_id` DEFAULT `'__local__'`; `store/sessions.ts` also substitutes it on read |
| `GitRepositoryWire.machineId` | `repos.machine_id` DEFAULT `'__local__'` |
| `HostMetricsWire.machineId` | server-filled from the machine row |
| `MachineQuotaWire.machineId` | server-filled from the machine row |
| `IssueWire.machineId` | resolved to the local machine when unset |
| `HandoffManifest.sourceMachineId` | stamped by an exporter on the bundled local daemon |

All seven use `machineIdBlockedOnPOD318` — the same `z.string()` at runtime, with a name that says
why. **This is a ratchet, not a comment:** `brands.test.ts` scans `entities/` for every property
whose name is a machine-id *shape* (plus `MachineWire`'s own `id`, which the name detector cannot
see) and fails if any is bound to `MachineIdField`. Mutation-verified in both directions — branding
`SessionMeta.machineId` and branding `MachineWire.id` each fail the assertion that names them, and
a separate assertion proves the scan sees ≥6 sites, so "no offenders" cannot mean "no matches".

**POD-318:** flip these seven to `MachineIdField` in one commit after the migration lands, and
delete `machineIdBlockedOnPOD318`; the ratchet then fails until its own scan is deleted, which is
the intended handshake.

---

## 3. Per-field disposition

### Branded

| Schema | Fields | Brand |
|---|---|---|
| `SessionMeta` | `sessionId` | `SessionId` |
| | `issueId`, `refIssueId` | `IssueId` |
| | `conversationPodiumId` | `ConversationId` |
| | `accountId` | `AccountId` |
| `IssueWire` | `id`, `parentId`, `blockedBy[]`, `supersededBy`, `duplicateOf` | `IssueId` |
| | `repoId` | `RepoId` |
| | `humanQuestionAskedBy`, `coordinatorSessionId`, `startedBySession` | `SessionId` |
| `IssueDepWire` | `id` | `IssueId` |
| `IssuePanelArtifact` | `artifactId` | `ArtifactId` |
| `IssueGraphNode/Edge`, `EpicStatus`, `OrphanIssue`, `LintFinding`, `DoctorReport`, `DuplicateCandidate`, `IssueSearchFilter` | every id / `from` / `to` / `a` / `b` / `cycles[][]` / `parentId` | `IssueId` |
| `AutomationWire` | `id` / `targetSessionId` | `AutomationId` / `SessionId` |
| `AutomationRunWire` | `id`, `automationId`, `sessionId` | `AutomationRunId`, `AutomationId`, `SessionId` |
| `ConversationSummaryWire` | `podiumId` | `ConversationId` |
| `AgentMemoryWire` | `sessionId` | `SessionId` |
| `GitRepositoryWire` | `repoId` | `RepoId` |
| `HandoffManifest` | `sessionId`, `repoId`, `issueId` | `SessionId`, `RepoId`, `IssueId` |

### Deliberately NOT branded, with the evidence

| Field(s) | Why | Whose brand it is |
|---|---|---|
| `ConversationSummaryWire.id`, `.parentConversationId`, `SessionOrigin.resume.conversationId`, `ResumeRef.value` | **Harness-native** ids. Evidence, not identity: a resume roll changes them, which is why the conversation registry exists. `SessionOrigin.resume.conversationId` is filled from `session.resume.value` on the handoff path — decisive that it is the native id space, not `podiumId`'s. | none, by decision (POD-360 named `nativeId` as having no brand) |
| `TranscriptItem.id`, `.cursor`, `.toolUseId`, `NativeSubagent.id` | Harness-derived, and `TranscriptItem.id` is *synthesized* by the daemon parser for some items. A transcript item is per-session detail, not a replicated entity. | `NativeSubagent.id` is ADR 9's `AgentIdentityId` (POD-1075) |
| `SessionMeta.workflowRunId`, `.workflowStepId`, `.executionProfileId`, `IssueWire.linearId`, `.linearIdentifier` | **External correlation ids.** The schema's own comment: *"stamped by an external coordinator; the substrate never interprets them."* A brand asserts a namespace we neither mint nor own. | none |
| `SessionMeta.controllerId` | **NOT a `SessionId`.** It holds `client.id`, a websocket client id (`sessions/session.ts`: `if (this.controllerId === null) this.controllerId = client.id`). Branding it `SessionId` because it is "actor-shaped" and sits on `SessionMeta` would have been a well-typed lie. | ADR 9's `DeviceId` (POD-1075) |
| `SessionMeta.handoffTarget` | Not an id at all — the server sets it to `targetMachine.name`, a display label. | — |
| `IssueComment.id` | No ratified `CommentId`, and not invented: the whole schema is DEPRECATED off the wire (#175), and minting vocabulary for a shape being deleted is the drift Phase 1 removes. | — |
| `SessionMeta.spawnedBy`, `IssueWire.assignee`, `IssueWire.origin`, `IssueComment.author`, `SessionMeta.nameSource` | Attribution **tags** and role classes, not ids — see §4. | §4 |
| every machine-id field | §2. | `MachineId`, after POD-318 |

### Tier-2 brands added here, recorded for ratification

`AutomationId`, `AutomationRunId`, `ArtifactId`, `AccountId`. Each names an id the **server mints
for a durable Podium row**, ADR 4 D3.5 makes a raw entity id an audit failure, and the first two are
members of the codebase's own replicated-entity taxonomy (`MetadataEntityKind`). Adding them here
rather than in POD-362/POD-363 is what keeps those sweeps from re-opening these schemas. **Not**
added: `ApprovalId` (no model schema field — approvals live in `@podium/protocol`), `nativeId`,
`WorkflowRunId` (both above).

---

## 4. Attribution — flipped to the current brand, handed to POD-1075

Per readiness §3.1.3 A3 and ADR 4 Amendment 1 D9.3, attribution is a **pair**: actor (which agent)
and on-behalf-of (which human). POD-361 flipped the actor half where it names a session, and left
the role-class fields alone. **POD-1075 adds a SECOND, differently branded field at each site — never
a second meaning on an existing one.**

| Site | Today, after POD-361 | POD-1075 adds |
|---|---|---|
| `IssueWire.humanQuestionAskedBy` | `SessionId` (was raw; the brand it always documented and never carried) | the on-behalf-of `UserId` — this field exists so "did a person or an agent ask this?" stays answerable |
| `IssueWire.coordinatorSessionId` | `SessionId` | on-behalf-of |
| `IssueWire.startedBySession` | `SessionId` | on-behalf-of |
| `AutomationRunWire.sessionId` | `SessionId` | on-behalf-of — §3.1.6 S6 makes a scheduled automation run as its **creator**, and `AutomationWire` carries no creator field yet |
| `IssueWire.assignee` | raw, unchanged | becomes a `UserId`. Left raw because today's values are role labels (`agent:claude-code`), not identities; branding it `UserId` now would claim a person where a role class sits |
| `IssueWire.origin` (`'human' \| 'agent'`) | enum, unchanged | the *person* dimension is new; the enum stays as the class |
| `IssueComment.author` | raw, unchanged | becomes a `UserId` (freeform author label today) |
| `SessionMeta.nameSource` (`'user' \| 'agent'`) | enum, unchanged | per readiness §3.2, the role class must learn to name a person; [spec:SP-eb60]'s human-outranks-agent rule is why the pair cannot collapse |
| `SessionMeta.spawnedBy` | raw, unchanged — **and it needs more than a brand** | on-behalf-of, **after POD-1133** |
| `Capability.actorSessionId` / `actorUser` / `onBehalfOf` (`authz/issue-authz.ts`) | already the pair's seam, landed by ADR 3 Amendment 1 D17; structurally `string` because the brand was not reachable at L0 | POD-1075 types `actorUser` / `onBehalfOf` as `UserId` — now that the brand **is** at L0, this is a type change with no move |
| `sessions.deletion_source` | untouched | POD-360 reclassified it as a code-PATH label, not provenance — recorded so POD-1075 does not add a person to it by pattern-matching |

**`spawnedBy` is why POD-1133 exists.** POD-360 found one consumer parses it and **seven** rebuild
the template literal to compare, five of them gating parent-session authorization: a tag-format
change makes those five silently answer "not the parent" rather than failing. A brand does not fix
that — it still permits seven hand-built strings — so it needs a shared constructor **and** parser.
Filed as POD-1133 (`discovered-from` POD-361). POD-1075 must not append a second value to a
freeform string; POD-1133 lands first.

---

## 5. `UserId` — sequencing with POD-1075, agreed and recorded

`UserId` already existed as a **transitional** declaration in
`packages/protocol/src/planes/principal.ts`, whose own header named this destination: *"ADR 4
Amendment 1 D9.1 owns `UserId`'s shape and Phase 1 (POD-299/POD-300) re-homes these brands to
`packages/model`."* POD-361 executed that move, so the brand now sits beside the other seven, and
`planes/principal.ts` re-exports it.

**The agreement:** POD-1075 adds the `User` aggregate to an **existing** brand and does not
introduce one; whichever of POD-361/POD-1075 lands second does **not** re-sweep these schemas,
because POD-361 already carries the brand, the `(UserId, EntityId)` key shape, and §4's site list.
Concretely, POD-1075 owes:

1. the `User` aggregate + per-user `client_sessions` + invite/role (`admin` | `member`);
2. the **second** branded field at every §4 site (never a second meaning on the first);
3. typing `Capability.actorUser` / `onBehalfOf` as `UserId` — a type change now that the brand is
   reachable from L0, not a move;
4. the `owner` / `visibility` / grant field group as **one** composed group (ADR 4 D9.2) — POD-361
   added none of it, and every model aggregate is flat, so it is purely additive and the golden
   fixtures still pass.

**Deliberately left in `@podium/protocol`:** `DeviceId`, `AgentIdentityId`, `CapabilityRef`,
`DelegationRef`. They are not entity ids — they name a transport binding, an agent identity and two
opaque server-minted references, i.e. ADR 9's principal taxonomy, which POD-1075 lands as an
aggregate. `packages/model` gains them with that aggregate or not at all.

**Not multi-tenancy.** No instance dimension appears in any schema or key produced here (ADR 1 D5,
Amendment 2 D18). The `InstanceId` taxonomy question stays with POD-359, now answered by ADR 1
Amendment 2: a configuration brand, no column.

---

## 6. The two key shapes

Full API in `packages/model/src/ids/README.md` §2. What matters for the issues behind this one:

- **`userEntityKey(user, entityRef)`** is the single home for POD-1076's `(userId, entityId)`. It is
  the first key joining **two branded types** — POD-360 warned every earlier helper was
  `(brand, raw)` and that POD-1076 would otherwise adopt one with a cast. Both halves are branded
  and both are escaped. The **kind** is part of the key: ids are unique per kind, not globally, so
  without it one user's `readAt` on a session would collide with their `readAt` on an issue.
  POD-1076 is explicitly forbidden from inventing a second convention; this is the one.
- **`subjectResourceKey(subject, resource)`** is the single home for ADR 9 D2's grant edge and
  §3.1.4 M1's per-machine verbs. **The verb is deliberately not in the key**: ADR 3 D2 owns
  `read`/`write`/`manage` and `issue-authz.ts` records that mapping M1's three verbs onto them is
  POD-1079's call. A per-verb key is a five-part `joinKeyParts` call, never a verb concatenated onto
  this function's output — pinned by a test.
- Both are `parse ∘ join`-total, **injective** (two distinct part tuples can never collide), and
  byte-identical to the legacy ad-hoc keys whenever no part contains the separator or a backslash —
  which is what lets POD-362/POD-363 adopt them without invalidating live in-memory keys.
- A machine may be a grant **resource** (ADR 9 D6), so `EntityRef` carries a `machine` arm — but a
  machine grant must not be *minted* until POD-318 retires the sentinels, or the grant is keyed on a
  value that names different hardware in every instance. Representable, not yet mintable.

**Adoption is zero, by design.** POD-360 found eight `\n`-separated machine-scoped sites
(`packages/sync/src/mirror.ts`, `transcript-indexer.ts` ×4, `search.ts`, and this package's two
`session-identity.ts` sites) that share one collision surface: they move together or not at all.
POD-362/POD-363 own that.

---

## 7. Edge casts — the list POD-362 and POD-363 delete

**CLOSED.** Every one is gone: POD-362 took `apps/server` + `apps/daemon` from 32 to 0, and
POD-363 took the remaining 33 (clients, CLI, `packages/sync`, `packages/model`) to 0. The grep
`grep -rn POD-361-EDGE-CAST apps packages` now returns nothing, and that grep — not this table —
remains the authority: a new marker appearing is a regression, not a to-do.

The counts below were taken at the flip and are kept as the historical record.

**63 casts across 41 files** — 43 in product code, 20 in tests.

| Area | Files | The pattern, and what replaces the cast |
|---|---|---|
| `apps/server` store + projections (`store/automations.ts`, `modules/issues/service/{core,reads,crud}.ts`, `modules/sessions/{session,service}.ts`, `modules/conversations/service.ts`, `repo-registry.ts`) | 8 | A sqlite row / the server's own runtime object types its ids as plain strings. **Replace by branding the row and runtime types** (`IssueRow.id`, `Session.sessionId`, …) — one change that removes most of this column. POD-361 did not, because branding `IssueRow` alone ripples through every write site: that is POD-362's sweep, not a projection cast. |
| `apps/server` command inputs (`modules/issues/registry.ts`, `modules/issues/service/crud.ts`, `modules/automations/service.ts`) | 3 | A parsed-but-unbranded zod command input. **Replace by declaring the command input schemas with the `…Field` brands** — the registry is the natural home. |
| `apps/server` mint sites (`modules/automations/service.ts`) | 1 | `aut_${randomUUID()}`. **Replace with a branded constructor**, as `automationOccurrenceRunId` already is (POD-361 changed its return type: an id constructor that returns a bare string forces every caller to cast, which is how a brand gets adopted nowhere). |
| `apps/server`/`packages/sync` upstream (`modules/issues/upstream.ts`, `sync/upstream-forwarder.ts`) | 2 | Queued node→hub patches are unbranded wire input. **Replace with a parse at the hub boundary.** |
| `apps/daemon` (`memory-breakdown.ts`) | 1 | The daemon's own session record. Same fix as the server runtime objects. |
| `apps/web` map lookups (`SidebarUnified.tsx`, `IssuePanelView.tsx`, `issue-page-properties.tsx`, `issue-context-menu.ts`, `IssueCompactControls.tsx`) | 5 | `Map<IssueId,…>.get(plainString)` where the string came from a DOM/prop/drag payload. **Replace by branding the component props and the drag payload types.** |
| `apps/mobile` (`lib/screening.ts`) | 1 | The persisted screening order is a plain string list. **Replace by branding the persisted shape.** |
| `packages/client-core` (`viewmodels/derive.ts`, `optimistic-spawn.ts`) | 2 | `OptimisticSpawnArgs` takes plain strings; and one lookup brands the output of the `spawnedBy` parser. The latter disappears with **POD-1133**, not with a sweep. |
| Test fixtures (20 casts) | 20 | Fixture builders now take `Partial<SessionMetaInput>` / `Partial<IssueWireInput>` and brand once at the return. Left as-is deliberately: rewriting ~170 fixture literals **is** POD-362/POD-363's sweep, done badly and inside test files. |

**Two mechanisms support those casts, and both are POD-362/POD-363's to retire:**

1. `packages/model/src/entities/wire-input.ts` — `SessionMetaInput` / `IssueWireInput` /
   `AutomationWireInput` / `AutomationRunWireInput` / `ConversationSummaryWireInput`, built from a
   **brand-aware** mapped type (`UnbrandIds`) that widens only `BRAND`-carrying strings. Closed
   enums keep their literal unions, so a fixture with a misspelled `status` still fails to compile —
   which `z.input<typeof Schema>` would not have given (it also turns every `.default()` field
   optional). 63 files adopted the aliases; without them, keeping the repo green would have meant
   editing every fixture literal in every consumer.
2. `@podium/protocol`'s two re-export shims — `ids.ts` (the seven original brands, their casts, and
   the two legacy key helpers) and `planes/principal.ts` (`UserId`). They carry **only** the
   pre-move surface: POD-361's additions have no old path to preserve, and re-exporting model's
   `EntityRef` would have collided with `planes/routing.ts`'s own weaker one (POD-1134).

---

## 8. Discovered, filed, not fixed

| Issue | What |
|---|---|
| **POD-1133** | Shared `spawnedBy` constructor and parser — §4. A brand cannot fix seven hand-built template literals, five of which gate authz. |
| **POD-1134** | `planes/routing.ts` builds `entity:${kind}:${id}` **unescaped**, so `('a','b:c')` and `('a:b','c')` collide on one routing key; and it declares a second, looser `EntityRef`. Landed after POD-360's inventory was generated, which is why the inventory does not carry it. |

Also fixed in passing, because it blocked verification: `packages/harness/package.json` imported
`@podium/model` in nine files without declaring the dependency, so its typecheck could not resolve
it and turbo stopped there — hiding `apps/server`, `apps/web`, `apps/cli` and `apps/mobile` from the
lane entirely. Pre-existing on the base (identical `package.json`, same imports).

---

## 9. Verification

| Claim | Evidence |
|---|---|
| Model compiles standalone | `bunx tsgo --noEmit` in `packages/model` — clean. Its only dependency is `zod`; `bun scripts/check-boundaries.ts` → *boundaries OK, 58 allowlisted, 0 new*. |
| Wire fixtures unchanged | 137 pre-existing golden cases: **0 missing, 0 changed**, 50 added (the new id schemas). 26 of 27 family files byte-identical; `model.json` insertions-only (`git diff --numstat` → `450 0`). Verified against the **committed** baseline before regeneration, not after — a snapshot regeneration can otherwise launder exactly this. |
| Branding changed nothing at runtime | `brands.test.ts`: every touched schema still parses with all its id fields set to `''`, with the counterfactual that the `.min(1)` schema rejects the same value. Mutation: tightening the field factory to `.min(1)` fails 11 assertions. |
| The `MachineId` carve-out holds | `brands.test.ts` source scan by field-name shape + `MachineWire.id`. Mutants: branding `SessionMeta.machineId` → fails "has no machine-id-shaped field bound to MachineIdField"; branding `MachineWire.id` → fails "brands MachineWire's own `id` with the carve-out". A third assertion proves the scan sees ≥6 sites, so a broken scan cannot read as a clean one. |
| The keys are injective and fail closed | `keys.test.ts`, 19 tests over hostile parts (separators, backslashes, strings that look like valid keys). Mutants: removing the kind from `userEntityKey` → 4 failures including "separates two entity KINDS that share one id string"; removing the escaping → 7 failures including "is injective"; making the kind check non-throwing → fails "refuses an unknown entity kind on parse — fails closed". |
| No consumer adopted *(at the flip)* | 63 marked casts. **Closed by POD-362 + POD-363**: the marker grep returns 0 and the `…Field` schemas are now used across `apps/server`, `apps/daemon`, `apps/web`, `apps/mobile`, `packages/client-core`, `packages/terminal-client` and `packages/sync`. |
