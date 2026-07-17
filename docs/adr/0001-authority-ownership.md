# ADR 1 — Authority / ownership matrix

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-17
- **Deciders:** architecture rewrite ADR pack (POD-359); human sign-off before Phase 1
- **Issue:** POD-747 (leaf of POD-359 required ADR 1)
- **Consumers:** POD-304 (model annotations), POD-305 (Authority role), POD-306 (Replica /
  Outbox), POD-352 / POD-418–420 (secrets/preferences), POD-643 (handoff ownership row),
  POD-645 (instance vs machine identity)
- **Related ADRs (forward refs):** ADR 2 (sync protocol), ADR 3 (command security &
  lifecycle), ADR 4 (representation policy), ADR 5 (peer topology), ADR 6 (replica
  storage), ADR 7 (plane/message inventory), ADR 8 (package topology)
- **Specs:** [spec:SP-15aa] multi-instance isolation; [spec:SP-0371] hub/node federation
  deferred; [spec:SP-3fe2] strangler rebuild; [spec:SP-4428] drizzle-kit (server DB only —
  named here so ownership of *schema tool* is not confused with *wire authority*)

---

## Context

Podium's rewrite (POD-279 / docs/rearchitecture-v3.md) centers on **one sync kernel**:
Authority arbitrates truth per this matrix; Replica applies ordered revisions +
optimistic overlay and **never** arbitrates; Outbox delivers offline-eligible commands.
Without a binding ownership matrix, three failure modes reappear:

1. **Implicit writers** — merge/ownership knowledge lives in UpstreamSync / forwarder
   patch switches and scattered store methods (POD-304/309 retire that pattern).
2. **Wrong default conflict policy** — `docs/offline-sync-architecture.md` §5 (2026-07-02)
   described hub-arbitrated *writer authority* for daemon-observed rows and **per-field
   LWW on event time** for user-authored rows (issues, drafts, pins, snoozes, tab
   orders). The rewrite disposition (POD-359 item 1; POD-279 five moves) **rejects LWW
   as the default**: concurrent offline edits are rare enough that **one home +
   expected-revision** (or command-specific rejection/rebase) is safer and preserves
   invariants. Field-level LWW is opt-in only with defined clocks and
   invariant-preserving merges.
3. **Post-freeze drift** — instance identity ([spec:SP-15aa],
   `packages/runtime/src/instance.ts`) and the secrets-in-settings blob (POD-352) landed
   or crystallized after the plan froze; POD-359 drift refreshes require this ADR to
   place them.

**Topology (binding, [spec:SP-0371]):** local topology only — clients + **one server** +
**N paired machine daemons**. Hub↔node product federation is deferred (POD-353). This
ADR preserves a **federation seam** (named home roles, origin/causation hooks for ADR 2)
but does **not** specify authority transfer, loop prevention, or hub disappearance.

---

## Drift absorption (POD-359 comments — binding)

Each POD-359 drift clause is addressed **explicitly** for this ADR's scope:

| POD-359 drift clause | Owner ADR | Disposition in this document |
|---|---|---|
| (1) Drizzle-kit is decided fact ([spec:SP-4428]); wire/replica protocol version ≠ server DB drizzle journal; client stores not drizzle-managed; daemon binding store (POD-415) / mobile SQLite (POD-375) tooling undecided | **ADR 2 / ADR 6** primarily | **Recorded only as boundary:** server Authority persistence is the instance SQLite under drizzle journal. This ADR does **not** choose client/daemon migration tooling. |
| (2) **Instance identity** ([spec:SP-15aa], `packages/runtime/src/instance.ts`): InstanceId brand vs runtime-only; machine identity + pairing per-instance; feeds POD-645 | **This ADR** (+ package placement ADR 8) | **Decision D5** below. |
| (3) Plane inventory surface growth (handoff, messaging, workflows, browser-open, sessionResumeRefAck) | **ADR 7** | Handoff **ownership row** only: **matrix §9** (who mints export, source→target). Message classification is ADR 7. |
| Build orchestration / tsgo / turbo / `@podium/source` vs project-references | **ADR 8** | Out of scope here. |
| File discipline: one file `docs/adr/000N-…md`; no index | process | This file is **only** `docs/adr/0001-authority-ownership.md`. |

POD-304 drift (needs-human attribution; handoff bundle row) is absorbed in **matrix §3**
and **§9**.

---

## Decisions

### Decision D1 — Authority arbitrates; Replica never does

**Decision.** Durable truth is committed only by the **Authority** role (server-side
write funnel: authorize → mutate entity → append change → broadcast, one transaction —
POD-305). The **Replica** applies Authority-ordered revisions and bootstrap snapshots,
maintains optimistic overlays, and computes provenance envelopes; it **never** merges
concurrent truths, never invents LWW, and never overrides an Authority revision
(POD-306). The **Outbox** is durable command delivery to Authority, not a second
authority (ADR 3).

**Rationale.** Arbitration in more than one place is how the five half-finished
replication paths diverged. Optimistic UI (ADR 3 reducers) is UX-only and must yield to
the next Authority revision.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Client/replica field merges "when offline" | Creates divergent truths; untestable against a single conformance suite. |
| CRDT backbone (Yjs/Automerge) for metadata | Rejected in offline-sync §2: daemon observations are not mergeable ("session is busy"); CRDTs do not express single-writer authority. |
| Whole-aggregate last-replay-wins (today's interim outbox behavior) | Acceptable only as pre-kernel scar tissue; not the target default (POD-359 item 1). |

---

### Decision D2 — Default conflict rule: one home + expected-revision

**Decision.** For every durable field group **unless this ADR carves an exception**:

1. Exactly **one home authority** (named role: typically the instance **server**, or
   **daemon observation** folded through the server for fields the server cannot mint).
2. Mutating commands carry an **expected revision** (concrete wire field named by ADR 2 /
   ADR 3 — e.g. `expectedUpdatedAt`, entity etag, or per-entity revision).
3. On mismatch: Authority **rejects** (client rebases) **or** applies a
   **command-specific** rule documented on that command (e.g. append-only comment
   create). Silent whole-aggregate LWW is **not** the default.

**Rationale.** Low multi-writer contention (single-operator product); invariant-heavy
graphs (issue deps, parent, stage machines) break under blind LWW.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Default per-field LWW on client `event_time` for all user-authored rows (offline-sync §5) | Client clocks are not trustworthy; issue core/graph are not independent fields. |
| Default per-field LWW on server `event_time` for all user-authored rows | Still loses intent on concurrent structured edits; exp-rev surfaces conflicts to the user (POD-316). |

---

### Decision D3 — Field-level LWW is opt-in, clock-defined, closed-set

**Decision.** Field-level last-writer-wins is allowed **only** when **all** hold and the
matrix row says `conflict: field-LWW`:

1. **Defined clock** — winner is greater **Authority-assigned event time at commit**
   (server wall clock recorded on the change row / feed; see `changes.event_time` in
   server schema). **Client wall clocks never arbitrate** (may be attribution metadata).
2. **Independent field group** — no cross-field invariant with siblings that LWW would
   break.
3. **Low semantic risk** — preference-like concurrent offline edits.
4. **Tombstone/clear rule stated** — delete/clear of the group participates in the same
   clock (or is an explicit tombstone revision).

The **closed inventory** of field-LWW groups is listed under "Justified field-LWW
inventory" below. Adding a group requires an **ADR 1 amendment**, not a drive-by
annotation.

**Rationale.** Preserves the rare offline multi-device preference case without
re-opening default LWW.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Open-ended "LWW where low contention" without a list | Inevitably spreads; un-auditable. |
| Client `draftUpdatedAt` / local ISO as arbitration clock | Spoofable; non-monotonic across devices. |

---

### Decision D4 — Normative matrix columns

**Decision.** Every replicated aggregate / field group carries these annotations
(POD-304 totality test). Column meanings:

| Column | Meaning |
|---|---|
| **Home authority** | Role that may **commit** truth (`server`, `daemon→server`, `runtime-local`, `client-local`). |
| **ID minting** | Who generates the durable primary key / branded id and the format. |
| **Permitted writers** | Who may **propose** a mutation (operator, agent-session, daemon, system). Distinct from home: clients write via commands; Authority homes the row. |
| **Replication direction** | `server→clients`, `daemon→server→clients`, `client→server→clients`, `none`, `export-only`. |
| **Conflict rule** | `expected-revision` (default), `command-specific`, `field-LWW` (D3 only), `single-writer`, `append-only`, `live-ephemeral`. |
| **Tombstone** | Soft-delete / remove / hard-delete / never-delete; replica retention; recovery. |
| **Offline** | `offline-eligible`, `online-only`, `live-path-required`, `never-enqueue`, `observe-only`. |
| **Secret class** | `public`, `preference`, `secret-presence`, `secret-value`, `credential-local`. |

---

### Decision D5 — Instance identity ([spec:SP-15aa], feeds POD-645)

**Decision.**

1. **`InstanceId` is a branded model identity**, not a runtime-only untyped string.
   Validation remains the landed pattern in `packages/runtime/src/instance.ts`:
   `INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/`, default `"default"`
   (`DEFAULT_INSTANCE_ID`). Brand type placement is with other branded ids in
   `packages/model` (ADR 8 / POD-301 family); process bootstrap helpers may stay in
   `@podium/runtime` and depend on or re-export the brand.
2. **`InstanceId` is not a replicated aggregate.** It is the **deployment partition**
   of an entire Authority: state root (`instanceStateDir`), install root, derived
   ports (`defaultInstancePorts`), systemd unit names (`instanceServiceName`), durable
   PTY labels (`durableSessionLabel`), CLI name (`instanceCommandName`). Two instances
   on one machine are two isolated product universes ([spec:SP-15aa];
   `docs/multi-instance.md`).
3. **Machine identity + pairing are per-instance.** Each instance owns its own server
   DB and daemon identity file under that instance's state root
   (`apps/daemon/src/identity.ts` → `daemon.json` with once-minted `machineId` UUID +
   optional pairing token). **No `instance_id` column is required** on `machines` (or
   other fleet rows) while isolation is by **separate state DB** (implicit scope).
   Explicit columns are reserved only if a future shared multi-tenant store is adopted
   (out of scope; POD-645 implements composition-root **threading**, not a second
   scoping scheme).
4. **Home for the instance marker:** the local process that first claims the state dir
   (`ensureInstanceStateIdentity` → `instance.json` mode `0600`). Wrong-instance use of
   a state dir is a hard fail (`assertInstanceStateIdentity`). Cross-instance
   read/mutate/route is refused unless sharing is **explicitly** configured.
5. **Secret class:** instance id string is `public` within the instance (not a
   credential); pairing **tokens** are `secret-value` / `credential-local`.

**Rationale.** Instance identity already partitions every load-bearing path on disk and
on the wire ports; treating it as "runtime folklore" would leave POD-645 and branded-id
taxonomy without a home, and would invite accidental cross-instance joins.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Runtime-only concern (no brand, no matrix row) | POD-359 drift requires a decision; brandless strings re-create the dual-definition problem ADR 4 kills for other ids. |
| Replicated `Instance` entity in the oplog | Instances do not sync to each other; replication would invent a product surface that does not exist. |
| `instance_id` column on every machine/session row in the single-instance DB | Redundant under per-DB isolation; every row would share one constant. |
| Encode instance into `MachineId` | Collides distinct concepts (fleet join key vs deployment partition); breaks SP-15aa isolation tests that keep machine UUIDs per state root. |

---

### Decision D6 — Secrets never replicate or queue

**Decision.** Material classified **`secret-value`** (provider API keys under
`PodiumSettings.apiKeys`, `integrations.linearApiKey`,
`notifications.telegramBotToken`, pairing token preimages, managed credential blobs in
`accounts.credential`, client auth token preimages) is **server- or machine-local
only**. Wire/read projections expose **presence + fingerprint** at most
(`secret-presence`). Outbox **must not** enqueue secret writes (ADR 3: online-only +
apply-time re-auth).

**Preferences** (including `settings.experimental` — [spec:SP-f4b9], POD-418 drift:
intentionally replicated, no secret annotation) are `preference` / `public` and may be
offline-eligible.

Historical replica scrub for any secret that ever rode the settings blob: POD-419.

**Rationale.** POD-352: a generic offline `settings.set` would persist secrets into
browser/mobile replica storage and the outbox.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Keep one settings blob, redact at the replica edge only | Redaction bugs leak; outbox still serializes secrets. |
| Encrypt secrets in the replica | Still multiplies secret surface and key management; rejected vs server-only storage for self-hosted single trust domain of *values*, with presence on clients. |

---

### Decision D7 — Federation seam without product hub

**Decision.** Even with hub deferred ([spec:SP-0371] / POD-309 / POD-353):

- Changes and commands carry **origin / causation / mutation identity** (ADR 2) so a
  future hop can attribute writers.
- Home authority is named as a **role relative to the feed**, not "this OS process
  only," so a future hub can become home for a transferred aggregate without rewriting
  matrix *columns*.
- **No** authority transfer, loop prevention, or hub-disappearance product rules here.
- Existing UpstreamSync / UpstreamForwarder paths are retired in the rewrite; they are
  not the model. Envelope fields `viaHub` / `upstreamStale` on today's
  `SessionMeta` (`packages/protocol/src/messages/runtime-state.ts`) move to a
  provenance envelope (ADR 4 / POD-304), not entity payload.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Specify full hub arbitration now | User decision: deferred; value does not justify the work (SP-0371). |
| Delete all origin/causation hooks | Would force a second rewrite when hub returns. |

---

## Vocabulary: homes and writers

| Token | Meaning |
|---|---|
| **server** | The instance Authority process + its SQLite (`apps/server/src/migrations/schema.ts` via drizzle-kit / [spec:SP-4428]). Wire/replica protocol version is **independent** (ADR 2). |
| **daemon** | Paired machine runtime; observations enter via authenticated daemon→server control (ADR 5 / ADR 7). |
| **operator** | Authenticated human principal (transport-only principal — ADR 3). |
| **agent-session** | Podium session acting via tools/CLI with scoped policy. |
| **system** | Server-internal jobs (expiry, derived fields, boot reconcile). |
| **client-local** | Device-only state (outbox, optimistic overlay, replica cursor) — not Authority truth. |

---

## Entity inventory note (verified 2026-07-17 on integration tip)

Defining predicate for server durable tables: `sqliteTable(` in
`apps/server/src/migrations/schema.ts` → **48** tables (re-derived; not a frozen
2026-07-13 count). Product aggregates below are **grouped field-wise**; not every
table is its own matrix row (e.g. `issue_labels` / `issue_deps` fold into issue graph).
Sync infrastructure tables (`changes`, `applied_mutations`, `queued_messages`,
`upstream_outbox`, `client_sessions`) are covered in §10.

---

## Matrix

Notation: `exp-rev` = expected-revision (D2); `field-LWW` = D3; `single-writer` = only
home source; `cmd` = command-specific; `append` = append-only create; `n/a` = not durable
conflict.

### 1. Identity & deployment scope

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **InstanceId** (partition) | runtime-local claim of state dir | Operator / `PODIUM_INSTANCE` / CLI `--instance`; pattern above | Operator (select); process boot (`ensureInstanceStateIdentity`) | **none** | n/a — wrong marker → hard fail | Marker lifetime = state dir | n/a | public (id); marker file `0600` |
| **Machine** (fleet row / `machines`) | server | Daemon mints `machineId` UUID once in per-instance `daemon.json`; server registers on pair/hello | Daemon (identity); operator (rename/admin) | server→clients (public fields) | exp-rev on admin rename; **single-writer** for join key | Soft remove / token revoke (new secret, same MachineId) | online-only for pair/admin | public: id, name, hostname, lastSeen, inventory; **secret-value**: pairing token; **secret-presence**: paired? |
| **Pairing token / client session token** | server (hash at rest: `machines.token_hash`, `client_sessions.token_hash`) | Server mints at pair / login | Server only | **none** | n/a | Revoke rotates | online-only | **secret-value** |
| **Daemon local identity file** | daemon filesystem | Daemon mints MachineId | Daemon | **none** | n/a | File with instance state dir | n/a | MachineId public; token **credential-local** |

### 2. Sessions

Verified mint: `apps/server/src/modules/sessions/service.ts` uses `randomUUID()` for
create (server-assigned; daemon does not coin the registry id). Soft-delete columns:
`deleted_at`, `deletion_source`, `deleted_by_issue_id` on `sessions`.

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Session identity** (`sessionId`, birth display ref / letters) | server | Server UUID; ref letter server-allocated per issue (`issue_ref_letters`) | server create; operator/agent spawn commands | server→clients | immutable id after mint | Soft-delete `deletedAt` + source (+ `deletedByIssueId` on issue cascade); recoverable for issue-cascade | spawn: **live-path-required**; id not client-home-minted as Authority bypass | public |
| **Session placement** (`cwd`, `machineId`, `issueId`, `agentKind`, origin, headless, workflow pass-through ids) | server | n/a | operator/agent commands; system on handoff accept | server→clients | **exp-rev** (handoff accept = **cmd**) | follows session tombstone | issue attach offline-eligible where command class allows; machine move/spawn **live-path** | public |
| **User-authored labels** (`name`/`nameSource`, user `title`, `archived`, `workState`, `readAt`) | server | n/a | operator; agent self-title only when `nameSource` rules allow | server→clients | **`name`/`nameSource`:** exp-rev + rule user name not agent-overwritable; **`archived`/`workState`/`readAt`:** **field-LWW** | archive ≠ delete | offline-eligible | public |
| **Snooze** (`snoozes` / `snoozedUntil`) | server | n/a | operator | server→clients | **field-LWW** | clear = write null w/ clock | offline-eligible | public |
| **Composer draft** (`session_drafts` + `draftUpdatedAt`) | server | n/a | operator | server→clients (body may be lazy) | **field-LWW** whole draft body | empty deletes row | offline-eligible | public |
| **Queued agent messages** (`queued_messages`) | server | `mutationId` | operator send paths | count on session meta→clients; body not general replica | append FIFO per session; dedupe by mutationId | delete after deliver-toward-daemon | enqueue offline-eligible; **delivery live-path** | public |
| **Daemon-observed runtime** (`status`, `exitCode`, `epoch`, `geometry`, `resumable`/`resume`, `transcriptAvailable`, `busy`, `agentState` incl. `workingMsTotal`, harness `agentColor`, `clientCount`, activity timestamps) | **server** commit home; **source = daemon** | n/a | **daemon** (authenticated); server may fold/derive | daemon→server→clients | **single-writer** observation stream; clients cannot forge status | exited ≠ session tombstone | observe-only from clients | public |
| **Live-only / ephemeral** (PTY handles, controller set, in-flight handoff overlay, host metrics) | runtime-local | n/a | owning process | live planes (ADR 7); not durable oplog entities | live-ephemeral | die with process | n/a | public / not durable |
| **Provenance envelope** (`viaHub`, `upstreamStale`, `pendingSync`, future peer flags) | replica boundary | n/a | system/replica | envelope only (ADR 4 / POD-304) | n/a | n/a | stale-visible-on-disconnect | public |

### 3. Issues & tracker

Verified mint: `apps/server/src/modules/issues/service/crud.ts` —
`id: input.id ?? \`iss_${randomUUID()}\`` (client may propose id for optimistic
reconcile; Authority still homes). Comments: `cmt_${randomUUID()}`. Needs-human:
`humanQuestionAskedBy` is **server-authoritative** (tests in
`apps/server/src/issues.answer-question.test.ts`).

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Issue core** (title, description, design, acceptance, notes, type, priority, stage, assignee, due/defer, origin, audience, draft, panel, activity notes, …) | server | `iss_<uuid>` (optional client-proposed id accepted once at create) | operator, agent-session (policy) | server→clients | **exp-rev** on update; stage transitions may be **cmd** | soft-delete `deletedAt`; archive orthogonal | offline-eligible | public |
| **Needs-human group** (`needsHuman`, `humanQuestion`, options, `humanQuestionAskedBy`, `humanQuestionAskedAt`) | server | n/a | agent-session / operator; **askedBy server-authoritative at commit** | server→clients | **exp-rev** (group moves together) | clear is a write | offline-eligible w/ policy | public |
| **Issue graph** (parent, deps, labels, blocked_by, superseded_by, duplicate_of) | server | n/a | operator, agent-session | server→clients | **exp-rev** + **cmd** invariant checks — **not** field-LWW | edge remove explicit | offline-eligible; reject on invariant fail | public |
| **Issue comments** | server | `cmt_<uuid>` server | operator, agent-session | server→clients (detail may be lazy) | **append** create; edit/delete **exp-rev** if allowed | retain by default | offline-eligible create | public |
| **Issue messages** (tracker mail / `issue_messages`) | server | `msg_<uuid>` | system, agents, operator | server→clients | **append** + status **cmd** | retain for history | per messaging class | public |
| **Artifacts** (snapshotted files) | server storage | server artifact id | snapshot commands | **bulk** / lazy (ADR 7) | cmd | delete object; issue may retain refs | online/bulk | public bytes; path-validated |

### 4. Conversations & transcripts

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Conversation registry** | server | server-stable podium conversation id | server resolver + operator rename | server→clients | exp-rev on user fields; link rules **cmd** (bias against mis-merge) | soft remove from resume lists | registry synced; edits offline-eligible where commanded | public |
| **Segments / native evidence** | server map; bytes on disk lake | composite (`machine_id`, `native_id`) | daemon mirror + server ingest | meta→clients; **bytes bulk/lazy** | single-writer per segment identity | retention/compaction ADR 2 | tails offline; older on demand | public |
| **Blobs** | content-addressed store | sha256 | ingest | bulk/on-view | identity = hash | GC by retention | on-demand | public |

### 5. Repos, pins, tabs

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Repo / prefix** (`repos`, `repo_prefixes`) | server | path key; prefix server-unique | operator | server→clients | exp-rev on prefix rename | remove = cmd | online-preferred | public |
| **Pins** | server | entity ref key | operator | server→clients | **field-LWW** | unpin deletes row | offline-eligible | public |
| **Tab order** | server | worktree key | operator | server→clients | **field-LWW** whole order blob | scrub with sessions | offline-eligible | public |

### 6. Settings, secrets, accounts

Verified secret fields in `packages/runtime/src/settings.ts` `PodiumSettings`:
`apiKeys.openrouter|anthropic|openai`, `integrations.linearApiKey`,
`notifications.telegramBotToken` (chat id is routing config, not a bearer secret of the
same class — treat as `preference` / non-secret unless product policy tightens).
`experimental` is **preference** (POD-418).

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Preferences** (roles/session defaults, hibernation, sidebar, gitWorkflow, issues.assistant, steward, autoContinue, experimental, telegramChatId, ntfy topic name, …) | server | settings singleton / keys | operator | server→clients | **field-LWW** per preference key | reset-to-default = write | offline-eligible | **preference** |
| **Server-owned secrets** (apiKeys.*, linearApiKey, telegramBotToken, …) | server | n/a | operator online only | **none** for values; wire **secret-presence** (+ fingerprint) | online replace | clear server-side | **online-only**, never outbox | **secret-value** |
| **Managed credentials / accounts** (`accounts`) | server | server account id | operator; inject at spawn server→daemon | presence/identity to clients; **values never** | exp-rev | delete row | online-only for secret material | **secret-value** at rest |
| **Operator `config.features`** | process/config | n/a | operator / deploy | **none** via entity sync | n/a | n/a | n/a | public flags / deploy |

### 7. Coordination: locks, approvals, automations, workflows

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Advisory locks** (`locks`, `lock_waiters`; [spec:SP-85d1]) | server | key `(repo_id, name)` | sessions / operator | server→clients | **cmd** lease machine (grant/renew/steal/FIFO/expiry) | expiry releases | online-only recommended (server clock) | public |
| **Approval requests** | server | server id | daemon/agent create; operator decide | server→clients | **cmd** state machine | terminal states retained | decide online-only | public (payload redaction ADR 3) |
| **Automations / runs** | server | server id | operator; system fires | server→clients | exp-rev on defs | disable/delete cmd | defs offline-eligible; **fire needs server clock** | public |
| **Workflows / revisions / bindings / runs / steps / events / execution_profiles** | server | `wf_` / `wfr_` / `wrun_`-style server prefixes (see workflows service) | operator, coordinator sessions | server→clients | exp-rev on defs; **cmd** on run machine | archive / supersede | defs offline-eligible; run advance often live-path | public |

### 8. Messaging bus & superagent

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Messages** (`messages` substrate) | server | server id | principals per kind | server→clients | append + lifecycle **cmd** | retain / expire per fields | per offline class ADR 3 | public; redaction ADR 3 |
| **Messaging issue topics** | server | composite keys | system / bridge | server→clients as needed | exp-rev / cmd | delete mapping | online-preferred | public |
| **Superagent threads / pending / queued inputs** | server | server id | operator, system | server→clients (thread list) | exp-rev / cmd | archive thread | titles offline-eligible; turns often live | public |

### 9. Handoff / portable export (POD-643)

Verified: `packages/protocol/src/messages/handoff.ts` `HandoffManifest` includes
`sourceMachineId`, `exportedAt`.

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Handoff bundle / HandoffManifest** | **source server** mints export; **target server** accepts | bundle/snapshot ids server-side; session ids preserved as source brands | operator/agent handoff commands | **export-only** then source→target accept (not multi-home continuous sync) | accept **cmd** on target | export artifact retention separate from session tombstone | online-only (multi-machine) | public session fields; **no secrets** in manifest |

### 10. Sync infrastructure (not product entities)

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Change log** (`changes`) | server | server `seq` AUTOINCREMENT | Authority only | server→clients (protocol) | append-only | compaction/retention ADR 2 | n/a | public payloads subject to secret scrub |
| **Applied mutations** | server | client `mutationId` | Authority | **none** to general replica | dedupe by id | prune vs outbox horizon (ADR 2/3) | n/a | no secret payloads |
| **Client outbox** | client-local | client mutationId | client | drain→server | local FIFO partitions | dead-letter UX; never silent drop of user work | definition of offline path | **must not** hold secret-value |
| **Replica cursor / collections** | client-local cache | n/a | replica apply | n/a | Authority always wins | corrupt → cold start | read offline; write via outbox | no secret-value |
| **upstream_outbox** (legacy hub path) | n/a (retired with POD-309) | — | — | — | — | drop with forwarder | — | — |

---

## Justified field-LWW inventory (closed set)

| Group | Clock | Invariant note |
|---|---|---|
| Session `archived`, `workState`, `readAt` | Authority event time at commit | Orthogonal to daemon `status` / `agentState` |
| Session `snoozedUntil` | Authority event time | Orthogonal to agent phase |
| Session composer draft body + `draftUpdatedAt` | Authority event time | Whole draft body is one group |
| Pins | Authority event time | Per pin key |
| Tab order blob | Authority event time | Whole order vector is one group |
| Preference keys (non-secret settings) | Authority event time | Per key; secrets excluded |

Everything else defaults to **exp-rev**, **single-writer**, **append**, or **cmd**.

---

## Offline behavior summary

| Class | Behavior |
|---|---|
| **offline-eligible** | May enter client Outbox; optimistic overlay allowed; Authority re-auth at apply; matrix conflict applies at apply. |
| **online-only** | UI must not enqueue; includes all `secret-value` writes and pairing. |
| **live-path-required** | Needs reachable daemon: spawn, kill, resize, attach, deliver-to-PTY. Message **queue** may still be server-held. |
| **observe-only** | Clients never author; display last Authority revision (may be stale). |
| **never-enqueue** | Unsafe to buffer (ADR 3 delivery class). |

Vocabulary note (reconciliation): these five matrix values are ownership-matrix annotations that PROJECT onto ADR 3’s three delivery classes — `offline-eligible` → durable-queued; `online-only` and `never-enqueue` → command class (no enqueue); `live-path-required` → live class; `observe-only` has no write path at all. ADR 3 owns delivery-class semantics; this table only annotates which class each field/aggregate may use.

---

## Alignment with implementing issues

| Issue | Binding |
|---|---|
| **POD-304** | Annotate every aggregate/field group from this matrix; totality test; provenance on envelope; arbitration only Authority-side. |
| **POD-305** | Authority implements funnel + ledger; applies this matrix. |
| **POD-306** | Replica never arbitrates; Outbox for offline-eligible only. |
| **POD-352 / 418–420** | §6 preferences vs secrets; experimental is preference; scrub audit. |
| **POD-643** | §9 handoff/bundle. |
| **POD-645** | D5 InstanceId brand + per-instance machine/pairing; composition-root threading; no required machine.instance_id under per-DB isolation. |
| **POD-309 / SP-0371** | D7 seam; hub product out of scope. |

---

## Cross-ADR boundaries

| Concern | Owner |
|---|---|
| Feed epoch, cursor vs revision, tombstone retention/compaction, bootstrap | **ADR 2** |
| Command schemas, policy, re-auth, outbox states, redaction, optimistic reducers | **ADR 3** |
| Field definitions, envelopes vs entities, portable export composition | **ADR 4** |
| Peer roles, pairing auth strategies, capability fields | **ADR 5** |
| IndexedDB / SQLite replica engines, crash semantics | **ADR 6** |
| Control/stream/bulk planes; host↔server vs agent relay | **ADR 7** |
| Package placement for model brands / runtime bootstrap / build graph | **ADR 8** |
| Who may write; conflict; secrets; instance partition | **this ADR** |

---

## Consequences

### Positive

- Single answer to "who may change this?" for implementers and audits.
- Replicas cannot invent merge policy; conformance suite has one arbitrator.
- Default exp-rev preserves issue-graph and lifecycle invariants.
- Closed LWW set prevents silent spread of event-time races.
- Secrets and instance isolation are first-class (unblocks POD-352, POD-645).
- Federation seam keeps SP-0371 honest without building a hub.

### Negative / cost

- Expected-revision requires reject/rebase UX (POD-316).
- Annotating every field group (POD-304) is up-front work.
- Offline-sync-era LWW for issue **core** is **tightened** to exp-rev — concurrent
  multi-device issue body edits may reject more often (acceptable for single-operator).

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| LWW set grows casually | Closed inventory; amendment required; POD-304 review. |
| Replica "helpfully" merges | Lint/test: no merge policy outside Authority (POD-305/306). |
| Secrets leak via settings | POD-419 scrub; presence-only wire; outbox refuse secret class. |
| InstanceId confused with MachineId | D5; multi-instance suite; POD-645 threading. |
| Daemon-forged session registry ids | ID minting stays server-side (documented inversion). |

---

## Compliance checklist

**In compliance** when:

- [ ] New durable fields declare matrix columns (or join an existing group).
- [ ] Conflict is exp-rev / cmd / single-writer / append unless on the closed field-LWW list.
- [ ] Replica/client code applies Authority order only.
- [ ] `secret-value` never appears in replica storage, outbox payloads, or wire reads.
- [ ] Session ids and issue ids follow declared mint rules.
- [ ] InstanceId is partition scope + brand, not a synced entity and not a MachineId substitute.
- [ ] Handoff exports carry source provenance and contain no secrets.

**Out of compliance** when client-side LWW/merge for durable truth is added, secrets
replicate, server-owned ids are minted as a bypass of Authority, or InstanceId is
treated as optional folklore.

---

## Status and sign-off

| Stage | Owner |
|---|---|
| Proposed | POD-747 (this document) |
| Pack reconciliation + index | POD-359 |
| Human approval | POD-359 human gate |
| Implemented annotations | POD-304 |
| Enforced at write seam | POD-305 |
| Instance brand wiring | POD-645 (+ ADR 8 placement) |

Until human sign-off of the ADR pack, Phase 1–2 must not treat alternate ownership or
conflict strategies as authorized. Amendments after sign-off require an ADR update and
POD-359 tracker reconciliation.

---

## Self-verification record (docs leaf)

Checked against integration tip `ca361327` + this branch (2026-07-17):

| Claim | Verification |
|---|---|
| `INSTANCE_ID_PATTERN`, `DEFAULT_INSTANCE_ID`, `ensureInstanceStateIdentity`, `instance.json` | `packages/runtime/src/instance.ts` |
| Daemon `machineId` UUID mint in `daemon.json` | `apps/daemon/src/identity.ts` |
| Session id `randomUUID()` server create | `apps/server/src/modules/sessions/service.ts` (~L1036; also `input.sessionId ?? randomUUID()` at adopt paths) |
| Issue id `iss_${randomUUID()}` optional client id | `apps/server/src/modules/issues/service/crud.ts` ~L205 |
| Comment id `cmt_${randomUUID()}` | same crud.ts ~L474 |
| `humanQuestionAskedBy` server-authoritative | `apps/server/src/issues.answer-question.test.ts` |
| Session tombstone columns | `apps/server/src/store/sessions.ts` (`deleted_at`, `deletion_source`, `deleted_by_issue_id`) |
| Settings secret vs experimental | `packages/runtime/src/settings.ts` `PodiumSettings` |
| Handoff `sourceMachineId` / `exportedAt` | `packages/protocol/src/messages/handoff.ts` |
| `viaHub` / `upstreamStale` on SessionMeta today | `packages/protocol/src/messages/runtime-state.ts` |
| Server table count **48** | `rg -c 'sqliteTable\(' apps/server/src/migrations/schema.ts` |
| SP-15aa / SP-0371 / SP-4428 text | `podium spec show` |
| POD-359 item 1 + drift comments | `podium issue show 359` (description + comments including instance-identity clause) |
| Offline-sync LWW default being superseded | `docs/offline-sync-architecture.md` §5 |
| Kernel wording | `docs/rearchitecture-v3.md` §1 move 2 |
