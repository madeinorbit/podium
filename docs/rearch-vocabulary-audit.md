# POD-368 — the 1.4 vocabulary audit, run to zero (closing POD-302)

**Base:** `25854151` on `issue/279-integration`.
**Subtree audited:** POD-364 (inventory), POD-365 (aggregates + field groups), POD-366 (session
representations), POD-367 (issue representations), POD-643 (handoff manifest). POD-643 landed after
the original 1.4 split froze, so the audit surface is the post-split set, not the pre-split one.

This document is the audit RUN. The convention it applies, and the checks that enforce it, live in
`packages/model/src/representations/` — see that directory's README. Nothing here is a decision;
where the pack leaves something open, this document records the open item and names its owner.

---

## 1. What "audit to zero" was redefined to mean, and why it had to be

**The old instrument could not measure the criterion.** `session-shapes` and `issue-shapes` were
`^export (interface|type|class) X` over hardcoded lists of nine and seven NAMES. POD-367 measured
it: **4 of 17** issue representations visible, `packages/model`'s own canonical declarations counted
as debt, and `RefIssueLike` — a hand-written 22-key interface, the largest client-side restatement
in the repo — retired to a `Pick` with the audit printing the identical line before and after.

**The lists were deliberately not extended, and that judgement is carried forward.** A longer
literal list reproduces the defect one generation later and leaves the criterion **zeroable by
renaming an identifier**. The redefined detectors key on the entity **vocabulary**, read at runtime
out of the model's field groups. That property is asserted rather than claimed: the detector's test
renames the planted shape and still finds it.

| Item | Before | After | Unit now |
|---|---|---|---|
| `session-shapes` | 9 | **0** | a declaration restating ≥3 session vocabulary keys that is neither registered in the model registry nor excluded with a reason |
| `issue-shapes` | 8 | **0** | the same, for issue vocabulary |
| `representation-registry-rot` | — | **0** | a registry entry whose site is missing or no longer declares its symbol |

`POD-302: all 5 deletion-audit items are at zero — clear to close.`

**The limit that defines the unit, stated because a misread zero is worse than a red.** A COMPOSED
representation is invisible to these detectors by construction: `Pick<IssueWire, …>` leaves no key
list to count. They enumerate **restatements**; they can never enumerate **representations**. A
falling count means "more is composed"; a zero does **not** mean "these are all the representations
there are". The registry is the enumeration, and it is deliberately not derived from the detector.

**One deviation is what makes POD-302's gate pass, so it is the first thing a reviewer should
check.** `change-row-typings` (7 sites) is re-phased from POD-302 to **POD-308** — full reasoning in
§6.1 and in `docs/rearch-deletion-audit.md`.

**And the detector found four representations POD-364's hand pass missed** —
`SessionInstructionContext`, `SessionSpawnResult`, `SessionInfo` (the session twin of the `IssueInfo`
POD-367 corrected, in the same file) and `OptimisticSpawnArgs`. POD-364 enumerated by reading; the
detector enumerates by key set. They are registered, not allowlisted: the live set is **26 session +
17 issue = 43**, against POD-364's 41 and after two deletions.

### 1.1 Three defects in my own instrument, found before its numbers were believed

Each was found by a test written to make the detector say YES, not by reasoning about it.

1. **A brace-less alias absorbed the next function's parameter object.** `type ExitedAction =
   'restart' | 'resume' | 'remove'` was reported as a four-key session restatement, because the
   declaration window ran past it into `exitedRecovery`'s inline `opts`. The window now stops at a
   function.
2. **The property regex was LINE-anchored**, so a reflowed one-line interface lost its keys — and
   the count would have silently **dropped**, which is this audit's own documented worst failure
   mode ("not on formatting"). Anchored on the separator instead.
3. **Restated keys and merely-named keys were one set**, so a `Pick` counted as a restatement. Split
   in two: restated keys drive the restatement counts, named keys drive the forbidden-key classes —
   because a projection that *picks* `readAt` still ships one person's read state.

`entityShapedDeclarations` also **throws** if the vocabulary loads empty, rather than reporting a
serene zero that the ratchet would offer to bank as a win.

---

## 2. The documentation convention, and where every retained representation is documented

Every retained representation is documented **in model**
(`packages/model/src/representations/registry.ts`) with four things: its **purpose**, **why its
semantics genuinely differ** from the canonical aggregate, **what it composes**, and a **declared
ADR 9 D3 visibility class** checked against an ADR 1 matrix row. Storage, live state, wire and the
narrow ports each keep their own entry — folding them together is the "one universal record" ADR 4
D1 rejects.

> **A representation that cannot justify itself in that form is a drifted duplicate and must be
> deleted, not documented.** That is not a slogan. Two failed the `distinctSemantics` question and
> are gone, recorded in `DELETED_AS_DRIFTED_DUPLICATES` so that re-adding either reads as what it
> is: `BtwSessionInfo` (a strict subset of `ConciergeSessionInfo`, re-declared) and `StatusWire` (a
> key-for-key hand copy of `SessionStatusResult` whose own comment named its source). Both retired
> by POD-366.

**18 composed · 7 declared-legitimate restatements · 18 pending with a named owner and blocker.**

The `pending` count is reported rather than smoothed. Three blockers recur and all three are
architectural, not anyone's omission: the `fields/issue.ts` ↔ `entities/issue.ts` **circular
import** (a runtime failure, not a lint one — POD-1141); **no shared home** the CLI may import,
which is *why* those copies were hand-written; and an **entity-in-entity embed whose removal has no
receiver** until the feed is scoped (POD-308).

---

## 3. Every retained representation

Generated from `RETAINED_REPRESENTATIONS`, so this table cannot drift from the registry it
describes. Full prose for each — purpose, why its semantics differ, what it composes — is on the
entry itself.

#### session (26)

| Representation | Role | Site | Visibility | Composition |
|---|---|---|---|---|
| `sessions` | R3 | `apps/server/src/migrations/schema.ts` | personal | declared legitimate |
| `SessionRow` | R3 | `apps/server/src/store/types.ts` | personal | pending → **POD-1141** |
| `Session` | R2 | `apps/server/src/modules/sessions/session.ts` | personal | pending → **POD-1141** |
| `SessionInit` | R2 | `apps/server/src/modules/sessions/session.ts` | personal | pending → **POD-1141** |
| `SessionDurableState` | R2 | `apps/server/src/modules/sessions/session.ts` | personal | pending → **POD-1141** |
| `SessionMeta` | R4 | `packages/model/src/entities/session.ts` | personal | composed |
| `HandoffManifest` | R6 | `packages/model/src/entities/handoff.ts` | personal | composed |
| `HostSessionView` | R5 | `apps/server/src/modules/hosts/service.ts` | personal | pending → **POD-1141** |
| `SessionNoticeInfo` | R5 | `apps/server/src/modules/notify/service.ts` | personal | pending → **POD-1141** |
| `RpcSessionView` | R5 | `apps/server/src/modules/machines/rpc.ts` | personal | declared legitimate |
| `ResumableSession` | R5 | `packages/model/src/identity/session-identity.ts` | personal | declared legitimate |
| `HandoffSession` | R5 | `packages/model/src/predicates/machine-selection.ts` | personal | pending → **POD-1141** |
| `ConciergeSessionInfo` | R5 | `apps/server/src/modules/superagent/concierge.ts` | personal | pending → **POD-1141** |
| `FocusSessionInfo` | R5 | `apps/server/src/modules/superagent/global.ts` | personal | composed |
| `CloudAgentSourceSession` | R5 | `apps/server/src/cloud-runtime.ts` | personal | declared legitimate |
| `LakeReadSession` | R5 | `apps/server/src/modules/conversations/service.ts` | personal | composed |
| `RefSessionLike` | R5 | `apps/web/src/lib/ref-miniview.ts` | personal | pending → **POD-1141** |
| `IssueTreeSession` | R4 | `packages/model/src/projections/session-read.ts` | personal | composed |
| `ShowSession` | R4 | `packages/issue-client/src/commands.ts` | personal | composed |
| `SessionStatusResult` | R4 | `packages/model/src/projections/session-read.ts` | personal | composed |
| `SessionAutoArchiveObservation` | R4 | `packages/protocol/src/maintenance.ts` | personal | declared legitimate |
| `SessionInstructionContext` | R5 | `apps/server/src/modules/sessions/instructions.ts` | personal | pending → **POD-1141** |
| `SessionSpawnResult` | R5 | `apps/server/src/modules/sessions/service.ts` | personal | pending → **POD-1141** |
| `SessionInfo` | R5 | `apps/server/src/modules/workflows/service.ts` | personal | pending → **POD-1141** |
| `OptimisticSpawnArgs` | command-input | `packages/client-core/src/viewmodels/optimistic-spawn.ts` | personal | pending → **POD-363** |
| `SessionCardModel` | R4 | `packages/client-core/src/viewmodels/session-card.ts` | personal | composed |

#### issue (17)

| Representation | Role | Site | Visibility | Composition |
|---|---|---|---|---|
| `issues` | R3 | `apps/server/src/migrations/schema.ts` | personal | declared legitimate |
| `IssueRow` | R3 | `apps/server/src/store/types.ts` | personal | pending → **POD-1141** |
| `IssueWire` | R4 | `packages/model/src/entities/issue.ts` | personal | pending → **POD-1141** |
| `IssuePatch` | command-input | `apps/server/src/modules/issues/service/types.ts` | personal | composed |
| `CreateIssueInput` | command-input | `apps/server/src/modules/issues/service/types.ts` | personal | composed |
| `IssueTreeNode` | R4 | `apps/server/src/modules/issues/service/types.ts` | personal | pending → **POD-308** |
| `TreeNode` | R4 | `packages/issue-client/src/commands.ts` | personal | pending → **POD-308** |
| `ShowWire` | R4 | `packages/issue-client/src/commands.ts` | personal | pending → **POD-308** |
| `OrphanIssue` | R4 | `packages/model/src/entities/issue.ts` | personal | composed |
| `IssueGraphNode` | R4 | `packages/model/src/entities/issue.ts` | personal | composed |
| `HandoffIssue` | R5 | `packages/model/src/predicates/machine-selection.ts` | personal | composed |
| `RefIssueLike` | R5 | `apps/web/src/lib/ref-miniview.ts` | personal | composed |
| `FocusIssueInfo` | R5 | `apps/server/src/modules/superagent/global.ts` | personal | composed |
| `IssueInfo` | R5 | `apps/server/src/modules/workflows/service.ts` | personal | composed |
| `StartableIssueLike` | R5 | `apps/web/src/features/issues/issue-startable.ts` | personal | composed |
| `IssueAutoArchiveObservation` | R4 | `packages/protocol/src/maintenance.ts` | personal | declared legitimate |
| `GitProbeTarget` | R5 | `apps/server/src/modules/issues/git-state.ts` | owned-compute | composed |

---

## 4. The four ownership and visibility audit items

Each is **default-closed by construction**, and each is proven to FIRE on planted bad code rather
than merely to pass on good code. A totality check that only passes is not evidence.

### 4.1 Visibility-class totality — every aggregate AND every retained representation

**At zero.** All 43 representations classify against a real ADR 1 matrix row, and none declares a
class louder than its row resolves to. The 2 canonical aggregates and the 53 matrix rows were
already covered by POD-365 and POD-304; representations were the gap.

Per ADR 9 D4 an undeclared class resolves to **personal/private**, and both halves of that rule are
carried by separate mechanisms because neither substitutes for the other:

- `visibilityClassOf` / `representationVisibilityOf` resolve an unknown row or an unregistered symbol
  to `personal` — the **semantic** backstop, which holds with every test deleted;
- the totality check fails the build for the **missing declaration** (ADR 1 Am1 D9).

**Proven to fire, in `representations/registry.test.ts`:** a fixture representation pointing at a
matrix row that does not exist reports `no-matrix-row`; the same fixture declaring
`deployment-substrate` reports `declaration-disagrees-with-matrix` — the exposure case, caught
because the resolver answered `personal` and the louder claim mismatched. A fixture with an empty
`purpose` or `distinctSemantics` reports `undocumented`, so a representation cannot be registered
without justifying itself.

One representation is **not** `personal`, and it is the interesting cell: `GitProbeTarget` declares
`owned-compute` against `ROW.machine`, because every member of it is a machine fact and its exposure
is inherited (ADR 9 D3 rule 3) rather than classified as issue content.

### 4.2 One definition of owner, visibility, and the attribution PAIR — halves audited separately

`owner` and the visibility vocabulary are at **one definition each**, verified rather than assumed:

- **Visibility class:** `VISIBILITY_CLASSES` in `annotations/ownership.ts` is the single closed
  five-member list, and `fields/ownership.ts` **derives** its zod enum from that list rather than
  restating five literals — with a compile-time pin asserting the inferred type IS the exported one.
  So "there is one visibility vocabulary" is structural, not a convention two files follow.
- **Owner:** `fields/ownership.ts`'s `owner: UserIdField` is the only entity-owner field. The sweep
  found one other `owner:` in field position — `cloudRepoInput.owner` in `router.ts`, which is a
  **GitHub repo owner**, an external system's field. Recorded as a checked non-finding: a field name
  is not evidence of what it names, which is the same trap that made `deletion_source` look like
  attribution.

**The two attribution halves are audited separately, and that is where the one real drift was
found.** A representation carrying only the actor half looks correct until someone asks whose work it
was, so `ActorRef` and `onBehalfOf` are checked as separate members with separate rules.

> **FINDING — two attribution pairs exist. Filed as POD-1148, `discovered-from` POD-368.**
> `packages/model/src/fields/attribution.ts` (POD-365) defines `ActorRef` over ADR 9 D1's four
> principal kinds with `onBehalfOf: UserId | null`. `packages/sync/src/outbox/records.ts` (POD-370)
> defines a second pair: `OutboxActor` with two arms and `onBehalfOf: UserRef`, where
> `UserRef = string`.
>
> **Both are well-reasoned**, and POD-370 declared its interim correctly at the time: *"a plain
> string until POD-1075 lands the model's `UserId` brand … this module must not mint a second brand"*.
> What changed is that `UserIdField` and `AgentIdentityIdField` now exist in model and
> `packages/sync` already declares `@podium/model` as a dependency.
>
> **But they are not trivially substitutable, and that is the finding rather than the fix.** Model's
> agent arm carries an `AgentIdentityId`; the outbox's carries a `SessionId`. A session is not an
> agent identity — type-distinct *and* fact-distinct, so a same-name-therefore-merge pass would be
> wrong. The decision someone must make: **does the actor's agent arm name the agent identity or the
> session it acted in?** ADR 9 D5 A3 calls `Capability.actorSessionId` "the existing seam for the
> actor half"; ADR 9 D1's taxonomy argues the other way. **Not resolved here** — it is POD-1075's and
> POD-414's territory, and picking the shorter type to close an audit item is exactly how a
> vocabulary forks.

The two *readers* of the pair — `capabilityAttribution()` on a `Capability` and `attributionOf()` on
a `Principal` — are **not** findings. `fields/attribution.ts` already documents them as readers whose
correct end state is to PRODUCE the field schema, and re-pointing them is POD-1075's consumer change.

### 4.3 No serializable effective-capability snapshot, anywhere

**At zero, in both instruments.** ADR 9 D5 A1: an agent's effective rights are its own scope
intersected with its human's **current** rights, resolved live at every apply (ADR 3 D8). A snapshot
survives the revocation of the person it was derived from with no reaper to trigger.

`findCapabilitySnapshotKeys` existed (POD-643) and had **exactly one caller** — `HandoffManifest`.
The rule is about all of them, so it now runs over every schema-bearing registry entry, at any depth
and under any wrapper; and the tree-level detector covers the 38 sites that are TypeScript
interfaces rather than zod schemas in model.

**Proven to fire:** a planted `delegation.effectiveRights` nested inside an optional object is named
by path; the tree-level check fires on `capabilities`, `effectiveRights`, `permissions`, `grants`,
`scope`, `role` and `acl`.

**And proven NOT to fire on attribution**, which matters as much: `owner`, `actor` and `onBehalfOf`
are exempt by construction and there is a test asserting it. Recording who caused a write is a
durable fact that must survive export and re-replication (ADR 4 Am1 D9.4); an audit that conflated
the two would forbid exactly what ADR 1's matrix requires.

### 4.4 No per-user state left as a singleton field

**NOT at zero, and reported as a ratchet with a named owner rather than zeroed.** Eight singletons
survive across the tree:

| Site | Members |
|---|---|
| `SessionDurableState` | `readAt`, `snoozedUntil` |
| `SessionRow` | `readAt` |
| `IssueRow` | `readAt`, `tuckedAt`, `pinned` |
| `SessionAutoArchiveObservation` | `readAt` |
| `IssueAutoArchiveObservation` | `readAt` |

Plus five on the two wire projections, seen by the schema-level check that the tree-level one cannot
reach because composition removes their keys: `SessionMeta.readAt`/`snoozedUntil`,
`IssueWire.readAt`/`tuckedAt`/`pinned`. **The two instruments are complementary here and neither is
sufficient alone** — worth stating, because two checks of the same class would corroborate rather
than complement, and these do not overlap at a single site.

Every one is **inherited**: 1.4 added none and blessed none (POD-367 §3.5, and `pinned` was removed
from `IssueTriage` on exactly this ground). POD-1076 owns re-keying them to `(userId, entityId)` over
the one `PerUserKey` fragment, so the audit item is **mapped to POD-1076, not POD-302** — the phase
must not be able to close by laundering someone else's migration. Each singleton left behind is later
a table migration PLUS a wire change PLUS a replica migration.

**The two auto-archive `readAt` sites are the sharp ones**, and they are POD-1136's finding arriving
independently: the steward archives partly BECAUSE something was read, so once read-state is
per-user, "archive it because it was read" has to answer *read by whom* — otherwise one person
opening an issue archives it out of everyone else's sidebar. That is a policy call, not part of
POD-1076's mechanical re-key.

**Two members are recorded as gaps rather than counted**, because they are not in
`PER_USER_STATE_KEYS` and extending that list is not this issue's call:

- **`unread`** on both wire projections. It is *derived* from `readAt`, so it is per-user by
  derivation. If POD-1076 re-keys `readAt` and leaves `unread` on the wire, the wire still carries
  one person's read state to everyone. Handed to POD-1076.
- **`deferUntil`** is deliberately **not** per-user state and its absence from the list is a
  decision, not an oversight: unlike `snoozedUntil` it is a claim about the WORK, identical for
  every viewer, and the defer/snooze split is already settled in `predicates/issue-stage.ts`.

### 4.5 POD-1076's `archived` / `workState` decision — audited as APPLIED, not merely made

The brief asks specifically that the recorded decision be verified as applied. It was.

ADR 1 Amendment 1 D10 decides both are **shared session facts on `exp-rev`**, not per-user view
state, and POD-364 §7.2 Q1/Q2 records that decision without reopening it. Verified in the code:
`archived` sits in `SessionLifecycle` and `workState` in `SessionWorkState`, **both are members of
`SessionAggregate`**, neither is in `PER_USER_STATE_KEYS`, and the reasoning is carried on the schema
itself — `archived` sits beside `deletedAt` and means "this session is retired", which is identical
for every viewer; `WorkState`'s values are claims about the work. `readAt` and `snoozedUntil` are
correspondingly **absent** from the aggregate.

D10's open follow-on is recorded and not answered: whether a per-viewer *"hide this from MY sidebar"*
affordance is ever wanted. That would be a **new** per-user row, never a reclassification of
`archived`. POD-1076's call.

---

## 5. Not multi-tenancy — audited across the subtree

**At zero.** ADR 1 D5 stands as written and Amendment 2 fences it at length: multi-user lives
**inside** one instance, and the dimension it adds is **owner**, not tenant.

- No `instance_id` / `tenant_id` member on any session or issue representation, in either instrument.
- No `instance_id` column in any migration.
- All 151 `instanceId` occurrences in `apps/` and `packages/` are the **deployment partition** ADR 1
  D5 defines: `packages/runtime/src/instance.ts`, server config, CLI systemd unit naming, the peer
  handshake envelope, and the matrix's own `instance-id` row (`deployment-substrate`). None is an
  entity field.
- `instance-partitions` is retained as a **regression guard at zero**, because "multi-user" and
  "multi-tenant" are the two words this programme most needs kept apart, and `annotations/
  matrix.test.ts` already fails a row that smuggles one in as a column value.

---

## 6. Deviations — recorded, not smoothed

### 6.1 `change-row-typings` re-phased from POD-302 to POD-308

**This is the deviation that makes POD-302's gate pass, so it deserves the most scrutiny.**

The item counts 7 sites, all in `packages/protocol/src/messages/sync.ts`: the strict / lenient /
unknown change-row triple. Resolved from the pack rather than by preference:

- The triple exists so a replica can tolerate an entity kind it does not know — **ADR 2 D9**. That
  is sync-envelope shape, not session or issue vocabulary.
- **POD-364 §12** scopes sync infrastructure out of 1.4 **by name**.
- **ADR 1's matrix** files `change-log` and `applied-mutations` under `sync-infrastructure` as
  deployment substrate. Neither is a session or an issue field.
- The duality collapses when one canonical change-row shape lands at the **wire cutover**, which is
  POD-308's — the same issue that owns nesting the provenance carrier and deleting the
  `IssueWire.sessions` embed. Deleting it from inside 1.4 would mean inventing that shape twice.

Reversing this is one edit to a `phase:` field, and the reasoning is on the check.

### 6.2 The composition remainder is POD-1141's, and this issue does not claim it

18 of 43 entries are `pending`. POD-367 recommended the split and the coordinator confirmed it:
*"the split POD-367 itself recommended, and the right one, because splitting an issue across two
merges would leave a reviewer unable to see the composition it was asked to judge."* The audit
therefore counts registration and justification — which this issue can close — and leaves the
composition debt visible under **POD-1141**, **POD-308** and **POD-363** rather than folding it into
a zero.

### 6.3 The per-user item is not at zero

See §4.4. Eight singletons, all inherited, mapped to POD-1076.

### 6.4 Entity-in-entity nesting is still NOT MET, and this issue does not "fix" it

POD-367 §3.2 reported it as not met and mailed POD-368 specifically so a later pass would not
silently repair it. Three embeds survive — `IssueWire.sessions`, `IssueTreeNode.sessions`,
`ShowWire.sessions` — one owner (**POD-308**), one shared reason, and it is a **scoped-feed
prerequisite rather than a perf note**: an embedded child carries a visibility class of its own, so a
nested session the reader may not see cannot be filtered out of the parent projection without either
lying about the parent or leaking the child. Confirmed still true at this base; nothing here hardens
or removes them.

### 6.5 An over-count left in place

`change-row-typings`'s own anchor is an unanchored name alternation, so `MetadataChangeOp` — an op
enum, not a change-row typing — is one of its 7. The count is an over-count by at least one. Left
alone deliberately: lowering someone else's count while re-phasing their item would be two changes
wearing one justification.

---

## 7. Handed to Phase 3 (POD-290) — confirmed, and OPEN

The brief is explicit that this issue **records and must not resolve** these. Confirmed handed
forward, and both are still open at this base.

**7.1 The existence-leak list — 13 surfaces, L-1…L-13, OPEN.** `docs/rearch-field-schema-inventory.md`
§10 carries them against ADR 9 §3 **O1**, which leaves "which existence facts leak" deliberately open
**per surface**: issue rollups; the issue counts API and its per-assignee histogram (the strongest
existence surface in the tracker); machine session lists; worktree occupancy; lock holders; ref-letter
allocation; cross-boundary graph edges; session↔issue back-references; attribution ids; queue and
mail counts; the mail send path; blob dedup; the conversation registry. The **consistent-error rule**
travels with them: where existence is private, "invisible" and "nonexistent" must produce the *same*
error, or any read path becomes an existence oracle. POD-367 §3.6 sharpened L-11 from "this path is
an oracle" to "this field is the vector" — `MessageSendResult.reason` is free-form text, which is
where two identical enums diverge into two different strings.

**7.2 The cross-boundary graph-edge question — ADR 9 §3 O2, OPEN.** An issue may be blocked by,
parented to, or duplicated-with an issue you cannot see. Hide the edge, or show an opaque reference?
The second is usually right — hiding it makes the tracker lie about why something is blocked — but it
leaks existence, and that is a policy call.

**What POD-367 landed is that both answers stay EXPRESSIBLE without a second projection function**,
proven by test rather than asserted: hide-the-edge needs no shape at all (`IssueGraph` parses with a
node and its edges omitted, and every member of `IssueGraphNode` is required, so a suppressed node
cannot be half-emitted with fields blanked); opaque-reference is `IssueGraphNode.pick({ id: true })`,
a **narrowing of the same projection**. What keeps that available is that `IssueRefHead` is
identity-only and content is added by mask — folding any content member into the head would make an
opaque node unemittable without leaking content. **The decision itself is not made, here or there.**

Two adjacent open items are recorded in the same place and are also POD-290's: **create-time owner
and grant inheritance** (does a comment or child issue inherit the parent's owner and grants, or the
actor's — ADR 9 §3 O4), and **`reparent` is permission-affecting**, because a subtree scope is a
moving set and reparenting widens or narrows a working agent's visibility with nobody having decided
it.

---

## 8. Verification

Every lane run in this worktree at `25854151`, uncached where it matters.

| Lane | Result |
|---|---|
| `bunx tsgo --noEmit` in `packages/model` | exit 0, uncached. `grep -c TS1[0-9][0-9][0-9]` = **0**, so the count is not a checker that quit early |
| `vitest packages/model/src` | 21 files, **239 passed** (21 of them this registry's) |
| `vitest scripts/representation-audit.test.ts` | **15 passed** |
| `vitest scripts/rearch-audit.test.ts` | **52 passed** |
| `bun scripts/rearch-audit.ts` | exit 0 — "25 items, 252 sites remaining (baseline exact)" |
| `bun scripts/rearch-audit.ts --phase POD-302` | exit 0 — "all 5 deletion-audit items are at zero — clear to close" |
| `bun scripts/check-boundaries.ts` | exit 0 — "58 allowlisted, **0 new**" |
| `bun scripts/check-no-nul-bytes.ts` | exit 0 |

**What was NOT run, and why.** No full `bun run test` and no `typecheck --force`: both need the
`test-lane` lease, and a 25-minute TTL does not cover a full suite on this box. The targeted lanes
above are attributable to this diff, which is the run's settled evidence policy. This diff adds two
`scripts/` files, one `packages/model` directory, one doc, and edits the audit script plus its
baseline; it changes no product behaviour and no wire shape.

**A note on which tree the instruments read.** `vitest.config.ts` aliases `@podium/*` relative to the
config file, so a lane launched from this worktree root reads this worktree. The conclusive evidence
is not the config but the three instrument defects in §1.1: each was found by a test in THIS worktree
failing against source in THIS worktree, and fixed here.

---

## 9. LEDGER-ENTRY (for `docs/rearchitecture-v3.md` §8, Phase 1)

> **POD-368 (1.4e) — vocabulary audit run to zero, at `25854151`.** POD-302's redefined session and
> issue items are at **0** (from 9 and 8), and the redefinition is the deliverable: the old detectors
> were hardcoded lists of nine and seven NAMES that could see 4 of 17 issue representations and
> counted `packages/model`'s own canonical declarations as debt. The lists were **not** extended —
> that leaves the criterion zeroable by renaming an identifier — so the new detectors key on the
> entity **vocabulary** read at runtime from the field groups, with a test that renames the planted
> shape and still finds it. **All 43 retained representations (26 session + 17 issue) are now
> documented IN MODEL** with purpose, why their semantics differ from the canonical aggregate, what
> they compose, and a declared ADR 9 D3 class checked against an ADR 1 matrix row; storage, live
> state, wire and the narrow ports each keep their own entry. Two drifted duplicates were **deleted
> rather than documented** (`BtwSessionInfo`, `StatusWire`) and recorded as such. Four audit items are
> default-closed and each **fires on a planted fixture**: visibility-class totality (unclassified
> resolves to personal/private, and the missing declaration still fails), one definition of owner /
> visibility / the attribution pair with **both halves audited separately**, no serialized
> effective-capability snapshot (`findCapabilitySnapshotKeys` had exactly ONE caller and now runs over
> every schema-bearing entry, with `owner`/`actor`/`onBehalfOf` exempt by test because attribution
> must survive export), and no per-user singleton. **Reported honestly rather than zeroed:** the
> per-user item is a RATCHET at **8** inherited singletons mapped to POD-1076 (with `unread` handed
> forward as a per-user *derived* member and `deferUntil` recorded as deliberately not one); 18 of 43
> entries are `pending` composition under POD-1141/POD-308/POD-363, the split POD-367 recommended;
> entity-in-entity nesting is confirmed **still not met**, three embeds, owner POD-308, a scoped-feed
> prerequisite and not a perf note. **`change-row-typings` is re-phased POD-302 → POD-308** — ADR 2
> D9 sync-envelope shape, scoped out of 1.4 by POD-364 §12 and filed under `sync-infrastructure` by
> ADR 1's matrix — and that re-phasing is what makes POD-302's gate pass. Multi-tenancy audited to
> zero: no `instance_id` on any representation, none in any migration, and all 151 `instanceId` sites
> are ADR 1 D5's deployment partition. **The audit found four session representations POD-364's hand
> pass missed** (`SessionInstructionContext`, `SessionSpawnResult`, `SessionInfo` — the session twin of
> the `IssueInfo` POD-367 corrected, in the same file — and `OptimisticSpawnArgs`), and **one real
> drift: two attribution pairs**, filed as **POD-1148**, whose reconciliation needs one decision
> nobody has made — does the actor's agent arm name the agent identity or the session it acted in? The
> existence-leak list (L-1…L-13, O1) and the cross-boundary edge question (O2) are confirmed handed to
> Phase 3 (POD-290) and marked **OPEN**. Three defects in this issue's own detector were found by its
> own tests before its numbers were believed: a brace-less alias absorbing the next function's
> parameter object, a LINE-anchored regex whose count would have silently dropped on a reflow, and a
> `Pick` counted as a restatement. Documents: `docs/rearch-vocabulary-audit.md`,
> `packages/model/src/representations/README.md`.
