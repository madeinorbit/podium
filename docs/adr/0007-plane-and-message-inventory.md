# ADR 7: Plane and message inventory

- **Status:** Proposed
- **Date:** 2026-07-17
- **Issue:** [POD-753](podium://issue/753) (parent pack [POD-359](podium://issue/359) item 7)
- **Implements / verifies:** [POD-387](podium://issue/387) (plane-port interfaces), [POD-317](podium://issue/317) (gateway routing)
- **Baseline:** current `main` at inventory time (`c577009d`); **not** the 2026-07-13 plan freeze. Drift comments on POD-359 / POD-387 are absorbed below.
- **Related ADRs:** ADR 1 (authority), ADR 2 (sync protocol), ADR 3 (command security/lifecycle), ADR 4 (representation), ADR 5 (peer topology), ADR 8 (package topology)
- **Specs:** [SP-b85a](podium://spec/SP-b85a) agent command relay, [SP-fccf](podium://spec/SP-fccf) Codex session identity, [SP-a43e](podium://spec/SP-a43e) remote browser-open, [SP-3f7a](podium://spec/SP-3f7a) session handoff, [SP-34d7](podium://spec/SP-34d7) messaging substrate, [SP-5d81](podium://spec/SP-5d81) messaging-app bridge, [SP-eb60](podium://spec/SP-eb60) titles

## Context

Today's wire surface is classified in `packages/protocol/src/messages/message-class.ts` under four **sync classes**: `durable | live | command | bulk`. That taxonomy correctly encodes recovery and fan-out rules, but the rewrite's port architecture (ledger §1 move 4; POD-387 plane-count correction) settles on **three planes**:

| Plane | Role |
|---|---|
| **control** | Durable entity truth + directed request/reply |
| **stream** | Live, connection-scoped or ephemeral frames |
| **bulk** | Large, paged, lazy transfers on their own channel |

**Command is not a fourth plane.** It is a message **class** carried *inside* the control plane's port contract (correlated `requestId`, requires-live-peer semantics). POD-387 may not start until this settlement is written here; a deviation requires an ADR amendment, not local judgment at implementation time.

Ambiguous dual-channel fields — **agent runtime state** and **titles/names** — must be resolved explicitly so every **wire message type** maps to exactly one plane + class. New host↔server traffic landed after the plan freeze (hooks, browser-open, resume-ref ack) must be classified without collapsing into the agent CLI command relay.

## Decision

### 1. Three planes, command-as-class

```
┌──────────────────────────────────────────────────────────────────┐
│  CONTROL plane (durable port)                                    │
│  ├── entity class     — snapshots, deltas, oplog-backed truth    │
│  ├── command class    — directed request/reply (requestId,       │
│  │                      live-peer required unless offline-queued)│
│  └── handshake class  — pre-auth peer framing (pair/hello)       │
├──────────────────────────────────────────────────────────────────┤
│  STREAM plane (live port)                                        │
│  └── live class       — ephemeral / hot / re-seeded-on-attach    │
│                         (loss on disconnect OK when entity        │
│                          baseline recovers it, or blank offline)  │
├──────────────────────────────────────────────────────────────────┤
│  BULK plane (paged port)                                         │
│  └── bulk class       — large paged reads/writes, not fan-out    │
└──────────────────────────────────────────────────────────────────┘
```

**Mapping from today's `MessageSyncClass` (implementation bridge for POD-387):**

| Today's class | Target plane | Target class |
|---|---|---|
| `durable` | control | entity |
| `command` | control | command |
| `live` | stream | live |
| `bulk` | bulk | bulk |

Handshake frames (daemon `pair`/`hello` and replies) are control/handshake — they are outside the post-auth `ControlMessage`/`DaemonMessage` unions today and stay framing, not entity truth.

**Port semantics (what POD-387 implements):**

| Plane | Backpressure / delivery | Offline | Fan-out |
|---|---|---|---|
| control / entity | Oplog-ordered; funnel-only production of durable ServerMessages | Replica recovers via snapshot + `changesSince` | Yes, after funnel append |
| control / command | Correlated request/reply; optional outbox for offline-queued commands (ADR 3) | UI disables unless command is offline-class | Point-to-point (or server-mediated to one daemon) |
| control / handshake | Once per connection; version + auth | N/A (no session yet) | Single peer |
| stream | Best-effort; today's 16MB cap + heartbeat sweeps | Blank or re-seeded on attach | Raw fan-out OK |
| bulk | Paged (offset/limit or cursor); never oplog-replayed as entity rows | Lazy on-demand | Point-to-point |

Application code stays **vertical by feature**. Planes are **protocol/port contracts at the boundary** — the gateway (POD-317) routes frames to feature-owned ports and owns no feature logic.

### 2. Principle: host↔server traffic stays SEPARATE from the agent command relay

This principle has been independently re-derived twice and is now a named port rule:

1. **[SP-b85a](podium://spec/SP-b85a)** — `PODIUM_AGENT_RELAY` is the **agent session command channel** (issues, messages, sessions, specs, workflows, locks, approvals, agent spawn/await, worktree reporting). Path shape `/agent/<sessionId>` on a **loopback** HTTP endpoint the daemon injects into spawned agents.
2. **[SP-fccf](podium://spec/SP-fccf)** — Codex hook transport and resume-ref receipts use the **instance runtime namespace** and **remain separate** from the agent command relay.
3. **[SP-a43e](podium://spec/SP-a43e)** — Browser-open forwarding is daemon→server→client host traffic, not an agent-relay RPC.

**Rule (binding for new work):**

- **Agent command relay** = agent process → loopback HTTP → daemon → `agentRelayRequest` / `agentRelayResult` (control/command) → server command registry (tRPC-equivalent procs). Identity is the **Podium session** baked into the URL path.
- **Host↔server traffic** = daemon- or host-owned side channels that must **not** share the agent-relay HTTP surface or its session-identity inheritance: native harness hooks (`/hooks`, Codex hook socket), browser-open family, resume-ref + `sessionResumeRefAck`, inventory probes, PTY/agent-frame streams, file/transcript bulk paths initiated by the host stack.
- **Never** route a new host callback through `PODIUM_AGENT_RELAY` "because it is convenient." New host features get their own typed frames (or a dedicated host HTTP path under instance isolation [SP-15aa](podium://spec/SP-15aa)), classified on the three planes below.
- **In-process `EventBus`** (`apps/server/src/modules/bus.ts`) is **not** a wire plane. It is server-local notification glue. External chat (Telegram/webhook) is an **edge adapter** on top of the bus + superagent services — not tRPC, not a fourth peer plane.

### 3. Ambiguous cases resolved

#### 3.1 Titles (three distinct concepts)

| Concept | Authority / writer | Durable? | Wire |
|---|---|---|---|
| **OSC / terminal title** (`SessionMeta.title`) | Daemon observes PTY OSC; server debounces | Stabilized non-transient titles **persist** into session row + oplog | Stream push: `title` (daemon→server), `sessionTitleChanged` (server→client). Entity baseline: field on `sessionsChanged` / `metadataDelta` |
| **Curated name** (`SessionMeta.name` + `nameSource`) | Human via `sessions.rename` **or** agent via `sessions.title` / `setAgentName` (nameSource=`user` is sovereign — agents may never overwrite) | **Yes** — control entity field only | No dedicated stream message; rides `sessionsChanged` / oplog after rename |
| **Issue title** (`IssueWire.title`) | Issue writers per ADR 1 | **Yes** | `issuesChanged` / `issueUpdated` / oplog entity `issue` |

**Classification rule:**

- Message types `title` and `sessionTitleChanged` → **stream / live** (frame-rate OSC; debounced; loss OK because durable `title` is on the next entity snapshot).
- Fields `name`, `nameSource`, stabilized `title` on entity payloads → **control / entity**.
- Display rule (unchanged product behavior): curated `name` wins over derived/OSC `title` everywhere shown ([SP-eb60](podium://spec/SP-eb60)).

#### 3.2 Agent runtime state

| Concept | Writer | Durable? | Wire |
|---|---|---|---|
| **Live phase stream** (`AgentRuntimeState`) | Daemon harness hooks / classifiers | Push is ephemeral; **last-known** is stamped onto in-memory `SessionMeta` and emitted on oplog upserts while the server is up | Stream: `agentState` (daemon→server), `sessionAgentStateChanged` (server→client) |
| **Field on `SessionMeta.agentState`** | Same, via session service | Target: **control entity field** for replica recovery. Cold SQL restart today may lack a dedicated column and re-seeds from the daemon (`seedBootState`) — that re-seed is stream rehydration, not a second authority | Entity: included in `sessionsChanged` / `metadataDelta` session upserts |

**Classification rule:**

- Message types `agentState` and `sessionAgentStateChanged` → **stream / live** (dedicated path so hook-rate updates are not O(sessions×clients) full list rebroadcasts).
- Field `agentState` on session entity payloads → **control / entity** (same semantic field, dual delivery).
- **Not** a command: observing state is not a directed request/reply.
- On reconnect: client applies entity snapshot first; stream catches up for open views. Offline replica trusts last oplog value; live phase may be stale until stream resumes — UI must treat stream phase as "as-of last event," not sole truth for offline decisions.

#### 3.3 Drafts (related dual-channel)

- Client write `setSessionDraft` → **control / entity** (durable draft entity per offline-sync).
- Server push `sessionDraftChanged` → **stream / live** (hot open-view typing); durable recovery via entity path / `draftUpdatedAt` on `SessionMeta`.

### 4. Totality inventory (current main)

Every post-auth WS message type in `@podium/protocol` is listed. Plane+class is **binding** for POD-387/POD-317. Source of schemas: `packages/protocol/src/messages/*`.

Legend: **C/e** control·entity · **C/c** control·command · **C/h** control·handshake · **S** stream·live · **B** bulk.

#### 4.1 Server → client (`ServerMessage`)

| type | plane/class | Notes |
|---|---|---|
| `sessionsChanged` | C/e | Full session list snapshot; includes title/name/agentState fields |
| `issuesChanged` | C/e | |
| `issueUpdated` | C/e | Single-issue fast path |
| `conversationsChanged` | C/e | |
| `automationsChanged` | C/e | |
| `automationRunsChanged` | C/e | |
| `metadataDelta` | C/e | Oplog batch (`caps: ['metadataDelta']`); gap → heal via `sync.changesSince` |
| `welcome` | S | Connection-scoped handshake response body (version/caps) |
| `attached` | S | Attach ack for a session view |
| `pong` | S | |
| `outputFrame` | S | PTY bytes |
| `transcriptDelta` | S | Hot transcript tail |
| `controllerChanged` | S | |
| `geometry` | S | |
| `agentExit` | S | Also triggers durable session status update via service |
| `sessionTitleChanged` | S | **Resolved §3.1** — OSC push only |
| `sessionAgentStateChanged` | S | **Resolved §3.2** — live phase push |
| `sessionDraftChanged` | S | Hot draft; durable write is client `setSessionDraft` |
| `headlessActivity` | S | Mid-turn animation only |
| `machinesChanged` | S | Advisory; candidate future C/e entity (not reclassified silently) |
| `hostMetricsChanged` | S | |
| `attentionEvent` | S | |
| `worktreesChanged` | S | One-shot invalidation; not re-served on attach |
| `approvalsChanged` | S | Pending list; re-broadcast on change/attach; not oplog entity yet |
| `sessionOpenUrl` | S | **Browser-open family** [SP-a43e]; live affordance |
| `sessionOpenUrlResult` | S | Terminal status for open request |

#### 4.2 Client → server (`ClientMessage`)

| type | plane/class | Notes |
|---|---|---|
| `hello` | C/c | Client capability/version hello (post-cookie); correlated with `welcome` |
| `attach` | C/c | Requires live daemon path for PTY |
| `detach` | C/c | |
| `input` | C/c | |
| `resize` | C/c | |
| `requestControl` | C/c | |
| `redrawRequest` | C/c | |
| `ping` | S | |
| `presence` | S | |
| `viewState` | S | |
| `transcriptSubscribe` | B | Opens bulk transcript channel for a session |
| `transcriptUnsubscribe` | B | |
| `setSessionDraft` | C/e | Durable draft write |
| `sessionOpenUrlCallback` | C/c | Paste-back to owning daemon [SP-a43e] |
| `sessionOpenUrlDismiss` | C/c | Revoke open request |

#### 4.3 Server → daemon (`ControlMessage`)

| type | plane/class | Notes |
|---|---|---|
| `spawn` | C/c | |
| `reattach` | C/c | |
| `kill` | C/c | |
| `input` | C/c | |
| `resize` | C/c | |
| `redraw` | C/c | |
| `sessionPriority` | C/c | |
| `sessionResumeRefAck` | C/c | **Drift** [SP-fccf] — server ack so daemon may drop retained hook evidence; **host channel, not agent relay** |
| `repoOpRequest` | C/c | |
| `scanRequest` | C/c | |
| `scanReposRequest` | C/c | |
| `harnessExecRequest` | C/c | |
| `headlessTurnRequest` | C/c | |
| `headlessInterrupt` | C/c | |
| `headlessTurnAck` | C/c | |
| `headlessBind` | C/c | |
| `usageRequest` | C/c | |
| `agentQuotaRequest` | C/c | |
| `imageUploadRequest` | C/c | |
| `memoryBreakdownRequest` | C/c | |
| `inventoryRequest` | C/c | |
| `fileReadRequest` | C/c | Small structured file RPC (not bulk plane) |
| `fileAssetRequest` | C/c | |
| `fileWriteRequest` | C/c | |
| `dirListRequest` | C/c | |
| `approvalExecRequest` | C/c | |
| `agentRelayResult` | C/c | Reply half of **agent command relay** only |
| `sessionOpenUrlCallback` | C/c | Forwarded paste-back |
| `sessionOpenUrlDismiss` | C/c | |
| `handoffExportRequest` | C/c | **Handoff family** [SP-3f7a] |
| `handoffChunkReadRequest` | C/c | Chunked bulk **pattern** (offset/length caps); still control/command orchestration — payload is bulk-sized but correlated RPC |
| `handoffImportChunk` | C/c | |
| `handoffImportRequest` | C/c | |
| `workspaceExportRequest` | C/c | Lazy workspace fetch; reuses handoff chunk frames for bytes |
| `workspaceImportRequest` | C/c | |
| `workspaceCleanRequest` | C/c | |
| `transcriptRead` | B | Paged transcript lake/daemon read |
| `transcriptMirrorRead` | B | |

#### 4.4 Daemon → server (`DaemonMessage`)

| type | plane/class | Notes |
|---|---|---|
| `bind` | S | Daemon bind/announce after auth |
| `agentFrame` | S | PTY stream |
| `agentFrameBatch` | S | |
| `agentExit` | S | |
| `title` | S | **§3.1** |
| `agentState` | S | **§3.2** |
| `agentColor` | S | Rare; service may persist + entity-broadcast |
| `hostMetrics` | S | |
| `transcriptDelta` | S | |
| `sessionOpenUrl` | S | Host-originated open intent |
| `sessionOpenUrlResult` | S | |
| `spawnError` | C/c | |
| `reattachFailed` | C/c | |
| `repoOpResult` | C/c | |
| `scanResult` | C/c | |
| `scanReposResult` | C/c | |
| `harnessExecResult` | C/c | |
| `headlessTurnEvent` | C/c | Progress correlated to turn request (not stream fan-out to all clients; server may derive `headlessActivity`) |
| `headlessTurnResult` | C/c | |
| `headlessBindResult` | C/c | |
| `usageResult` | C/c | |
| `agentQuotaResult` | C/c | |
| `imageUploadResult` | C/c | |
| `memoryBreakdownResult` | C/c | |
| `inventoryReport` | C/c | Unsolicited post-auth + reply to request |
| `sessionResumeRef` | C/c | Host identity binding [SP-fccf]; pairs with `sessionResumeRefAck` |
| `sessionCwd` | C/c | Declared/observed cwd; may trigger durable session/issue field updates in service |
| `fileReadResult` | C/c | |
| `fileAssetResult` | C/c | |
| `fileWriteResult` | C/c | |
| `dirListResult` | C/c | |
| `approvalExecResult` | C/c | |
| `agentRelayRequest` | C/c | **Agent command relay** request half only |
| `handoffExportResult` | C/c | |
| `handoffChunkReadResult` | C/c | Chunk payload (bulk-sized) under command correlation |
| `handoffImportChunkResult` | C/c | |
| `handoffImportResult` | C/c | |
| `workspaceExportResult` | C/c | |
| `workspaceImportResult` | C/c | |
| `workspaceCleanResult` | C/c | |
| `conversationsChanged` | C/e | Daemon discovery push into durable conversation registry |
| `transcriptReadResult` | B | |
| `transcriptMirrorResult` | B | |

#### 4.5 Daemon handshake (pre-auth; not in post-auth unions)

| type | plane/class | Notes |
|---|---|---|
| `pair` / `paired` / `pairRejected` | C/h | Pairing code exchange |
| `hello` / `helloOk` / `helloRejected` | C/h | Token auth + machine identity |

Common peer framing + role-specific auth strategy modules are ADR 5 / POD-317; this ADR only classifies the frames.

#### 4.6 Handoff family (classification test case)

Eight typed messages (four correlated request/result pairs):

1. `handoffExportRequest` / `handoffExportResult`
2. `handoffChunkReadRequest` / `handoffChunkReadResult`
3. `handoffImportChunk` / `handoffImportChunkResult`
4. `handoffImportRequest` / `handoffImportResult`

**All plane = control, class = command.** Chunk frames use **bulk transfer mechanics** (offset/length, multi-MB caps, no oplog fan-out of chunk bytes) but remain command-class because they are directed, correlated RPCs in an export/import state machine — not a standing bulk subscription. Workspace fetch reuses the chunk pair under `fetchId` and is the same rule.

*(Plan drift text said "7 frames"; main has **8** typed messages in the family — inventory uses the code.)*

#### 4.7 Browser-open family [SP-a43e]

| type | direction | plane/class |
|---|---|---|
| `sessionOpenUrl` | daemon→server→client | S |
| `sessionOpenUrlResult` | daemon/server→client | S |
| `sessionOpenUrlCallback` | client→server→daemon | C/c |
| `sessionOpenUrlDismiss` | client→server→daemon | C/c |

Host traffic; **not** agent relay. Intent classification (login vs link) is adapter-owned; plane classification does not depend on intent.

#### 4.8 tRPC / HTTP control surface (not WS unions)

tRPC is the **browser/operator control API** on the same gateway auth/peer-identity owner as WS (POD-317: "gateway" = WS + HTTP under one owner). Classification:

| Surface | plane/class | Examples (namespaces on current main) |
|---|---|---|
| Entity reads / catches | C/e or C/c query | `sync.changesSince`, `sessions.list`, `issues.*` reads, `features.state`, `settings.get`, `workflows.list/get/status/prime`, `pins/snoozes/tabs` list |
| Mutations (live-peer or offline-queued) | C/c | `sessions.create/kill/rename/…`, `issues.*` writes, `workflows.*` mutations, `messages.send/reply/spawnAgent`, `lock.*`, `files.write`, `approvals.*`, `automations.*` |
| Bulk reads over HTTP | B | `sessions.transcriptRead`, `files.read` (large), `GET /files/asset`, `GET /files/artifact/...` |
| Auth / setup / health | C/h or ops | `/auth/*`, `/setup/*`, `/health`, `/version` |
| MCP | C/c (tool surface) | `POST /mcp` — derived from command registry where applicable |
| Agent relay HTTP | C/c | Daemon loopback `/agent/<sid>` only — **not** a browser route |

**Workflows:** wire value types live in `packages/protocol/src/messages/workflows.ts`; transport is **tRPC only** today (no WS `*Changed` family yet). Mutations/queries are control/command (and control entity once a durable workflow entity enters the oplog — future; do not invent WS frames here).

**Messaging (agent mail + external bridge):**

- Operator/agent mail: tRPC `messages.*` + agent-relay procs → **C/c** (durable delivery ledger is feature storage; not a stream plane).
- External chat (Telegram): **bus + webhook/long-poll adapter** ([SP-5d81](podium://spec/SP-5d81)) — **outside** the three peer planes; no tRPC. Inbound becomes superagent turns; outbound rides `superagent.turnEnded` bus events.

**Mutation envelope** (`MutationEnvelope` / `MutationResult` in `mutations.ts`): control/command (and control/entity side-effects via oplog). Not yet on the live wire as a frame type; reserved for the sync kernel (ADR 2/3).

#### 4.9 In-process bus (not a plane)

`EventMap` keys (`session.stateChanged`, `issue.updated`, `oplog.appended`, `superagent.turnEnded`, …) are **server-local**. Gateway and plane ports must not treat bus events as wire messages. Features translate bus → plane sends explicitly (e.g. state change → `sessionAgentStateChanged` stream frame).

#### 4.10 Field-level notes on entity payloads

Entity messages carry whole wire aggregates (`SessionMeta`, `IssueWire`, …). Field groups do not get their own plane; **delivery** of a field may use stream **and** entity (titles, agentState, drafts — §3). Authority, conflict, and secret classification for fields are ADR 1, not this ADR.

Notable `SessionMeta` dual-delivery fields: `title`, `name`/`nameSource`, `agentState`, `draftUpdatedAt`, `snoozedUntil`, `busy`, `geometry` (geometry also has stream `geometry` message), `status`/`exitCode` (also implied by `agentExit`).

### 5. What POD-387 and POD-317 must do

**POD-387 — plane-port interfaces**

1. Implement **three** ports (control, stream, bulk); model **command** as a class on the control port (correlated requestId, requires-live-peer).
2. Compile-time totality: every message type in the four WS unions maps to exactly one plane+class per §4; adding a type without a mapping is a type error (successor to today's `satisfies Record<Union['type'], …>` tables).
3. Ship the dual-channel resolutions for titles and agent state as documented — no "pick one" local judgment.
4. Encode the **host≠agent-relay** rule as a port/module boundary comment and lint seam where practical (agent-relay handler module must not import host-hook handlers or vice versa).
5. Update message-class tables (or their successors) to the three-plane vocabulary; keep a deprecated alias map only for one migration window if needed.

**POD-317 — gateway**

1. Route every wire message by this inventory; deviations require ADR amendment.
2. Extract transport edge from `wsServer.ts` / session socket mux; feature logic stays in features.
3. Common framing + role-specific auth (client cookie, daemon token/pair; node-peer reserved).
4. Per-plane backpressure/heartbeat as in §1 table.

### 6. Out of scope / non-goals

- Ownership, conflict, tombstones → ADR 1.
- Oplog cursor, bootstrap, gap healing details → ADR 2.
- Command authz, outbox states, redaction → ADR 3.
- Canonical vs projection schemas → ADR 4.
- Peer roles and capability negotiation mechanism → ADR 5.
- Package file layout of gateway ports → ADR 8 (this ADR only names plane contracts).
- Inventing new WS push families for workflows/messaging that do not exist on main.

## Consequences

**Positive**

- POD-387/317 have a single, current-main inventory with no fourth plane.
- Dual-channel fields are explicit, so implementers stop re-litigating "is agent state durable or live?"
- Host side-channels cannot silently piggyback on agent relay (twice-re-derived rule is now written).
- Handoff/browser-open/resume-ack/workflows/messaging drift is classified, not left as "unknown new messages."

**Negative / costs**

- Today's four-value `MessageSyncClass` must migrate; dual vocabulary during the rewrite needs care.
- Chunked handoff bytes classified as control/command (with bulk *mechanics*) is subtle — bulk plane stays for standing paged channels (transcripts), not every large buffer.
- `machinesChanged` / `approvalsChanged` remain stream until an explicit entity promotion (called out, not silent).

**Follow-ups**

- When machines or approvals become oplog entities, amend this ADR's tables (C/e) and POD-387 ports.
- If workflow runs gain WS push, add types here before implementing.
- Cold-restart persistence of `agentState` as a SQL column (if desired) is a storage/ADR-1 concern; plane classification already treats the SessionMeta field as entity-shaped.

## Appendix A — Drift absorption checklist (POD-359 comments)

| Drift item | Where handled |
|---|---|
| Handoff family | §4.6 |
| Messaging bus/webhook (no tRPC for external chat) | §2, §4.8–4.9 |
| Workflows | §4.8 |
| Browser-open family | §4.1–4.4, §4.7 |
| `sessionResumeRefAck` | §4.3 |
| Host traffic ≠ agent relay (SP-b85a, SP-fccf, SP-a43e) | §2 |
| Inventory vs 07-13 snapshot | Entire §4 against current main |

## Appendix B — Quick reference: agent relay vs host channels

```
Agent process
  └─ HTTP loopback PODIUM_AGENT_RELAY /agent/<sid>
        └─ daemon ──agentRelayRequest──► server command registry
              ▲                              │
              └──── agentRelayResult ────────┘
                     (control/command ONLY for CLI/MCP-equivalent procs)

Host / harness (SEPARATE)
  ├─ hooks HTTP/socket ──► daemon state ──agentState/title/sessionResumeRef──► server
  ├─ browser open ──sessionOpenUrl──► server ──► clients (stream)
  │                 ◄──callback/dismiss── (control/command)
  └─ PTY ──agentFrame*──► server ──outputFrame──► clients (stream)
```
