# ADR 1 — Authority / ownership matrix

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-17
- **Deciders:** architecture rewrite ADR pack (POD-359); human sign-off before Phase 1
- **Issue:** POD-747 (leaf of POD-359 item 1)
- **Consumers:** Phase 1 model annotations (POD-304); Phase 2 Authority role (POD-305);
  Replica/Outbox (POD-306); secrets/preferences split (POD-352 / POD-418–420); instance
  vs machine identity (POD-645); handoff ownership row (POD-643)
- **Related ADRs:** ADR 2 (sync protocol), ADR 3 (command security & lifecycle),
  ADR 4 (representation policy), ADR 5 (peer topology), ADR 6 (replica storage),
  ADR 7 (plane/message inventory), ADR 8 (package topology)
- **Specs:** [spec:SP-15aa] multi-instance isolation; [spec:SP-0371] hub/node federation
  deferred; [spec:SP-3fe2] strangler rebuild decisions

---

## Context

Podium's rewrite centers on **one sync kernel** (Authority / Replica / Outbox). Without a
binding ownership matrix, three failure modes reappear:

1. **Implicit writers** — today's UpstreamSync / forwarder patch switch and scattered
   store methods encode "who may write what" as tribal knowledge. Replicas and offline
   clients invent local merge rules that diverge from the server.
2. **Wrong default conflict policy** — the 2026-07-02 offline-sync architecture described
   hub-arbitrated *writer authority* for daemon-observed rows and **per-field LWW on
   event time** for many user-authored rows. The 2026-07-13 adversarial review rejected
   that as the *default*: concurrent offline edits are rare enough that
   **expected-revision** (or command-specific rejection/rebase) is safer and simpler.
   Field-level LWW is allowed only where this ADR explicitly justifies it with a
   defined clock and invariant-preserving merge.
3. **Secrets and instance scope** — settings today ship as one blob containing provider
   keys and tokens (POD-352). Instance identity landed after the plan froze
   ([spec:SP-15aa], `packages/runtime/src/instance.ts`): it is a layer *above* machine
   identity that Phase-4 work (POD-645) and this matrix must place.

**Topology scope (binding):** local topology only — browser/mobile/desktop clients +
**one server** + **N paired machine daemons** ([spec:SP-0371]). Hub↔node federation is
deferred; the matrix preserves a **federation seam** (home authority identity, origin/
causation on changes and commands, no same-machine assumptions in the kernel ports)
so a future hub does not rewrite ownership rules. No product federated arbitration is
specified here.

This ADR is the binding decision for **who owns truth**, **who may mint IDs**, **who
may write**, **how replicas move**, **how conflicts resolve**, **how deletes tombstone**,
**what offline means**, and **what is secret**. Phase 1 carries the matrix as
annotations on model field groups (POD-304); Authority alone enforces it (POD-305).

---

## Decision

### D1 — Authority arbitrates; Replica never does

| Role | Responsibility |
|---|---|
| **Authority** | Sole arbitrator of durable truth. Receives commands (online or outbox-drained), re-authenticates principal at apply time (ADR 3), applies the ownership matrix (expected-revision, rejection, rebase, or justified field merge), writes entity + change log **in one transaction**, assigns feed sequence/revision (ADR 2). |
| **Replica** | Applies **Authority-ordered** revisions and bootstrap snapshots; maintains optimistic overlays for local UX; computes provenance envelopes; heals gaps via `changesSince`. **Never merges concurrent truths, never invents LWW, never overrides an Authority revision.** |
| **Outbox** | Durable delivery of offline-eligible commands *to* Authority; not a second authority. Ordering partitions, retry/age, dead-letter recovery: ADR 3 / POD-306. |

Any merge policy code in client/replica packages is a defect. Optimistic UI reducers
(ADR 3) are **not** conflict arbitration: they may be overwritten wholesale by the next
Authority revision.

### D2 — Default conflict rule: one home + expected-revision

For every durable field group **unless this ADR carves out an exception**:

1. **Exactly one home authority** (a named role: typically the **server** for the
   instance's SQLite authority, or the **paired daemon** for observations the server
   cannot mint itself).
2. Mutations carry an **expected revision** (or equivalent command precondition:
   `expectedUpdatedAt`, `expectedEpoch`, entity etag — concrete field named in ADR 2 /
   command contracts).
3. On mismatch: Authority **rejects** (client must rebase on current state) **or**
   applies a **command-specific** merge documented on that command (e.g. append-only
   comment create has no expected body revision). Silent last-writer-wins of whole
   aggregates is forbidden as a default.

### D3 — Field-level LWW is opt-in, clock-defined, invariant-safe

Field-level last-writer-wins is permitted **only** when **all** of the following hold
and the matrix row says `conflict: field-LWW`:

1. **Defined clock** — the winning value is the one with the greater
   **Authority-assigned event time** at commit (server wall clock at apply, recorded on
   the change). Client wall clocks are **never** the arbitration clock (they may be
   stored as attribution metadata only).
2. **Independent field group** — the group has no cross-field invariant with sibling
   groups that LWW would break (e.g. do not LWW `parentId` independently of a
   dependency-cycle check).
3. **Low semantic risk** — concurrent offline edits of the same group are preference-
   like (pin, snooze, draft text, tab order), not graph structure or lifecycle stage
   transitions with side effects.
4. **Tombstone rule stated** — delete/clear of that group wins over stale sets by the
   same clock (or is modeled as a tombstone revision, not a silent drop).

If any condition fails, use expected-revision / reject.

**No CRDTs** as backbone (retained from offline-sync rejected alternatives). Yjs/etc.
remain out of scope unless a future ADR carves a single collaborative surface.

### D4 — Matrix columns (normative annotation shape)

Every replicated aggregate and field group carries these annotations (POD-304 totality
test). Column meanings:

| Column | Meaning |
|---|---|
| **Home authority** | Role that may commit truth for this group (`server`, `daemon:<machine>`, `client-local-only`, `runtime-local`). |
| **ID minting** | Who generates the durable primary key / branded id, and the mint format. |
| **Permitted writers** | Principals/roles allowed to *propose* a mutation (operator, agent session, daemon observation, system). Distinct from home authority: a client may write via command while Authority still homes the row. |
| **Replication direction** | `server → clients` (fan-out), `daemon → server → clients` (observe then fan-out), `client → server → clients` (command then fan-out), `none` (not replicated), `export-only` (portable bundle). |
| **Conflict rule** | `expected-revision` (default), `command-specific`, `field-LWW` (only if D3 satisfied), `single-writer` (home is the only source; stale writers rejected without client revision), `append-only`, `live-ephemeral` (no durable conflict). |
| **Tombstone** | Soft-delete / remove / hard-delete / never-delete; what replicas must retain; recovery path. |
| **Offline** | `offline-eligible` (outbox), `online-only`, `live-path-required` (needs daemon), `never-enqueue`, `observe-only`. |
| **Secret class** | `public` (replicable payload), `preference` (client-safe settings), `secret-presence` (wire may show set/fingerprint), `secret-value` (never on wire, replica, or outbox), `credential-local` (stays on machine/daemon filesystem). |

### D5 — Instance identity ([spec:SP-15aa], feeds POD-645)

**Decision:**

1. **`InstanceId` is a branded model identity**, not a runtime-only opaque string.
   Validation stays the existing pattern (`^[a-z][a-z0-9-]{0,31}$`, default
   `"default"`). Brand lives in `packages/model` (placement with other branded ids —
   POD-301 / ADR 8); construction/validation helpers may remain in
   `@podium/runtime` as the process-bootstrap owner, re-exporting or depending on the
   brand type once model lands.
2. **`InstanceId` is not a replicated aggregate.** It is the **deployment partition**
   of an entire Authority: state root (`instanceStateDir`), install root, ports,
   systemd unit names, durable PTY labels, CLI command name. Two instances on one
   machine are two isolated product universes ([spec:SP-15aa]).
3. **Machine identity + pairing are per-instance.** Each instance owns its own server
   DB and daemon `daemon.json` under that instance's state root. `MachineId` is minted
   once by the daemon into that instance's `daemon.json` and registered in **that**
   instance's `machines` table. **No `instance_id` column is required on fleet/machine
   rows** while isolation is by separate state DB (implicit scope). Explicit
   `InstanceId` on machine rows is reserved only if a future shared multi-tenant store
   is adopted — out of scope here; POD-645 implements composition-root threading, not
   a second scoping scheme.
4. **Home authority for the instance marker:** the local process that first claims the
   state dir (`ensureInstanceStateIdentity` → `instance.json` mode `0600`). Cross-
   instance reads/writes/routing are refused unless sharing is **explicitly**
   configured (operator override). Replicas of *other* instances never receive this
   marker via sync.
5. **Secret class:** instance marker is `public` within the instance (id is not a
   credential); pairing **tokens** remain `secret-value` / `credential-local`.

### D6 — Secrets never replicate or queue

- **`secret-value`** material (API keys, bot tokens, pairing secrets, managed
  credential blobs, client auth token hashes' preimages) is **server- or
  machine-local only**. Wire projections expose **presence + fingerprint** at most
  (`secret-presence`). Outbox **must not** enqueue secret writes (ADR 3 online-only +
  re-auth).
- Preferences (`settings.experimental`, session defaults that are not keys, UI
  layout prefs) are `preference` / `public` and may be offline-eligible.
- Historical replica scrub for any secret that ever rode the settings blob: POD-419.

### D7 — Federation seam (no product hub)

Even with hub deferred ([spec:SP-0371]):

- Every change and command carries **origin / causation / mutation identity** (ADR 2)
  so a future hop can attribute writers without re-homing entities.
- Home authority is named as a **role relative to the feed**, not "this OS process
  only," so a future hub can become home for a transferred aggregate without
  rewriting matrix *columns*.
- **No authority transfer, loop prevention, or hub-disappearance rules** are decided
  here — parked in POD-353. Existing UpstreamSync/UpstreamForwarder paths are retired
  during the rewrite (POD-309); they are not the model.

---

## Vocabulary: homes and writers

| Token | Meaning |
|---|---|
| **server** | The instance's Authority process + its SQLite (drizzle journal = server DB schema version; **not** the wire/replica protocol version — ADR 2). |
| **daemon** | A paired machine runtime; observations and PTY-side facts enter via authenticated daemon→server control plane (ADR 5 / ADR 7). |
| **operator** | Authenticated human principal on client/CLI/MCP (principal from transport only — ADR 3). |
| **agent-session** | A Podium session acting via agent tools/CLI with scoped policy. |
| **system** | Server-internal jobs (expiry sweeps, derived fields, boot reconcile). |
| **client-local** | Device-only state (outbox queue, optimistic overlay, replica cursor) — not Authority truth. |

---

## Matrix

Rows are **aggregates** or **field groups**. Field groups that always move together share
one row. "Server" means the instance Authority unless noted.

Notation for conflict: `exp-rev` = expected-revision (D2); `field-LWW` = D3;
`single-writer` = only home may produce the value; `cmd` = command-specific;
`append` = append-only create; `n/a` = not durable / not conflicting.

### 1. Identity & deployment scope

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **InstanceId** (partition) | runtime-local claim of state dir | Operator / env / CLI `--instance`; validated brand | Operator (select); process boot (claim marker) | **none** (not an entity feed) | n/a — wrong marker → hard fail | Marker file lifetime = state dir; no cross-instance tombstone | n/a | public (id); marker file mode 0600 |
| **Machine** (fleet row) | server | Daemon mints `MachineId` UUID once in per-instance `daemon.json`; server registers on pair/hello | Daemon (identity claim); operator (rename/admin) | server → clients (public fields) | exp-rev on admin rename; **single-writer** for join key | Soft remove from fleet UI; token revoke = new secret, same MachineId | online-only for pair/admin | public: id, name, hostname, lastSeen; **secret-value**: pairing token; **secret-presence**: paired? |
| **Pairing token / client session token** | server (hash storage) | Server mints at pair / login | Server only | **none** (hash at rest; never to replicas) | n/a | Revoke deletes/rotates; receipts independent | online-only | **secret-value** |
| **Daemon local identity file** | daemon filesystem | Daemon mints MachineId | Daemon | **none** | n/a | File lifecycle with instance state dir | n/a | MachineId public; token **credential-local** |

### 2. Sessions

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Session identity** (`sessionId`, birth `displayRef` / ref letters) | server | Server `randomUUID()` (not daemon — ownership inversion); ref letter server-allocated per issue | server create path; operator/agent spawn commands | server → clients | n/a after mint (immutable id) | Soft-delete `deletedAt` + `deletionSource` (+ `deletedByIssueId` when issue cascade); recoverable for issue-cascade; hard purge is maintenance | spawn: **live-path-required** (daemon); identity itself not client-minted offline | public |
| **Session placement** (`cwd`, `machineId`, `issueId`, `agentKind`, origin, headless, workflow pass-through) | server | n/a | operator/agent via commands; system on handoff accept | server → clients | **exp-rev** (or cmd for handoff accept) | follows session tombstone | issue attach / rename paths: offline-eligible where command class allows; **spawn/move machine: live-path** | public |
| **User-authored session labels** (`name`/`nameSource`, `title` when user-set, `archived`, `workState`, `readAt`) | server | n/a | operator (and agent only when `nameSource` rules allow agent self-title) | server → clients | **`name`/`nameSource`:** exp-rev with rule: user name **cannot** be overwritten by agent; **`archived`/`workState`/`readAt`:** **field-LWW** (D3; Authority event_time) | archive ≠ delete; delete uses session tombstone | offline-eligible | public |
| **Snooze** (`snoozedUntil`) | server | n/a | operator | server → clients | **field-LWW** | clear = write null with clock | offline-eligible | public |
| **Composer draft** (`session_drafts` text + `draftUpdatedAt`) | server | n/a | operator (session composer) | server → clients (timestamp on meta; body may be lazy) | **field-LWW** on draft body by Authority event_time | empty draft deletes row | offline-eligible | public (user text; not secret class) |
| **Queued agent messages** (server-held queue) | server | `mutationId` client-or-server | operator send paths | count on session meta → clients; body **not** general replica payload | append FIFO per session; dedupe by mutationId | delete only after deliver-toward-daemon | enqueue offline-eligible; **delivery live-path** | public |
| **Daemon-observed runtime** (`status`, `exitCode`, `epoch`, `geometry`, `resumable`/`resume`, `transcriptAvailable`, `busy`, `agentState` incl. `workingMsTotal`, `agentColor` when harness-observed, `clientCount`, activity timestamps) | **server** as commit home; **source writer = daemon** for observations | n/a | **daemon** (authenticated); server may derive/fold | daemon → server → clients | **single-writer** (daemon observation stream); stale node/client **cannot** clobber; server rejects client attempts to forge status | status may become exited; session tombstone separate | observe-only from clients; requires daemon path for fresh values | public |
| **Live-only / ephemeral** (PTY handles, controller set, in-flight `handoffTarget` overlay, host metrics) | runtime-local | n/a | owning process | stream/control planes as live messages (ADR 7); **not** durable oplog entities | live-ephemeral | die with process | n/a | public / not stored |
| **Provenance envelope** (`viaHub`, `upstreamStale`, `pendingSync`, future peer flags) | replica boundary | n/a | system/replica | envelope only — **not** entity fields (ADR 4 / POD-304) | n/a | n/a | stale-visible-on-disconnect | public |

### 3. Issues & tracker

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Issue core** (title, description, design, acceptance, notes, type, priority, stage, assignee, due/defer, origin, audience, draft, panel, activity notes, …) | server | Server mints `iss_<uuid>`; human `PREFIX-seq` from repo seq | operator, agent-session (policy-scoped) | server → clients | **exp-rev** on update (default); stage transitions may be **cmd** (validate machine) | soft-delete `deletedAt`; archive flag orthogonal | offline-eligible | public |
| **Needs-human attribution** (`needsHuman`, `humanQuestion`, options, `humanQuestionAskedBy`, `humanQuestionAskedAt`) | server | n/a | agent-session / operator; **askedBy is server-authoritative** at commit | server → clients | **exp-rev** (group moves together) | clear needs-human is a write, not tombstone of issue | offline-eligible with apply-time policy | public |
| **Issue graph** (parent, deps, labels, blocked_by, superseded_by, duplicate_of) | server | n/a | operator, agent-session | server → clients | **exp-rev** + **cmd** invariant checks (cycles, type rules) — **not** field-LWW | edge delete = explicit remove; cascade rules per command | offline-eligible; reject on invariant fail | public |
| **Issue comments** | server | Server mints comment id | operator, agent-session | server → clients (list may be lazy detail) | **append** create; edit/delete **exp-rev** if allowed | soft or hard per command; default retain | offline-eligible create | public |
| **Issue messages** (agent messaging substrate) | server | Server mints message id | system, agents, operator per messaging rules | server → clients (thread projections) | **append** + status machine **cmd** | retain for thread history | enqueue rules per ADR 3 / messaging specs | public |
| **Artifacts** (snapshotted files) | server storage | Server artifact id | agent/operator snapshot commands | **bulk** plane / lazy; not full metadata fan-out | cmd | delete artifact object; issue may retain refs | online/bulk | public bytes; paths validated |

### 4. Conversations & transcripts

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Conversation registry** (Podium conversation id, title/name/summary, hierarchy) | server | Server mints stable `podium_id` | server resolver + operator rename | server → clients | exp-rev on user fields; registry link rules **cmd** (bias against mis-merge) | soft archive/remove from resume lists; segments may remain | registry always synced; edits offline-eligible where commanded | public |
| **Segments / native evidence** | server map; bytes on disk lake | composite (machineId, nativeId) | daemon mirror + server ingest | meta → clients; **bytes bulk/lazy** | single-writer per segment identity; no client forge | retention/compaction ADR 2 | tails of recent/pinned offline; older on demand | public |
| **Blobs** (images) | server content-addressed | sha256 | ingest pipeline | bulk/on-view | content-address LWW by hash identity | GC by retention | on-demand | public |

### 5. Repos, pins, tabs, UI chrome

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Repo / prefix** | server | path key; prefix server-derived unique | operator add/remove | server → clients | exp-rev on prefix rename | remove repo = cmd (issues may remain constrained) | online-preferred (path validity) | public |
| **Pins** | server | (entity ref) | operator | server → clients | **field-LWW** | unpin = delete row | offline-eligible | public |
| **Tab order** | server | worktree key | operator | server → clients | **field-LWW** whole order blob | delete worktree order on scrub | offline-eligible | public |

### 6. Settings, secrets, accounts

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Preferences** (session defaults, experimental flags, non-secret UI/behavior toggles) | server | n/a (settings singleton / keys) | operator | server → clients | **field-LWW** per preference key (D3) | reset-to-default = write | offline-eligible | **preference** |
| **Server-owned secrets** (provider API keys, Linear key, Telegram bot token, …) | server | n/a | operator online commands only | **none** for values; wire **secret-presence** (+ fingerprint) only | exp-rev / online replace | clear secret = write empty server-side | **online-only**, never outbox | **secret-value** |
| **Managed credentials / accounts** | server | account id server-minted | operator; injection at spawn is server→daemon | presence/identity to clients; **values never** | exp-rev | delete account row | online-only for secret material | **secret-value** at rest; spawn env is daemon-local ephemeral |
| **Operator layer `config.features`** | server config file / process | n/a | operator / deploy | **none** via entity sync (outside settings blob) | n/a | n/a | n/a | public flags / deploy concern |

### 7. Coordination: locks, approvals, automations, workflows

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Advisory locks** ([spec:SP-85d1]) | server | lock key = (repoId, name) | sessions / operator via lock commands | server → clients (holder visibility) | **cmd** lease semantics (grant, renew, steal, FIFO waiters, expiry sweep) — not LWW | expiry releases; no soft tombstone | online-only recommended (lease clock is server) | public |
| **Approval requests** | server | server id | daemon/agent creates; operator decides | server → clients | **cmd** state machine | terminal states retained | decide online-only | public (op payload may need redaction — ADR 3) |
| **Automations** | server | server id | operator | server → clients | exp-rev | disable/delete cmd | schedule edits offline-eligible; **fire requires server clock** | public |
| **Workflows / revisions / runs / steps** | server | `wf_` / `wfr_` / `wrun_` prefixes server-minted | operator, coordinator sessions | server → clients | exp-rev on definitions; **cmd** on run state machine | archive workflow; supersede runs | definition offline-eligible; run advances often live-path | public |

### 8. Messaging bus & superagent

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Messages** (agent messaging frames substrate) | server | server id | principals per kind rules | server → clients | append + lifecycle **cmd** | retain / expire per message fields | offline enqueue per class | public; redaction ADR 3 |
| **Superagent threads / pending turns** | server | server id | operator, system | server → clients (thread list) | exp-rev / cmd | archive thread | thread title offline-eligible; turns often live | public |

### 9. Handoff / portable export (POD-643)

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Handoff bundle / HandoffManifest** | **source server** mints export; **target server** Authority accepts import | bundle id / snapshot ids server-side; session ids preserved as branded ids from source | operator/agent handoff commands | **export-only** then **source → target** accept path (not continuous multi-home sync) | accept is **cmd** on target (reject if conflict with existing session ids / machine) | source may retain export artifact per retention; not a replica tombstone | online-only (multi-machine) | public session fields; **no secrets** in manifest |

Provenance fields `sourceMachineId`, `exportedAt` are part of the export projection
(ADR 4 R6), attributed at mint by source Authority — not client-forged.

### 10. Sync infrastructure (not product entities)

| Aggregate / field group | Home | ID minting | Writers | Replication | Conflict | Tombstone | Offline | Secret |
|---|---|---|---|---|---|---|---|---|
| **Change log / feed** | server | server `seq` | Authority only | server → clients (protocol) | append-only log | compaction/retention ADR 2 | n/a | public payloads subject to secret scrub |
| **Applied mutations (receipts)** | server | client `mutationId` | Authority | **none** to general replica | dedupe by id | prune by retention (reconcile with outbox horizon — ADR 2/3) | n/a | no secret payloads retained |
| **Client outbox** | client-local | client mutationId | client | drain → server only | local FIFO partitions | dead-letter UX; never silent drop of user work | definition of offline path | **must not** hold secret-value |
| **Replica cursor / collections** | client-local cache of server truth | n/a | replica apply | n/a | Authority wins always | corrupt → wipe cold start | read offline; write via outbox | no secret-value |

---

## Justified field-LWW inventory (closed set)

Only these groups use **field-LWW** under D3. Adding another requires an **ADR 1
amendment** (or POD-359 reconciliation note) — not a drive-by model annotation.

| Group | Clock | Invariant note |
|---|---|---|
| Session `archived`, `workState`, `readAt` | Authority `event_time` at commit | Orthogonal to daemon `status` / `agentState` |
| Session `snoozedUntil` | Authority `event_time` | Orthogonal to agent phase |
| Session composer draft body + `draftUpdatedAt` | Authority `event_time` | Whole draft body is one group |
| Pins | Authority `event_time` | Per pin key |
| Tab order blob | Authority `event_time` | Whole order vector is one group |
| Preference keys (non-secret settings) | Authority `event_time` | Per key; secrets excluded |

Everything else defaults to **exp-rev**, **single-writer**, **append**, or **cmd** as
tabled above.

---

## Offline behavior summary

| Class | Behavior |
|---|---|
| **offline-eligible** | Command may enter client Outbox; optimistic overlay allowed; Authority re-auth at apply; matrix conflict rule applies at apply. |
| **online-only** | UI must not enqueue; includes all `secret-value` writes and pairing. |
| **live-path-required** | Needs reachable daemon (or equivalent): spawn, kill, resize, attach, deliver-to-PTY. UI disabled when path down (except message **queue** which is server-held). |
| **observe-only** | Clients never author; they display last Authority revision (may be stale). |
| **never-enqueue** | Command-plane operations that are unsafe to buffer (ADR 3 delivery class). |

Stale-visible-on-disconnect: Replica keeps last applied revisions; envelope may mark
staleness; **does not** freeze Authority clocks.

---

## Alignment with issues

| Issue | Binding |
|---|---|
| **POD-304** | Annotate every aggregate/field group from this matrix; totality test; provenance on envelope; arbitration only in Authority-facing code. |
| **POD-305** | Authority implements funnel + ledger; applies this matrix; drizzle adapter owns generic sync tables. |
| **POD-306** | Replica never arbitrates; Outbox lifecycle for offline-eligible only. |
| **POD-352 / 418–420** | Preferences vs secrets split matches §6; scrub audit; experimental is preference. |
| **POD-643** | Handoff/bundle row §9. |
| **POD-645** | InstanceId brand + per-instance machine/pairing scope §D5; composition root threads InstanceId; no required machine.instance_id column under per-DB isolation. |
| **POD-309 / SP-0371** | Hub product out of scope; seam preserved (D7). |

---

## Cross-ADR boundaries

| Concern | Owner |
|---|---|
| Feed epoch, cursor vs revision, tombstone retention/compaction, bootstrap | **ADR 2** |
| Command schemas, policy, re-auth, outbox states, redaction, optimistic reducers | **ADR 3** |
| Field definitions, envelopes vs entities, portable export composition | **ADR 4** |
| Peer roles, pairing auth strategies, capability fields | **ADR 5** |
| IndexedDB / SQLite replica engines, crash semantics | **ADR 6** |
| Control/stream/bulk planes; host↔server vs agent relay separation | **ADR 7** |
| Package placement for model brands / runtime bootstrap | **ADR 8** |
| Who may write; conflict; secrets; instance partition | **this ADR** |

---

## Consequences

### Positive

- Single place to answer "who is allowed to change this?" for implementers and audits.
- Replicas and offline clients cannot invent merge policy.
- Default exp-rev matches low multi-writer contention and preserves invariants.
- Explicit LWW closed set prevents silent spread of event_time races.
- Secrets and instance isolation are first-class, unblocking POD-352 and POD-645.
- Federation seam keeps SP-0371 honest without building a hub.

### Negative / cost

- Expected-revision requires clients to surface rebase/reject UX (POD-316).
- Annotating every field group (POD-304) is up-front work before Phase 2 cutover.
- Some offline-sync-era LWW assumptions for issue core fields are **tightened** to
  exp-rev — multi-device concurrent issue body edits may reject more often (acceptable;
  single-operator product).

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| LWW set grows casually | Closed inventory; amendment required; POD-304 totality + review. |
| Replica "helpfully" merges | Lint/test: no merge policy outside Authority package (POD-305/306). |
| Secrets leak into replica via settings | POD-419 scrub; wire presence-only; outbox refuse secret class. |
| InstanceId confused with MachineId | D5; multi-instance suite; POD-645 composition-root threading. |
| Daemon-forged session ids return | ID minting stays server-side (documented inversion). |

---

## Compliance checklist

A change is **in compliance** when:

- [ ] New durable fields declare matrix columns (or join an existing field group).
- [ ] Conflict rule is `exp-rev` / `cmd` / `single-writer` / `append` unless the field
      is on the closed field-LWW inventory (or an ADR amendment adds it).
- [ ] Replica/client code applies Authority order only — no local arbitration.
- [ ] `secret-value` never appears in replica storage, outbox payloads, or wire reads.
- [ ] Session ids and issue ids are minted only by the declared home.
- [ ] InstanceId is treated as partition scope + brand, not a synced entity and not a
      MachineId substitute.
- [ ] Handoff exports carry source provenance and contain no secrets.

A change is **out of compliance** when it adds client-side LWW/merge for durable
truth, replicates secret material, mints server-owned ids on the client/daemon, or
treats InstanceId as optional folklore outside the brand/partition rules.

---

## Status and sign-off

| Stage | Owner |
|---|---|
| Proposed | POD-747 (this document) |
| Pack reconciliation + index | POD-359 |
| Human approval | POD-359 human gate (`needs-human` + signed ADR frontmatter) |
| Implemented annotations | POD-304 (Phase 1) |
| Enforced at write seam | POD-305 (Phase 2 Authority) |
| Instance brand wiring | POD-645 (with ADR 8 placement) |

Until human sign-off of the ADR pack, Phase 1–2 must not treat alternate ownership or
conflict strategies as authorized. Amendments after sign-off require an ADR update and
POD-359 / tracker reconciliation.
