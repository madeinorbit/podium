# Multiple Sessions — Phase 4: Daemon Multi-Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the daemon from a single-agent process (spawns one agent on startup) into a passive multi-bridge host that connects to the server and, on command, spawns/kills any number of agents and answers discovery scans — all routed by `sessionId`.

**Architecture:** `startDaemon({ serverUrl })` opens one ws to the server and holds `Map<sessionId, AgentSession>`. It reacts to server `ControlMessage`s: `spawn` (build the command via the Phase 2 `agentLaunchCommand`, spawn a bridge, stream `agentFrame{sessionId}`/`agentExit{sessionId}`, reply `bind`), `kill`, `input`/`resize`/`redraw` (routed per session), and `scanRequest` (run `scanAgentConversations` → `scanResult`). The launcher is injectable so tests drive the deterministic fixture TUI instead of real `claude`.

**Tech Stack:** TypeScript (ESM, strict), `ws`, Vitest. Package: `apps/daemon`. Depends on `@podium/agent-bridge` + `@podium/protocol`.

**Spec:** `docs/superpowers/specs/2026-06-03-multiple-sessions-design.md` §7.

---

## Sequencing note

Package-scoped gate: `bun run --filter @podium/daemon test|typecheck` + `bun run lint` (apps aren't
built — no `build` script). `@podium/agent-bridge` + `@podium/protocol` dist are already built. The
`e2e/` harness and `serve.ts` still call the OLD `startDaemon({sessionId,cmd,cols,rows,...})` and stay
red until Phases 6–7 — do NOT treat them as a gate, and do NOT run workspace-wide typecheck/test.

`apps/daemon` likely has no `test` script / `vitest` devDep — Task 1 adds them.

---

## File structure

- `apps/daemon/src/daemon.ts` — rewrite to the multi-bridge host.
- `apps/daemon/src/daemon.test.ts` — Tier-0 multi-bridge test (create).
- `apps/daemon/src/index.ts` — verify it still exports `startDaemon` + `DaemonOptions`/`DaemonHandle`.
- `apps/daemon/package.json` — add `vitest` devDep + `test` script.

---

### Task 1: Test infra

**Files:** Edit `apps/daemon/package.json`.

- [ ] **Step 1:** Add `"test": "vitest run --passWithNoTests"` to `scripts`. If `vitest` is not in `devDependencies`, add `"vitest": "^4.1.8"` (match `packages/protocol/package.json`) and run `bun install`.
- [ ] **Step 2: Commit** — `git add apps/daemon/package.json bun.lock && git commit -m "chore(daemon): add vitest + test script"` (lockfile only if it changed).

---

### Task 2: Multi-bridge test (failing)

**Files:** Create `apps/daemon/src/daemon.test.ts`.

- [ ] **Step 1: Write the test** — `apps/daemon/src/daemon.test.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { type DaemonMessage, encode, parseDaemonMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type WebSocket as WS, WebSocketServer } from 'ws'
import { type DaemonHandle, startDaemon } from './daemon'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)
const G = { cols: 80, rows: 24 }
const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8')
type AgentFrame = Extract<DaemonMessage, { type: 'agentFrame' }>

describe('daemon multi-bridge', () => {
  let wss: WebSocketServer
  let serverSocket: WS
  let received: DaemonMessage[]
  let daemon: DaemonHandle

  beforeEach(async () => {
    received = []
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })
    daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      // inject the deterministic fixture instead of real claude/codex
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected
  })

  afterEach(async () => {
    await daemon.close()
    await new Promise<void>((r) => wss.close(() => r()))
  })

  const send = (msg: unknown): void => serverSocket.send(encode(msg as never))
  const frames = (): AgentFrame[] =>
    received.filter((m): m is AgentFrame => m.type === 'agentFrame')
  const fixtureFrame = (sid: string): AgentFrame | undefined =>
    frames().find((f) => f.sessionId === sid && decode(f.data).includes('PODIUM-FIXTURE'))
  async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeout) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('spawns independent bridges and tags bind + frames by sessionId', async () => {
    send({ type: 'spawn', sessionId: 's1', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    send({ type: 'spawn', sessionId: 's2', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 's1'))
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 's2'))
    await waitFor(() => fixtureFrame('s1') !== undefined)
    await waitFor(() => fixtureFrame('s2') !== undefined)
    const sids = new Set(frames().map((f) => f.sessionId))
    expect([...sids].sort()).toEqual(['s1', 's2'])
  })

  it('routes resize to the right bridge; kill stops only the targeted one', async () => {
    send({ type: 'spawn', sessionId: 's1', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    send({ type: 'spawn', sessionId: 's2', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => fixtureFrame('s1') !== undefined)
    await waitFor(() => fixtureFrame('s2') !== undefined)

    send({ type: 'kill', sessionId: 's1' })
    send({ type: 'resize', sessionId: 's2', cols: 90, rows: 30 })
    // s2 repaints at the new width...
    await waitFor(() => frames().some((f) => f.sessionId === 's2' && decode(f.data).includes('cols=90')))
    await new Promise((r) => setTimeout(r, 100))
    // ...and the killed s1 never reports the new size (resize was routed only to s2).
    expect(frames().some((f) => f.sessionId === 's1' && decode(f.data).includes('cols=90'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify fail** — `bun run --filter @podium/daemon test` → FAIL (the current `startDaemon` signature has no `launch` and spawns on startup; the file won't typecheck/behave).
- [ ] **Step 3: Commit the test** — defer; commit together with the implementation in Task 3 (the test cannot pass until the rewrite). (Skip a standalone commit here.)

---

### Task 3: Rewrite the daemon (multi-bridge)

**Files:** Rewrite `apps/daemon/src/daemon.ts`.

- [ ] **Step 1: Implement** — replace `apps/daemon/src/daemon.ts` entirely:

```ts
import {
  type AgentConversationDiagnostic,
  type AgentConversationSummary,
  type AgentSession,
  agentLaunchCommand,
  scanAgentConversations,
  spawnAgent,
} from '@podium/agent-bridge'
import {
  type ControlMessage,
  type ConversationDiagnosticWire,
  type ConversationSummaryWire,
  type DaemonMessage,
  encode,
  parseControlMessage,
} from '@podium/protocol'
import WebSocket, { type RawData } from 'ws'

export interface DaemonOptions {
  serverUrl: string
  /** Map an agent kind to a spawn command. Defaults to agentLaunchCommand; tests inject a fixture. */
  launch?: typeof agentLaunchCommand
}

export interface DaemonHandle {
  close(): Promise<void>
}

type SpawnControl = Extract<ControlMessage, { type: 'spawn' }>

function summaryToWire(s: AgentConversationSummary): ConversationSummaryWire {
  return {
    id: s.id,
    agentKind: s.agentKind,
    ...(s.title !== undefined ? { title: s.title } : {}),
    ...(s.projectPath !== undefined ? { projectPath: s.projectPath } : {}),
    ...(s.parentConversationId !== undefined ? { parentConversationId: s.parentConversationId } : {}),
    ...(s.statusHint !== undefined ? { statusHint: s.statusHint } : {}),
    ...(s.createdAt ? { createdAt: s.createdAt.toISOString() } : {}),
    ...(s.updatedAt ? { updatedAt: s.updatedAt.toISOString() } : {}),
    ...(s.messageCount !== undefined ? { messageCount: s.messageCount } : {}),
    ...(s.git ? { git: s.git } : {}),
    ...(s.resume ? { resume: s.resume } : {}),
    providerId: s.source.providerId,
  }
}

function diagnosticToWire(d: AgentConversationDiagnostic): ConversationDiagnosticWire {
  return {
    severity: d.severity,
    ...(d.providerId !== undefined ? { providerId: d.providerId } : {}),
    ...(d.root !== undefined ? { root: d.root } : {}),
    ...(d.path !== undefined ? { path: d.path } : {}),
    message: d.message,
  }
}

export function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const launch = opts.launch ?? agentLaunchCommand
  const ws = new WebSocket(`${opts.serverUrl}/daemon`)
  const bridges = new Map<string, AgentSession>()

  const send = (msg: DaemonMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg))
  }

  const spawn = (msg: SpawnControl): void => {
    try {
      const cmd = launch(msg.agentKind, {
        cwd: msg.cwd,
        ...(msg.resume ? { resume: msg.resume } : {}),
      })
      const session = spawnAgent({
        cmd: cmd.cmd,
        args: cmd.args,
        cwd: cmd.cwd,
        cols: msg.geometry.cols,
        rows: msg.geometry.rows,
      })
      bridges.set(msg.sessionId, session)
      session.onFrame((frame) =>
        send({ type: 'agentFrame', sessionId: msg.sessionId, seq: frame.seq, data: frame.data }),
      )
      session.onExit((code) => {
        bridges.delete(msg.sessionId)
        send({ type: 'agentExit', sessionId: msg.sessionId, code })
      })
      send({
        type: 'bind',
        sessionId: msg.sessionId,
        cmd: cmd.cmd,
        cwd: cmd.cwd,
        agentKind: msg.agentKind,
        geometry: msg.geometry,
      })
    } catch (err) {
      send({
        type: 'spawnError',
        sessionId: msg.sessionId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const scan = async (requestId: string): Promise<void> => {
    try {
      const result = await scanAgentConversations()
      send({
        type: 'scanResult',
        requestId,
        conversations: result.conversations.map(summaryToWire),
        diagnostics: result.diagnostics.map(diagnosticToWire),
      })
    } catch (err) {
      send({
        type: 'scanResult',
        requestId,
        conversations: [],
        diagnostics: [
          { severity: 'error', message: err instanceof Error ? err.message : String(err) },
        ],
      })
    }
  }

  ws.on('message', (raw: RawData) => {
    let msg: ControlMessage
    try {
      msg = parseControlMessage(raw.toString())
    } catch {
      return
    }
    switch (msg.type) {
      case 'spawn':
        spawn(msg)
        break
      case 'kill': {
        const session = bridges.get(msg.sessionId)
        if (session) {
          session.dispose()
          bridges.delete(msg.sessionId)
        }
        break
      }
      case 'input':
        bridges.get(msg.sessionId)?.write(msg.data)
        break
      case 'resize':
        bridges.get(msg.sessionId)?.resize(msg.cols, msg.rows)
        break
      case 'redraw':
        bridges.get(msg.sessionId)?.redraw()
        break
      case 'scanRequest':
        void scan(msg.requestId)
        break
    }
  })

  const disposeAll = (): void => {
    for (const session of bridges.values()) session.dispose()
    bridges.clear()
  }

  const handle: DaemonHandle = {
    close() {
      return new Promise<void>((resolve) => {
        disposeAll()
        if (ws.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        ws.once('close', () => resolve())
        ws.close()
      })
    },
  }

  return new Promise<DaemonHandle>((resolve, reject) => {
    ws.once('open', () => resolve(handle))
    ws.once('error', (err) => {
      disposeAll()
      reject(err)
    })
  })
}
```

- [ ] **Step 2: Run, verify pass** — `bun run --filter @podium/daemon test` → both tests PASS (real fixture processes spawned via the injected launcher).
- [ ] **Step 3: Commit** — `git add apps/daemon/src/daemon.ts apps/daemon/src/daemon.test.ts && git commit -m "feat(daemon): multi-bridge host — server-driven spawn/kill/scan, session-routed"`

---

### Task 4: Exports + package gate

**Files:** `apps/daemon/src/index.ts`.

- [ ] **Step 1:** Read `apps/daemon/src/index.ts`; ensure it exports `startDaemon`, `DaemonOptions`, `DaemonHandle` (the `DaemonOptions` shape changed — drop any now-stale re-exports). If it uses `export * from './daemon'`, no change is needed.
- [ ] **Step 2: Package gate**
  - `bun run --filter @podium/daemon test` → pass.
  - `bun run --filter @podium/daemon typecheck` → exit 0.
  - `bun run lint` → clean (run `bun run format` first if Biome would reformat).
- [ ] **Step 3: Commit (if index changed)** — `git add apps/daemon/src/index.ts && git commit -m "chore(daemon): export surface for multi-bridge startDaemon"`

---

## Self-review checklist

- **Spec coverage (§7):** `spawn` builds the command via `agentLaunchCommand` (injectable), spawns a bridge, replies `bind`, streams `agentFrame`/`agentExit` tagged by `sessionId`; `spawnError` on failure; `kill` disposes one bridge; `input`/`resize`/`redraw` routed per session; `scanRequest` → `scanAgentConversations` → `scanResult` (summaries+diagnostics mapped to wire, dates→ISO). ✔
- **No startup spawn:** the daemon is passive; it only spawns on server command (`DaemonOptions` no longer has `sessionId`/`cmd`/`cols`/`rows`).
- **Type consistency:** `SpawnControl = Extract<ControlMessage,{type:'spawn'}>`; `launch?: typeof agentLaunchCommand`; wire mappers emit exactly `ConversationSummaryWire`/`ConversationDiagnosticWire` (no `Date`, no `cause`).
- **Isolation proven:** the test asserts frames are tagged per session and that killing s1 + resizing s2 never makes s1 report the new size.
- **Gate is package-scoped; no `build` script for an app.** `e2e/`+`serve.ts` update in Phases 6–7.
