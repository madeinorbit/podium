# ADR 7 — Plane and message inventory

- **Status:** Proposed (pack sign-off: POD-359; leaf: POD-753)
- **Date:** 2026-07-17
- **Deciders:** architecture rewrite (POD-279); human gate on ADR pack (POD-359)
- **Consumers:** POD-387 (plane-port interfaces), POD-317 (gateway routing + framing)
- **Inventory baseline:** integrated tip `ca361327` (issue/279-integration lineage); **not** the 2026-07-13 plan freeze
- **Defining classification source today:** `packages/protocol/src/messages/message-class.ts` (`SERVER_|CLIENT_|CONTROL_|DAEMON_MESSAGE_CLASS` tables, each `satisfies Record<Union['type'], …>` total over its union)
- **Related ADRs (forward refs only; no shared index in this leaf):**

| ADR | Relationship |
|-----|----------------|
| ADR 1 | Ownership / who may write entity fields that ride control·entity messages |
| ADR 2 | Oplog cursors, bootstrap, gap heal for control·entity; stream vs durable recovery |
| ADR 3 | Command class contracts (offline class, authz, outbox, redaction) |
| ADR 4 | Entity wire aggregates composed from shared field schemas; planes deliver projections, not redefine fields |
| ADR 5 | Peer roles + handshake framing; who may open which endpoints |
| ADR 6 | Replica storage that consumes control·entity recovery |
| ADR 8 | Package placement of gateway/ports; not message classification |

## Context

`docs/rearchitecture-v3.md` move 4: **planes as protocol contracts** — control / stream / bulk classify messages and set port semantics; application code stays vertical by feature. POD-359 item 7 requires every wire message classified, ambiguous cases (agent state, titles) resolved, and POD-387 / POD-317 to implement and verify against this inventory.

Today’s type-system classification uses **four** sync-class labels (`durable | live | command | bulk`) in `message-class.ts`. The rewrite’s port architecture (POD-387 plane-count correction, third-round review item 5) settles on **three planes**, with **command as a message class inside control** — not a fourth plane.

After the 2026-07-13 freeze, drift refreshes on POD-359 added surface that must be inventoried against **current** integrated tree: handoff family, messaging bus/webhook, workflows, browser-open family, `sessionResumeRefAck`, and the twice-re-derived rule that host↔server traffic stays separate from the agent command relay ([spec:SP-b85a], [spec:SP-fccf], [spec:SP-a43e]).

## Decisions

### D1 — Three planes; command is a class inside control

**Decision.** Exactly three planes:

| Plane | Port role | Carries |
|-------|-----------|---------|
| **control** | Durable + directed RPC port | Entity truth (snapshots/deltas/oplog), directed request/reply **command** class, pre-auth **handshake** class |
| **stream** | Live port | Ephemeral / connection-scoped / hot frames; loss on disconnect OK when entity baseline recovers the field, or blank offline |
| **bulk** | Paged port | Large, paged, lazy transfers; never fanned out or oplog-replayed as entity rows |

**Command is not a plane.** It is a **class** on the control port: correlated `requestId` (or equivalent), requires-live-peer unless the command is offline-class under ADR 3, nothing to “catch up” as entity truth.

**Bridge from today’s four `MessageSyncClass` labels** (implementation migration for POD-387):

| Today (`message-class.ts`) | Target plane | Target class |
|----------------------------|--------------|--------------|
| `durable` | control | entity |
| `command` | control | command |
| `live` | stream | live |
| `bulk` | bulk | bulk |

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| Four planes (control / stream / bulk / command) | Explicitly overturned by POD-387 plane-count correction: command is delivery semantics *inside* control’s port contract, not a separate backpressure domain |
| Two planes (control+command vs data) | Collapses bulk paging policy with stream fan-out; offline-sync §5 already needs three recovery behaviors |
| Keep four-label `MessageSyncClass` as the permanent port vocabulary | Labels conflate plane with class; rewrite ports need plane-level contracts (POD-317 gateway routes by plane) |

**Port semantics (binding for POD-387/317):**

| Plane · class | Production / delivery | Offline | Fan-out |
|---------------|----------------------|---------|---------|
| control · entity | Funnel-only for durable ServerMessages (oplog append before fan-out) | Replica: snapshot + `sync.changesSince` | Yes, post-funnel |
| control · command | Correlated request/reply; optional outbox (ADR 3) | Disable UI unless offline-class | Point-to-point / one daemon |
| control · handshake | Once per connection; version + role auth (ADR 5) | N/A | Single peer |
| stream · live | Best-effort; existing 16MB + heartbeat sweeps | Blank or re-seeded on attach | Raw fan-out OK |
| bulk · bulk | Paged offset/limit or cursor; own channel | Lazy on-demand | Point-to-point |

Application code stays **vertical by feature**. Planes are **boundary port contracts** — the gateway routes frames to feature-owned ports and owns no feature logic.

---

### D2 — Host↔server traffic stays SEPARATE from the agent command relay

**Decision.** Two non-overlapping host-edge channels:

1. **Agent command relay** ([spec:SP-b85a]) — daemon injects loopback HTTP `PODIUM_AGENT_RELAY` → `/agent/<sessionId>`; carries the agent CLI/MCP command surface (issues, messages, sessions, specs, workflows, locks, approvals, agent spawn/await, worktree reporting). On the peer wire this is **only** `agentRelayRequest` (daemon→server) and `agentRelayResult` (server→daemon), both control · command.

2. **Host↔server traffic** — daemon- or host-owned side channels that must **not** share the agent-relay HTTP surface or its session-identity inheritance: native harness hooks (instance-scoped `/hooks` / hook socket per [spec:SP-15aa]), browser-open family ([spec:SP-a43e]), resume-ref + `sessionResumeRefAck` ([spec:SP-fccf]), inventory probes, PTY/agent-frame streams, host-initiated file/transcript bulk.

**Rule (binding for new work):** never route a new host callback through `PODIUM_AGENT_RELAY` for convenience. New host features get typed frames (or a dedicated host HTTP path under instance isolation) and a plane classification in this inventory (amend this ADR).

**Rationale.** Independently re-derived in [spec:SP-fccf] (“Hook transport and receipts … remain separate from the agent command relay”) and [spec:SP-a43e] (browser-open is daemon→server→client, not an agent-relay RPC). The relay bakes session identity into the URL path; host callbacks are not “the agent speaking CLI.” Collapsing them re-homes identity, confuses authz, and breaks `PODIUM_NO_RELAY` hermetic tests.

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| Multiplex host hooks over agent relay “to save a port” | Contradicts SP-fccf / SP-a43e; hijacks session identity inheritance |
| Fourth plane “host” | Host traffic still maps to control/stream/bulk; the separation is a **module boundary**, not a plane |
| Treat `agentRelayRequest` as stream | It is directed request/reply with correlated result — command class |

**In-process `EventBus`** (`apps/server/src/modules/bus.ts`) is **not** a wire plane. External chat adapters (Telegram long-poll/webhook, [spec:SP-5d81]) sit on bus + superagent services — **outside** the three peer planes; not tRPC for the external edge.

---

### D3 — Titles: dual delivery, three concepts

**Decision.** Three distinct title concepts; message types map to one plane·class each:

| Concept | Writers | Durable? | Wire classification |
|---------|---------|----------|---------------------|
| OSC / terminal title (`SessionMeta.title`) | Daemon PTY OSC → server debounce | Stabilized non-transient titles persist + oplog | Messages `title`, `sessionTitleChanged` → **stream · live**. Field on entity payloads → control · entity |
| Curated name (`SessionMeta.name` + `nameSource`) | Human `sessions.rename` or agent `sessions.title` / `setAgentName`; `nameSource='user'` sovereign | Yes | **control · entity only** (no dedicated stream message) |
| Issue title (`IssueWire.title`) | Issue writers (ADR 1) | Yes | control · entity via `issuesChanged` / `issueUpdated` / oplog |

**Display rule (product, [spec:SP-eb60]):** curated `name` wins over OSC/derived `title` everywhere shown.

**Rationale.** OSC titles fire at spinner rates (~10 Hz); classifying those message types as entity would force funnel/oplog volume or wrong offline semantics. Curated names are rare authoritative writes — entity-only. Same semantic field may appear on both stream messages and entity aggregates (**dual delivery**); each **message type** still has exactly one plane·class.

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| All title traffic as control · entity | Frame-rate OSC overwhelms funnel; contradicts current `live` classification and offline-sync “spinner-rate title” live row |
| All title traffic as stream only | Curated names must survive reconnect without waiting for another OSC |
| Promote curated renames to a dedicated stream message | Unnecessary; entity snapshot/delta already carries `name` |

---

### D4 — Agent runtime state: dual delivery

**Decision.**

| Concept | Writers | Wire classification |
|---------|---------|---------------------|
| Live phase push | Daemon hooks/classifiers | Messages `agentState`, `sessionAgentStateChanged` → **stream · live** |
| Field on `SessionMeta.agentState` | Same, via session service | **control · entity** when present on `sessionsChanged` / `metadataDelta` session upserts |

**Rationale (matches service comments in `SessionsService` agentState path):** hook events are frequent; full `sessionsChanged` rebroadcast is O(sessions × clients). Dedicated stream message keeps open views hot; entity field supplies reconnect/oplog baseline. Not a command (no directed request/reply). Offline UI treats stream phase as “as-of last event,” not sole offline truth.

**Cold restart note:** if SQL lacks a dedicated `agent_state` column, re-seed from daemon (`seedBootState`) is **stream rehydration**, not a second authority. Target plane classification still treats the SessionMeta field as entity-shaped for replica/oplog. Persistence columnization is ADR 1 / storage work — not a plane flip.

**Rejected alternatives.**

| Alternative | Why rejected |
|-------------|--------------|
| Stream only (drop entity field) | Late joiners and `changesSince` heal lose last-known phase (ledger tests require durable change with `agentState`) |
| Entity only (drop dedicated messages) | Reintroduces full-list fan-out cost the dedicated message was introduced to avoid |
| Classify as control · command | Observation is not request/reply |

---

### D5 — Drafts (related dual-channel)

**Decision.** `setSessionDraft` (client→server) → **control · entity**. `sessionDraftChanged` (server→client) → **stream · live**. Durable recovery via entity path / `SessionMeta.draftUpdatedAt`.

**Rejected:** treating `sessionDraftChanged` as entity-only (keystroke volume); treating `setSessionDraft` as stream (drafts are durable+synced per offline-sync §5).

---

### D6 — Totality inventory (re-derived against integrated tip)

**Predicate:** every `type` key in the four `*_MESSAGE_CLASS` tables in `packages/protocol/src/messages/message-class.ts`, plus pre-auth handshake frames in `daemon-handshake.ts`, plus non-WS control/bulk surfaces called out in drift.

**Counts re-derived at baseline `ca361327` (unions and class tables agree):**

| Union | Types | Today’s class counts |
|-------|------:|----------------------|
| `ServerMessage` | 26 | durable 7, live 19 |
| `ClientMessage` | 15 | command 9, live 3, bulk 2, durable 1 |
| `ControlMessage` | 38 | command 36, bulk 2 |
| `DaemonMessage` | 43 | command 29, live 11, durable 1, bulk 2 |
| **Total post-auth WS types** | **122** | |

Legend: **C/e** control·entity · **C/c** control·command · **C/h** control·handshake · **S** stream·live · **B** bulk.

#### D6.1 Server → client (`ServerMessage`) — 26

| type | plane·class | Notes |
|------|-------------|-------|
| `sessionsChanged` | C/e | Includes title/name/agentState fields |
| `issuesChanged` | C/e | |
| `issueUpdated` | C/e | |
| `conversationsChanged` | C/e | |
| `automationsChanged` | C/e | |
| `automationRunsChanged` | C/e | |
| `metadataDelta` | C/e | Oplog batch; gap → `sync.changesSince` |
| `welcome` | S | Connection-scoped |
| `attached` | S | |
| `pong` | S | |
| `outputFrame` | S | PTY |
| `transcriptDelta` | S | Hot tail |
| `controllerChanged` | S | |
| `geometry` | S | |
| `agentExit` | S | Service also persists status |
| `sessionTitleChanged` | S | **D3** |
| `sessionAgentStateChanged` | S | **D4** |
| `sessionDraftChanged` | S | **D5** |
| `headlessActivity` | S | Animation only |
| `machinesChanged` | S | Advisory; future C/e candidate — not silent reclass |
| `hostMetricsChanged` | S | |
| `attentionEvent` | S | |
| `worktreesChanged` | S | Invalidation; not re-served on attach |
| `approvalsChanged` | S | Pending list; not oplog entity yet |
| `sessionOpenUrl` | S | Browser-open family |
| `sessionOpenUrlResult` | S | |

#### D6.2 Client → server (`ClientMessage`) — 15

| type | plane·class | Notes |
|------|-------------|-------|
| `hello` | C/c | Client caps/version |
| `attach` | C/c | |
| `detach` | C/c | |
| `input` | C/c | |
| `resize` | C/c | |
| `requestControl` | C/c | |
| `redrawRequest` | C/c | |
| `ping` | S | |
| `presence` | S | |
| `viewState` | S | |
| `transcriptSubscribe` | B | |
| `transcriptUnsubscribe` | B | |
| `setSessionDraft` | C/e | **D5** |
| `sessionOpenUrlCallback` | C/c | Browser-open paste-back |
| `sessionOpenUrlDismiss` | C/c | |

#### D6.3 Server → daemon (`ControlMessage`) — 38

| type | plane·class | Notes |
|------|-------------|-------|
| `spawn` `reattach` `kill` `input` `resize` `redraw` `sessionPriority` | C/c | Session lifecycle / PTY control |
| `sessionResumeRefAck` | C/c | **Drift / D2** — host channel, not agent relay |
| `repoOpRequest` `scanRequest` `scanReposRequest` | C/c | |
| `harnessExecRequest` | C/c | |
| `headlessTurnRequest` `headlessInterrupt` `headlessTurnAck` `headlessBind` | C/c | |
| `usageRequest` `agentQuotaRequest` `imageUploadRequest` `memoryBreakdownRequest` `inventoryRequest` | C/c | |
| `fileReadRequest` `fileAssetRequest` `fileWriteRequest` `dirListRequest` | C/c | Structured file RPC (not bulk plane) |
| `approvalExecRequest` | C/c | |
| `agentRelayResult` | C/c | **Agent relay only** |
| `sessionOpenUrlCallback` `sessionOpenUrlDismiss` | C/c | Forwarded to owning daemon |
| `handoffExportRequest` `handoffChunkReadRequest` `handoffImportChunk` `handoffImportRequest` | C/c | Handoff family (**D7**) |
| `workspaceExportRequest` `workspaceImportRequest` `workspaceCleanRequest` | C/c | Lazy workspace fetch; reuses handoff chunk frames for bytes |
| `transcriptRead` `transcriptMirrorRead` | B | |

#### D6.4 Daemon → server (`DaemonMessage`) — 43

| type | plane·class | Notes |
|------|-------------|-------|
| `bind` `agentFrame` `agentFrameBatch` `agentExit` | S | |
| `title` | S | **D3** |
| `agentState` | S | **D4** |
| `agentColor` | S | Rare; may persist + entity broadcast |
| `hostMetrics` `transcriptDelta` | S | |
| `sessionOpenUrl` `sessionOpenUrlResult` | S | Host-originated |
| `spawnError` `reattachFailed` | C/c | |
| `repoOpResult` `scanResult` `scanReposResult` | C/c | |
| `harnessExecResult` | C/c | |
| `headlessTurnEvent` `headlessTurnResult` `headlessBindResult` | C/c | Correlated to turn; server may derive `headlessActivity` |
| `usageResult` `agentQuotaResult` `imageUploadResult` `memoryBreakdownResult` | C/c | |
| `inventoryReport` | C/c | Unsolicited post-auth + request reply |
| `sessionResumeRef` | C/c | Pairs with `sessionResumeRefAck` (**D2**) |
| `sessionCwd` | C/c | May trigger durable session/issue updates in service |
| `fileReadResult` `fileAssetResult` `fileWriteResult` `dirListResult` | C/c | |
| `approvalExecResult` | C/c | |
| `agentRelayRequest` | C/c | **Agent relay only** |
| `handoffExportResult` `handoffChunkReadResult` `handoffImportChunkResult` `handoffImportResult` | C/c | |
| `workspaceExportResult` `workspaceImportResult` `workspaceCleanResult` | C/c | |
| `conversationsChanged` | C/e | Discovery → durable conversation registry |
| `transcriptReadResult` `transcriptMirrorResult` | B | |

#### D6.5 Daemon handshake (pre-auth; outside post-auth unions) — 6

| type | plane·class |
|------|-------------|
| `pair` `paired` `pairRejected` | C/h |
| `hello` `helloOk` `helloRejected` | C/h |

Framing + role-specific auth strategy modules are ADR 5 / POD-317.

#### D6.6 tRPC / HTTP (same gateway owner as WS; not in WS unions)

| Surface | plane·class | Current namespaces / routes (re-derived) |
|---------|-------------|------------------------------------------|
| Entity reads / catch-up | C/e or C/c query | `sync.changesSince`, list/get queries across 28 tRPC namespaces: `cloud`, `sessions`, `sync`, `pins`, `snoozes`, `superagent`, `conversations`, `search`, `settings`, `features`, `telemetry`, `accounts`, `tabs`, `repos`, `usage`, `quota`, `models`, `hosts`, `discovery`, `machines`, `setup`, `auth`, `messages`, `files`, `workflows`, `automations`, `approvals`, `specs` (+ modular `issues` / `lock` registries) |
| Mutations | C/c | Same namespaces’ mutations; offline-class per ADR 3 |
| Bulk over HTTP | B | `sessions.transcriptRead`, large `files.read`, `GET /files/asset`, `GET /files/artifact/...` |
| Auth / ops | C/h or ops | `/auth/*`, `/setup/*`, `/health`, `/version` |
| MCP | C/c | `POST /mcp` |
| Agent relay HTTP | C/c | Daemon loopback `/agent/<sid>` only — **not** browser |

`features.state` is control-plane query (not stream). `MutationEnvelope` / `MutationResult` (`mutations.ts`) are control · command (+ entity side-effects); not yet live as a WS frame type.

#### D6.7 Messaging substrate

| Path | Classification |
|------|----------------|
| Operator/agent mail (`messages.*` tRPC + agent-relay procs) | C/c (delivery ledger is feature storage) |
| External chat (Telegram adapter, [spec:SP-5d81]) | **Outside** three peer planes: bus + webhook/long-poll; **no tRPC** for the external edge |
| In-process `EventBus` | Not a plane; features translate bus → plane sends |

#### D6.8 Workflows

Wire value types: `packages/protocol/src/messages/workflows.ts`. Transport today: **tRPC `workflows.*` only** (no WS `*Changed` family). All procedures → control · command (queries/mutations). When workflow runs become oplog entities, amend tables to C/e — do not invent WS frames in this ADR.

---

### D7 — Handoff family (classification test case)

**Re-derived count:** `packages/protocol/src/messages/handoff.ts` defines **8** `z.literal` message types (four request/result pairs):

1. `handoffExportRequest` / `handoffExportResult`
2. `handoffChunkReadRequest` / `handoffChunkReadResult`
3. `handoffImportChunk` / `handoffImportChunkResult`
4. `handoffImportRequest` / `handoffImportResult`

**Decision.** All eight → **control · command**. Chunk frames use **bulk transfer mechanics** (offset/length, multi-MB caps, no oplog fan-out of chunk bytes) but remain command-class: directed, correlated RPCs in an export/import state machine — not a standing bulk subscription.

Workspace export/import/clean (6 more types in `workspace.ts`) follow the same rule; byte transfer reuses handoff chunk frames under `fetchId`.

**Note on drift wording:** POD-359 drift said “7 frames”; the defining source has **8** typed messages. Inventory uses the code.

**Rejected:** classifying chunk frames as bulk plane (would split one state machine across two ports and lose requestId correlation as the primary contract).

---

### D8 — Browser-open family ([spec:SP-a43e])

| type | direction | plane·class |
|------|-----------|-------------|
| `sessionOpenUrl` | daemon→server→client | S |
| `sessionOpenUrlResult` | daemon/server→client | S |
| `sessionOpenUrlCallback` | client→server→daemon | C/c |
| `sessionOpenUrlDismiss` | client→server→daemon | C/c |

Host traffic (**D2**); intent (login vs link) does not change plane.

Matches current `message-class.ts`: open/result `live`; callback/dismiss `command`.

---

## Drift-refresh clauses (each addressed)

| Source | Clause | Disposition |
|--------|--------|-------------|
| POD-359 DRIFT REFRESH (1)(3) | Handoff family; control-plane command-class with chunked bulk reads | **D7** — 8 types, all C/c with bulk mechanics on chunks |
| same | Messaging bus/webhook only, no tRPC | **D6.7** — external edge outside peer planes; agent mail remains tRPC/relay C/c |
| same | Workflows | **D6.8** — tRPC control; no WS family on current tree |
| same | Inventory against current main, not 07-13 | Baseline `ca361327`; counts re-derived from `message-class.ts` + unions (122) |
| POD-359 DRIFT REFRESH 2 (2) | Browser-open family | **D8** + tables |
| same | `sessionResumeRefAck` command-plane | **D6.3** C/c; pairs with `sessionResumeRef` |
| same | Host↔server SEPARATE from agent command relay (SP-b85a, SP-fccf, SP-a43e) | **D2** named port rule |
| POD-359 other drift | drizzle-kit, instance identity, build orchestration | **Not ADR 7** — ADR 2/6/1/8 |

---

## Consequences

**Positive**

- POD-387 implements three ports; command class modeled on control with distinct delivery semantics.
- POD-317 routes by this inventory; deviations require ADR amendment.
- Dual-channel titles/agentState stop being re-litigated at implementation time.
- Host side-channels cannot silently piggyback on agent relay.

**Costs**

- Four-value `MessageSyncClass` migrates to plane·class vocabulary (one migration window aliases OK).
- Handoff chunks as C/c with bulk *mechanics* is subtle — bulk plane remains for standing paged channels (transcripts).
- `machinesChanged` / `approvalsChanged` stay stream until explicit entity promotion (amend this ADR).

**Follow-ups (not this leaf)**

- Entity promotion of machines/approvals → amend D6 tables.
- Workflow WS push if product adds it → amend before implement.
- POD-359 owns ADR index + human gate; this leaf does not touch index or ledger.

## What POD-387 and POD-317 must ship

**POD-387**

1. Three plane ports; command class on control (correlated requestId, requires-live-peer).
2. Compile-time totality: every WS union type maps to exactly one plane·class per D6 (successor to `satisfies Record<…>` tables).
3. Dual-channel resolutions D3–D5 as written.
4. Host≠agent-relay as module boundary (agent-relay handler must not import host-hook handlers or vice versa).
5. Migrate message-class vocabulary to plane·class.

**POD-317**

1. Route every wire message per D6; no local reclassification.
2. Extract transport edge; feature logic stays in features.
3. Common framing + role-specific auth (ADR 5); handshake = C/h.
4. Per-plane backpressure/heartbeat per D1 table.

## Appendix — Agent relay vs host channels

```
Agent process
  └─ HTTP loopback PODIUM_AGENT_RELAY /agent/<sid>
        └─ daemon ──agentRelayRequest──► server command registry
              ▲                              │
              └──── agentRelayResult ────────┘
                     control·command ONLY for CLI/MCP-equivalent procs

Host / harness (SEPARATE — D2)
  ├─ hooks HTTP/socket ──► daemon ──agentState/title/sessionResumeRef──► server
  ├─ browser open ──sessionOpenUrl──► server ──► clients (stream)
  │                 ◄──callback/dismiss── (control·command)
  └─ PTY ──agentFrame*──► server ──outputFrame──► clients (stream)
```

## Self-verify record (docs leaf)

| Claim | Defining predicate / source | Result |
|-------|----------------------------|--------|
| 122 post-auth WS types | Sum of keys in four `*_MESSAGE_CLASS` tables | 26+15+38+43 = **122**; matches discriminatedUnion entry counts |
| Handoff typed messages | `z.literal` in `handoff.ts` | **8** (not “7” from drift prose) |
| Browser-open types | `browser-open.ts` literals | 4: open, callback, dismiss, result |
| Handshake types | `daemon-handshake.ts` literals | 6 |
| tRPC namespaces in `router.ts` | `^\s{2}(\w+):\s*t\.router\(` | **28** listed in D6.6 |
| Agent relay separation | SP-b85a body; SP-fccf “remain separate from the agent command relay”; SP-a43e daemon→server→client path | **D2** |
| sessionOpenUrl live / callback command | `SERVER_MESSAGE_CLASS` / `CLIENT_MESSAGE_CLASS` | open/result live; callback/dismiss command |
| sessionResumeRefAck command | `CONTROL_MESSAGE_CLASS.sessionResumeRefAck` | `'command'` |
| Dual title/agentState live messages | `SERVER_MESSAGE_CLASS` + `DAEMON_MESSAGE_CLASS` | `sessionTitleChanged`/`title` live; `sessionAgentStateChanged`/`agentState` live |
| WIRE_VERSION | `packages/protocol/src/version.ts` | **1** (informational; not a plane) |

No other ADR file, index, or ledger modified by this leaf.
