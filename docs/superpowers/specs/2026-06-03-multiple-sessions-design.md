# Multiple Sessions (resume + spawn-new) — Design

- **Date:** 2026-06-03
- **Status:** Approved (design) → ready for implementation plan
- **Scope:** Lift the handover+input prototype's *one session / one daemon / one controller*
  limit to **many concurrent sessions hosted by one daemon**, attachable and switchable from
  the web. A session is either **freshly spawned** (claude/codex in a chosen cwd) or a
  **resumed on-disk conversation** surfaced by the already-merged discovery subsystem. Full
  vertical slice: protocol + server + daemon + terminal-client + a functional web switcher.

---

## 1. Goal

The live prototype proves a *single* agent session driven across desktop and mobile. The
product is a **command center**: see your projects/worktrees and recent agent conversations,
start new ones or resume existing ones, and drive any of them from web or phone. This
increment is the first real step from prototype → product: **N concurrent sessions**, each
keeping the handover + input behavior already proven, with a switcher UI and discovery-backed
resume.

It deliberately stays **single-daemon** (one machine). Every wire message is **session-routed**
so a `daemonId` namespace and multi-machine fan-out can be added later without protocol churn.

---

## 2. Decisions (the forks that shaped this design)

| Fork | Decision | Why |
|------|----------|-----|
| What is a session | **Resume discovered *and* spawn new** | The full command-center vision; discovery (already merged) exists precisely to make resume real. |
| Web scope | **Full vertical slice** — functional switcher in `apps/web` | End-to-end demoable; matches how the prototype was built. Not the *polished* command center. |
| Transport | **One multiplexed ws**, every hot-path message `sessionId`-tagged | Command-center-ready (many live sessions, one connection, clean live list). Rejected: one-ws-per-session — more sockets, no unified push, doesn't match the grid vision. |
| Control vs data plane | **tRPC** for list/create/resume/kill/scan; **ws** for attach/input/frames | Request/response with typed errors for the control plane; the low-latency stream stays on ws. Web already imports the `AppRouter` *type* only. |
| Session id ownership | **Server-assigned** | The server owns the registry and lifecycle; the daemon spawns what it's told. (Inverts today's daemon-coins-id-in-`bind`.) |
| Daemon cardinality | **One daemon hosting N bridges** now | Minimal real step; `sessionId` routing leaves room for `daemonId` later. |
| Session lifecycle | **Persist on detach**; run until explicit `kill` or self-exit | Remote control's whole point: start on desktop, reattach on phone. |

---

## 3. Architecture & process topology

```
 apps/daemon (Node)                  apps/server (Node, Hono)               apps/web (Vite + React)
 ┌───────────────────────┐   WS      ┌──────────────────────────┐  WS       ┌─────────────────────────┐
 │ Map<sessionId, bridge> │◄────────►│ SessionRegistry           │◄────────►│ SocketHub (1 ws)        │
 │  @podium/agent-bridge  │ protocol │  Map<sessionId, Session>  │ protocol │  + N SessionConnections │
 │  spawn/kill/scan        │ (routed │  per-session controller   │ (routed  │  attach(sessionId)      │
 │  agentLaunchCommand()   │  by      │  tRPC: list/create/resume │  by      ├─────────────────────────┤
 │  scanAgentConversations │  session)│        /kill/scan          │ session)│  switcher UI (tRPC) +    │
 └───────────────────────┘          └──────────────────────────┘           │  fullscreen terminal     │
                                                                             └─────────────────────────┘
```

- **Server** grows a `SessionRegistry` = `Map<sessionId, Session>`, where each `Session` is
  today's per-agent relay state (controllerId, geometry, epoch, attached clients). One daemon
  connection still; it now carries N bridges' traffic, demultiplexed by `sessionId`.
- **Daemon** grows a `Map<sessionId, AgentSession>`; spawns on server command, tags all
  frames/exits with `sessionId`, routes control to the right bridge, answers discovery scans.
- **Web** grows a switcher shell around the existing fullscreen terminal.

The substance stays in the three publishable packages; the apps stay thin.

---

## 4. Protocol (`@podium/protocol`)

The core change is **session-routing every hot-path message** and adding attach/spawn verbs.
All messages remain inspectable JSON validated by a zod discriminated union on `type`.

### 4.1 Shared types

```ts
SessionMeta = {
  sessionId: string
  agentKind: 'claude-code' | 'codex'
  title: string
  cwd: string
  status: 'starting' | 'live' | 'exited'
  exitCode?: number
  controllerId: string | null
  geometry: Geometry
  epoch: number
  clientCount: number
  createdAt: string            // ISO
  origin: { kind: 'spawn' } | { kind: 'resume', conversationId: string }
}

ResumeRef = { kind: string, value: string }   // mirrors AgentConversationResumeRef

ConversationSummaryWire = {    // discovery payload over the wire (dates → ISO strings)
  id, agentKind, title?, projectPath?, parentConversationId?, statusHint?,
  createdAt?, updatedAt?, messageCount?, git?, resume?: ResumeRef, providerId
}
```

### 4.2 Browser client → server (ws)

| `type` | fields | notes |
|--------|--------|-------|
| `hello` | `clientId`, `viewport:{cols,rows,dpr}` | once per connection (not per session) |
| `attach` | `sessionId` | subscribe this client to a session |
| `detach` | `sessionId` | unsubscribe |
| `input` | `sessionId`, `data` (base64) | honored only from that session's controller |
| `resize` | `sessionId`, `cols`, `rows` | controller authoritative; spectator stored-but-advisory |
| `requestControl` | `sessionId` | take control of that session (uses last-reported viewport) |
| `redrawRequest` | `sessionId` | fresh repaint of that session |

### 4.3 Server → browser client (ws)

| `type` | fields | notes |
|--------|--------|-------|
| `welcome` | `clientId` | connection-level ack; assigns the id |
| `attached` | `sessionId`, `controllerId`, `geometry`, `epoch` | per-attach snapshot (replaces the old single `welcome`) |
| `outputFrame` | `sessionId`, `seq`, `epoch`, `data` | PTY bytes; `seq` monotonic per session, `epoch` bumps on that session's takeover |
| `controllerChanged` | `sessionId`, `controllerId`, `geometry` | broadcast to that session's clients |
| `geometry` | `sessionId`, `cols`, `rows` | authoritative PTY size for spectator letterboxing |
| `agentExit` | `sessionId`, `code` | that session's agent exited |
| `sessionsChanged` | `sessions: SessionMeta[]` | full registry snapshot, pushed to all clients on any change |

### 4.4 Daemon ↔ server (ws)

**server → daemon:** `spawn{sessionId,agentKind,cwd,resume?:ResumeRef,geometry}`,
`kill{sessionId}`, `scanRequest{requestId}`, and `input`/`resize`/`redraw` each gain `sessionId`.

**daemon → server:** `bind{sessionId,cmd,cwd,agentKind,geometry}` (sent on spawn success),
`agentFrame{sessionId,seq,data}`, `agentExit{sessionId,code}`, `spawnError{sessionId,message}`,
`scanResult{requestId,conversations:ConversationSummaryWire[],diagnostics}`.

**Ownership inversion:** the **server** generates `sessionId` on create/resume and sends
`spawn`; the daemon spawns the bridge and replies `bind`. (Today the daemon coins the id in
`bind`; the existing single-session launcher path is updated to the new flow.)

Two load-bearing ideas carry over unchanged, now *per session*: `epoch`+`seq` make takeover
sync assertable, and input/resize gated to the controller is the whole multi-client control
model — one rule, applied per `Session`.

---

## 5. Control plane vs data plane

- **tRPC (request/response), `apps/server/router.ts`:**
  - `sessions.list(): SessionMeta[]`
  - `sessions.create({ agentKind, cwd }): { sessionId }`
  - `sessions.resume({ agentKind, cwd, resume: ResumeRef, conversationId }): { sessionId }`
  - `sessions.kill({ sessionId }): void`
  - `discovery.scan(): { conversations: ConversationSummaryWire[], diagnostics }`
- **ws (hot path):** attach/detach, input, resize, requestControl, redrawRequest, frames,
  controllerChanged, geometry, agentExit, `sessionsChanged`.
- `create`/`resume` generate a `sessionId`, send `spawn` to the daemon, and **return
  immediately** with status `starting`; the client `attach`es and receives frames once the
  bridge binds. `discovery.scan` sends `scanRequest` and awaits the matching `scanResult`
  (correlated by `requestId`).

Keeping the control plane on tRPC preserves the "no app→app runtime dependency" rule
(`apps/web` imports only the `AppRouter` type).

---

## 6. Session lifecycle & control model

- **Per-session controller.** Each `Session` tracks its own `controllerId`; first attacher is
  controller; `requestControl{sessionId}` is last-taker-wins for *that* session. Input/resize
  honored only from that session's controller. Spectators still send `resize` (stored, not
  applied) so takeover knows their grid.
- **Persist on detach.** Closing a tab / detaching does **not** kill the agent. The bridge
  keeps running; reattaching sends `attached` + a `redraw` (clean current screen, not replay).
- **Explicit kill.** `sessions.kill` disposes the bridge and removes the session.
- **Self-exit.** On `agentExit`, the session is marked `status:'exited'` (with `exitCode`),
  broadcast via `sessionsChanged`, and retained until killed/dismissed (so the user sees it
  ended rather than having it vanish).
- **Controller hand-off on detach.** If the controller detaches, control passes to another
  attached client (as today), or becomes `null` if none remain.

---

## 7. Daemon + the launcher

On `spawn{sessionId,agentKind,cwd,resume?,geometry}` the daemon builds the command via a new
**`agentLaunchCommand(kind, { cwd, resume? }): { cmd, args }`** exported from
`@podium/agent-bridge` (agent knowledge lives there per ARCHITECTURE):

| agentKind | fresh | resume |
|-----------|-------|--------|
| `claude-code` | `claude` | `claude --resume <resume.value>` |
| `codex` | `codex` | `codex resume <resume.value>` |

`spawnAgent` already accepts `cwd`, so no bridge change beyond the launcher. The daemon wires
each bridge's `onFrame`→`agentFrame{sessionId}`, `onExit`→`agentExit{sessionId}`, replies
`bind{sessionId,…}` (or `spawnError`), routes `input`/`resize`/`redraw{sessionId}` to the
right bridge, `kill{sessionId}` disposes one, and `scanRequest` runs the existing
`scanAgentConversations()` → `scanResult`.

(Exact resume flags are validated against the real CLIs during the real-spawn phase; the
launcher is the single swappable point if a flag differs.)

---

## 8. terminal-client (`@podium/terminal-client`)

Keep the per-session `SessionConnection` API stable (so the fit-on-connect, `onData`,
toolbar, and takeover behavior just hardened does not regress), but back it with a shared
**`SocketHub`**:

- owns the single ws, sends `hello` once, and fans `sessionId`-tagged server messages to the
  right `SessionConnection`;
- `attach(sessionId): SessionConnection` and `detach(sessionId)`;
- exposes a `sessions()` observable fed by `sessionsChanged`.

**tRPC and all UI stay in `apps/web`** — terminal-client remains the framework-agnostic data
plane (no tRPC dep). `window.__podium` gains `sessions()` and `attach(id)` for tests, alongside
the existing per-session `state`/`screenHash`/`screenText`/`sendInput`/`takeControl`.

---

## 9. apps/web (functional switcher)

A switcher shell around the fullscreen terminal:

- **Live sessions** from tRPC `sessions.list`, kept current by ws `sessionsChanged`.
- **Discovered conversations** from `discovery.scan`, grouped by project/worktree, each row
  showing title · git branch · updated · agent, with a **Resume** action.
- **“+ New session”** — pick agentKind + cwd (free-text, prefilled from discovered
  `projectPath`s).
- Selecting a session attaches the terminal to it; **Kill** stops it.
- **Mobile:** the switcher is a slide-over drawer; the terminal stays fullscreen and reuses
  the responsive UI + key toolbar already built. **Desktop:** drawer/sidebar beside the
  terminal.

This is a *functional* switcher proving the flow end-to-end — not the final command-center
design.

---

## 10. Testing

Extends the existing tiers; assertions stay on structured state, not pixels.

- **Tier 0 / unit (vitest):**
  - `agentLaunchCommand` mapping (fresh + resume, both agents).
  - Daemon multi-bridge routing: spawn two fixtures, frames arrive tagged by `sessionId`,
    `kill` one leaves the other streaming.
  - `SessionRegistry`: create/resume/list/kill; **routing isolation** (input/resize for A
    never reach B); per-session takeover (epoch bump scoped to one session); `sessionsChanged`
    emitted on every mutation; `discovery.scan` round-trip against a mock daemon
    (`scanRequest`/`scanResult` correlated by `requestId`).
  - Protocol: zod round-trips for every new/extended message.
- **Browser e2e (Playwright, chromium-desktop / chromium-pixel / webkit-iphone):**
  - Two fixture sessions (distinguished via a new fixture `--label`), switch between them,
    assert **frame isolation** (each renders its own content) and per-session takeover.
  - Create flow (new session appears live via `sessionsChanged` and attaches).
  - Resume flow (the fixture stands in for a resumed conversation).
  - The fit-on-connect + keyboard + toolbar tests still pass per attached session.
- **Real claude/codex (loose):** a multi-session launcher (`e2e/serve.ts` successor) spawns
  real agents; a manual confirmation that resume attaches to an existing conversation. Real
  resume semantics are Tier-4-ish; the launcher abstracts the flags.

---

## 11. Build phases

1. **Protocol** — `sessionId` routing on all hot-path messages; `attach`/`detach`;
   `spawn`/`kill`/`scanRequest`/`scanResult`/`spawnError`; `attached`; `sessionsChanged`;
   `SessionMeta` + `ConversationSummaryWire` + `ResumeRef` schemas. Round-trip tests.
2. **agent-bridge** — `agentLaunchCommand(kind, {cwd, resume?})`. Unit tests. (Discovery scan
   already exists.)
3. **Server** — `SessionRegistry` + per-session `Session` (refactor today's `RelayHub`);
   multiplexed ws routing; tRPC `sessions.*` + `discovery.scan`; `sessionsChanged`. Unit tests
   incl. routing isolation.
4. **Daemon** — `Map<sessionId, AgentSession>`; handle `spawn`/`kill`/`scanRequest`; launcher
   wiring; tagged frames/exits. Tier-0 multi-bridge test.
5. **terminal-client** — `SocketHub` multiplexer + per-session `attach`; `sessions()`
   observable; `__podium` extension. (Preserve single-session behavior.)
6. **apps/web** — switcher shell (live + discovered + new/resume/kill) + attach; reuse the
   responsive terminal. Browser e2e across the three engines.
7. **Real-spawn launcher** — multi-session `serve.ts` successor + loose real claude/codex
   resume confirmation.

---

## 12. Non-goals (this increment)

Multiple daemons / multi-machine fan-out (single daemon; `sessionId` routing leaves room for
`daemonId`), WS auth / per-session control tokens, registry persistence across server
restarts, a transcript/history view, backpressure / binary frames, the *polished*
command-center grid, per-session scrollback. **The relay stays localhost-only** — exposing
multi-session beyond localhost requires the auth increment.

---

## 13. Risks / open questions

- **`bind` ownership inversion** — the server now coins `sessionId` and drives `spawn`; the
  daemon no longer originates ids. The existing single-session launcher/demo path must adopt
  the new flow (covered in phase 7).
- **Real resume flags** — `claude --resume <id>` / `codex resume <id>` are validated against
  the real CLIs in phase 7; the launcher is the single swap point if a flag differs.
- **terminal-client multiplexer** — the trickiest refactor; keep the per-session
  `SessionConnection` API stable so the hardened fit/keyboard/takeover behavior doesn't
  regress. Single-session e2e must stay green throughout.
- **Spawn latency / errors** — `create`/`resume` return `starting` before frames flow;
  `spawnError` surfaces a failed launch to the list (status, not a silent hang).
