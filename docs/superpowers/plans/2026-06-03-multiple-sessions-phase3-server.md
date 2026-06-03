# Multiple Sessions — Phase 3: Server SessionRegistry + tRPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-session relay into a registry of per-session relays: one `Session` per agent, a `SessionRegistry` that routes every wire message by `sessionId`, a tRPC surface to list/create/resume/kill sessions and scan discovery, and a `sessionsChanged` push that keeps clients' lists live.

**Architecture:** `Session` owns one agent's relay state (controller, geometry, epoch, attached clients) — today's `RelayHub` logic, scoped. `SessionRegistry` owns `Map<sessionId, Session>` + the client connections + the single daemon link, and is the router + lifecycle owner. Transport stays dumb (`wsServer` just forwards). tRPC is the control plane; ws is the data plane.

**Tech Stack:** TypeScript (ESM, strict), `@trpc/server`, `zod`, Vitest. Package: `apps/server`. Depends on `@podium/protocol`.

**Spec:** `docs/superpowers/specs/2026-06-03-multiple-sessions-design.md` §3–6.

---

## Sequencing note

Package-scoped gate only: `bun run --filter @podium/server test|typecheck|build` + `bun run lint`.
`@podium/server` depends on `@podium/protocol` (already built). The `e2e/` harness and browser
tests still reference the old API and stay red until Phase 6 — do NOT treat them as a phase-3 gate,
and do NOT run workspace-wide typecheck/test as the gate. `apps/server` has no unit tests today and
may lack a `test` script + `vitest` devDep; Task 3 adds them.

**The test files in this plan are the authoritative behavior spec.** Implement `Session` /
`SessionRegistry` so they pass exactly; the routing-isolation tests are the point of this phase.

---

## File structure

- `apps/server/src/session.ts` — `Session` class + `ClientConn`/`Send` types (create).
- `apps/server/src/session.test.ts` — per-session behavior (create).
- `apps/server/src/relay.ts` — replace `RelayHub` with `SessionRegistry` (rewrite).
- `apps/server/src/relay.test.ts` — registry routing + lifecycle, incl. isolation (create).
- `apps/server/src/router.ts` — tRPC `sessions.*` + `discovery.scan` (rewrite).
- `apps/server/src/router.test.ts` — tRPC delegation (create).
- `apps/server/src/wsServer.ts` — forward to the registry (rename `hub`→`registry`).
- `apps/server/src/server.ts` — instantiate `SessionRegistry`; context `{ registry }` (edit).
- `apps/server/src/index.ts` — exports (edit).
- `apps/server/package.json` — add `vitest` devDep + `test` script (edit).

---

### Task 1: `Session` (per-session relay state)

**Files:** Create `apps/server/src/session.ts` and `apps/server/src/session.test.ts`.

- [ ] **Step 1: Write the failing tests** — `apps/server/src/session.test.ts`:

```ts
import type { Geometry, ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { type ClientConn, Session } from './session'

const geo: Geometry = { cols: 80, rows: 24 }

function makeSession(toDaemon = vi.fn()) {
  return new Session({
    sessionId: 's1',
    agentKind: 'claude-code',
    cwd: '/w',
    title: 'w',
    origin: { kind: 'spawn' },
    createdAt: '2026-06-03T00:00:00.000Z',
    geometry: geo,
    toDaemon,
  })
}
function makeClient(id: string): ClientConn & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  return { id, send: (m) => sent.push(m), viewport: { ...geo }, attached: new Set(), sent }
}

describe('Session', () => {
  it('first attached client becomes controller and gets an attached snapshot', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    expect(s.controllerId).toBe('a')
    expect(a.sent).toContainEqual({
      type: 'attached',
      sessionId: 's1',
      controllerId: 'a',
      geometry: geo,
      epoch: 0,
    })
  })

  it('a second client attaches as spectator', () => {
    const s = makeSession()
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    expect(s.controllerId).toBe('a')
    expect(b.sent.at(-1)).toMatchObject({ type: 'attached', controllerId: 'a' })
  })

  it('honors input only from the controller', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    s.handleInput('b', 'eA==')
    expect(toDaemon).not.toHaveBeenCalled()
    s.handleInput('a', 'eA==')
    expect(toDaemon).toHaveBeenCalledWith({ type: 'input', sessionId: 's1', data: 'eA==' })
  })

  it('controller resize updates geometry + resizes agent; spectator resize is stored only', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    s.handleResize('b', 100, 30)
    expect(s.geometry).toEqual(geo)
    expect(toDaemon).not.toHaveBeenCalled()
    s.handleResize('a', 120, 40)
    expect(s.geometry).toEqual({ cols: 120, rows: 40 })
    expect(toDaemon).toHaveBeenCalledWith({ type: 'resize', sessionId: 's1', cols: 120, rows: 40 })
  })

  it('takeover bumps epoch, resizes+redraws the agent, broadcasts controllerChanged + geometry', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    s.handleResize('b', 50, 60)
    s.requestControl('b')
    expect(s.controllerId).toBe('b')
    expect(s.epoch).toBe(1)
    expect(s.geometry).toEqual({ cols: 50, rows: 60 })
    expect(toDaemon).toHaveBeenCalledWith({ type: 'resize', sessionId: 's1', cols: 50, rows: 60 })
    expect(toDaemon).toHaveBeenCalledWith({ type: 'redraw', sessionId: 's1' })
    for (const c of [a, b]) {
      expect(c.sent).toContainEqual({
        type: 'controllerChanged',
        sessionId: 's1',
        controllerId: 'b',
        geometry: { cols: 50, rows: 60 },
      })
      expect(c.sent).toContainEqual({ type: 'geometry', sessionId: 's1', cols: 50, rows: 60 })
    }
  })

  it('broadcasts frames to attached clients with the current epoch', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    s.onFrame(7, 'ZGF0YQ==')
    expect(a.sent).toContainEqual({
      type: 'outputFrame',
      sessionId: 's1',
      seq: 7,
      epoch: 0,
      data: 'ZGF0YQ==',
    })
  })

  it('reassigns controller when the controller detaches', () => {
    const s = makeSession()
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    s.detachClient('a')
    expect(s.controllerId).toBe('b')
    expect(b.sent).toContainEqual(
      expect.objectContaining({ type: 'controllerChanged', controllerId: 'b' }),
    )
  })

  it('marks exited and broadcasts agentExit', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    s.onExit(0)
    expect(s.status).toBe('exited')
    expect(a.sent).toContainEqual({ type: 'agentExit', sessionId: 's1', code: 0 })
    expect(s.toMeta()).toMatchObject({ status: 'exited', exitCode: 0 })
  })
})
```

- [ ] **Step 2: Run, verify fail** — `bunx vitest run apps/server/src/session.test.ts` → FAIL (no `./session`).

- [ ] **Step 3: Implement** — `apps/server/src/session.ts`:

```ts
import type {
  AgentKind,
  ControlMessage,
  Geometry,
  ServerMessage,
  SessionMeta,
  SessionOrigin,
} from '@podium/protocol'

export type Send<T> = (msg: T) => void

export interface ClientConn {
  id: string
  send: Send<ServerMessage>
  viewport: Geometry
  attached: Set<string>
}

export interface SessionInit {
  sessionId: string
  agentKind: AgentKind
  cwd: string
  title: string
  origin: SessionOrigin
  createdAt: string
  geometry: Geometry
  toDaemon: Send<ControlMessage>
}

/** One agent's relay state: controller gating, geometry/epoch, and its attached clients. */
export class Session {
  readonly sessionId: string
  readonly agentKind: AgentKind
  readonly cwd: string
  readonly origin: SessionOrigin
  readonly createdAt: string
  title: string
  cmd = ''
  status: 'starting' | 'live' | 'exited' = 'starting'
  exitCode: number | undefined
  geometry: Geometry
  epoch = 0
  controllerId: string | null = null
  private readonly toDaemon: Send<ControlMessage>
  private readonly clients = new Map<string, ClientConn>()
  private readonly viewports = new Map<string, Geometry>()

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.agentKind = init.agentKind
    this.cwd = init.cwd
    this.title = init.title
    this.origin = init.origin
    this.createdAt = init.createdAt
    this.geometry = { ...init.geometry }
    this.toDaemon = init.toDaemon
  }

  get clientCount(): number {
    return this.clients.size
  }

  attachClient(client: ClientConn): void {
    this.clients.set(client.id, client)
    this.viewports.set(client.id, { ...client.viewport })
    if (this.controllerId === null) this.controllerId = client.id
    client.send({
      type: 'attached',
      sessionId: this.sessionId,
      controllerId: this.controllerId,
      geometry: { ...this.geometry },
      epoch: this.epoch,
    })
  }

  detachClient(clientId: string): void {
    this.clients.delete(clientId)
    this.viewports.delete(clientId)
    if (this.controllerId === clientId) {
      this.controllerId = this.clients.keys().next().value ?? null
      if (this.controllerId !== null) {
        this.broadcast({
          type: 'controllerChanged',
          sessionId: this.sessionId,
          controllerId: this.controllerId,
          geometry: { ...this.geometry },
        })
      }
    }
  }

  detachAll(): void {
    this.clients.clear()
    this.viewports.clear()
    this.controllerId = null
  }

  handleInput(clientId: string, data: string): void {
    if (clientId === this.controllerId) {
      this.toDaemon({ type: 'input', sessionId: this.sessionId, data })
    }
  }

  handleResize(clientId: string, cols: number, rows: number): void {
    this.viewports.set(clientId, { cols, rows })
    if (clientId === this.controllerId) {
      this.geometry = { cols, rows }
      this.toDaemon({ type: 'resize', sessionId: this.sessionId, cols, rows })
    }
  }

  requestControl(clientId: string): void {
    if (!this.clients.has(clientId)) return
    this.controllerId = clientId
    this.geometry = { ...(this.viewports.get(clientId) ?? this.geometry) }
    this.epoch += 1
    this.toDaemon({
      type: 'resize',
      sessionId: this.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
    this.toDaemon({ type: 'redraw', sessionId: this.sessionId })
    this.broadcast({
      type: 'controllerChanged',
      sessionId: this.sessionId,
      controllerId: clientId,
      geometry: { ...this.geometry },
    })
    this.broadcast({
      type: 'geometry',
      sessionId: this.sessionId,
      cols: this.geometry.cols,
      rows: this.geometry.rows,
    })
  }

  redraw(): void {
    this.toDaemon({ type: 'redraw', sessionId: this.sessionId })
  }

  onFrame(seq: number, data: string): void {
    this.broadcast({ type: 'outputFrame', sessionId: this.sessionId, seq, epoch: this.epoch, data })
  }

  onExit(code: number): void {
    this.status = 'exited'
    this.exitCode = code
    this.broadcast({ type: 'agentExit', sessionId: this.sessionId, code })
  }

  /** A spawn that never started — surface as an exit so attached clients stop waiting. */
  markSpawnError(message: string): void {
    this.status = 'exited'
    this.exitCode = -1
    console.warn(`[podium] spawn failed for ${this.sessionId}: ${message}`)
    this.broadcast({ type: 'agentExit', sessionId: this.sessionId, code: -1 })
  }

  markLive(cmd: string, geometry: Geometry): void {
    this.cmd = cmd
    if (this.status === 'starting') this.status = 'live'
    // Adopt the daemon's geometry only if no controller has resized us yet.
    if (this.controllerId === null) this.geometry = { ...geometry }
  }

  toMeta(): SessionMeta {
    return {
      sessionId: this.sessionId,
      agentKind: this.agentKind,
      title: this.title,
      cwd: this.cwd,
      status: this.status,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      controllerId: this.controllerId,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      clientCount: this.clients.size,
      createdAt: this.createdAt,
      origin: this.origin,
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.send(msg)
  }
}
```

- [ ] **Step 4: Run, verify pass** — `bunx vitest run apps/server/src/session.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add apps/server/src/session.ts apps/server/src/session.test.ts && git commit -m "feat(server): per-session Session relay state"`

---

### Task 2: `SessionRegistry` (router + lifecycle)

**Files:** Rewrite `apps/server/src/relay.ts`; create `apps/server/src/relay.test.ts`.

- [ ] **Step 1: Write the failing tests** — `apps/server/src/relay.test.ts`:

```ts
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

function sink() {
  const sent: ServerMessage[] = []
  return { send: (m: ServerMessage) => sent.push(m), sent }
}
const G = { cols: 80, rows: 24 }
const bind = (sessionId: string) =>
  ({ type: 'bind', sessionId, cmd: 'claude', cwd: '/', agentKind: 'claude-code', geometry: G }) as const

describe('SessionRegistry', () => {
  it('create spawns via the daemon and lists the session as starting', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/proj' }),
    )
    expect(reg.listSessions()).toMatchObject([
      { sessionId, status: 'starting', agentKind: 'claude-code', cwd: '/proj', origin: { kind: 'spawn' } },
    ])
  })

  it('resume spawns with the resume ref + resume origin', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
      title: 'old',
    })
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, resume: { kind: 'codex-thread', value: 't9' } }),
    )
    expect(reg.listSessions()[0]).toMatchObject({
      origin: { kind: 'resume', conversationId: 'c9' },
      title: 'old',
    })
  })

  it('routes frames only to clients attached to that session (ISOLATION)', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    const s2 = reg.createSession({ agentKind: 'claude-code', cwd: '/b' }).sessionId
    reg.onDaemonMessage(bind(s1))
    reg.onDaemonMessage(bind(s2))
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.onDaemonMessage({ type: 'agentFrame', sessionId: s1, seq: 0, data: 'QQ==' })
    reg.onDaemonMessage({ type: 'agentFrame', sessionId: s2, seq: 0, data: 'Qg==' })
    const frames = c.sent.filter((m) => m.type === 'outputFrame')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ sessionId: s1, data: 'QQ==' })
  })

  it('routes controller input to the daemon tagged with the right sessionId', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.onDaemonMessage(bind(s1))
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.onClientMessage(id, { type: 'input', sessionId: s1, data: 'eA==' })
    expect(daemon).toContainEqual({ type: 'input', sessionId: s1, data: 'eA==' })
  })

  it('takeover on one session leaves another session epoch untouched', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    const s2 = reg.createSession({ agentKind: 'claude-code', cwd: '/b' }).sessionId
    reg.onDaemonMessage(bind(s1))
    reg.onDaemonMessage(bind(s2))
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.onClientMessage(id, { type: 'requestControl', sessionId: s1 })
    expect(reg.listSessions().find((m) => m.sessionId === s2)?.epoch).toBe(0)
  })

  it('kill removes the session and tells the daemon', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.killSession({ sessionId: s1 })
    expect(daemon).toContainEqual({ type: 'kill', sessionId: s1 })
    expect(reg.listSessions()).toHaveLength(0)
  })

  it('agentExit marks the session exited but keeps it listed', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.onDaemonMessage({ type: 'agentExit', sessionId: s1, code: 0 })
    expect(reg.listSessions().find((m) => m.sessionId === s1)).toMatchObject({
      status: 'exited',
      exitCode: 0,
    })
  })

  it('attachClient sends welcome + a sessions snapshot', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    reg.createSession({ agentKind: 'claude-code', cwd: '/a' })
    const c = sink()
    const id = reg.attachClient(c.send)
    expect(c.sent).toContainEqual({ type: 'welcome', clientId: id })
    expect(c.sent.some((m) => m.type === 'sessionsChanged')).toBe(true)
  })

  it('scan correlates the daemon scanResult back to the caller', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const p = reg.scan()
    const req = daemon.find((m) => m.type === 'scanRequest') as { requestId: string } | undefined
    expect(req).toBeDefined()
    reg.onDaemonMessage({
      type: 'scanResult',
      requestId: req!.requestId,
      conversations: [{ id: 'x', agentKind: 'claude-code', providerId: 'p' }],
      diagnostics: [],
    })
    await expect(p).resolves.toMatchObject({ conversations: [{ id: 'x' }], diagnostics: [] })
  })
})
```

- [ ] **Step 2: Run, verify fail** — `bunx vitest run apps/server/src/relay.test.ts` → FAIL.

- [ ] **Step 3: Implement** — replace `apps/server/src/relay.ts` entirely:

```ts
import { basename } from 'node:path'
import type {
  AgentKind,
  ClientMessage,
  ControlMessage,
  ConversationDiagnosticWire,
  ConversationSummaryWire,
  DaemonMessage,
  Geometry,
  ResumeRef,
  ServerMessage,
  SessionMeta,
} from '@podium/protocol'
import { type ClientConn, type Send, Session } from './session'

const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }
const SCAN_TIMEOUT_MS = 10_000

export interface ScanResult {
  conversations: ConversationSummaryWire[]
  diagnostics: ConversationDiagnosticWire[]
}

/** Registry of all sessions + the single daemon link + all client connections. Routes by sessionId. */
export class SessionRegistry {
  private daemonSend: Send<ControlMessage> | undefined
  private readonly sessions = new Map<string, Session>()
  private readonly clients = new Map<string, ClientConn>()
  private readonly pendingScans = new Map<string, (r: ScanResult) => void>()
  private nextClientNum = 0
  private nextSessionNum = 0
  private nextRequestNum = 0

  attachDaemon(send: Send<ControlMessage>): void {
    this.daemonSend = send
  }
  detachDaemon(): void {
    this.daemonSend = undefined
  }
  private readonly toDaemon: Send<ControlMessage> = (msg) => this.daemonSend?.(msg)

  // ---- tRPC control plane ----
  listSessions(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => s.toMeta())
  }

  createSession(input: { agentKind: AgentKind; cwd: string; title?: string }): { sessionId: string } {
    return this.spawn({ ...input, origin: { kind: 'spawn' } })
  }

  resumeSession(input: {
    agentKind: AgentKind
    cwd: string
    resume: ResumeRef
    conversationId: string
    title?: string
  }): { sessionId: string } {
    return this.spawn({
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title,
      origin: { kind: 'resume', conversationId: input.conversationId },
      resume: input.resume,
    })
  }

  killSession(input: { sessionId: string }): void {
    this.toDaemon({ type: 'kill', sessionId: input.sessionId })
    this.sessions.get(input.sessionId)?.detachAll()
    this.sessions.delete(input.sessionId)
    for (const c of this.clients.values()) c.attached.delete(input.sessionId)
    this.broadcastSessions()
  }

  scan(): Promise<ScanResult> {
    const requestId = `r${this.nextRequestNum++}`
    return new Promise<ScanResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingScans.delete(requestId)
        resolve({
          conversations: [],
          diagnostics: [{ severity: 'error', message: 'discovery scan timed out' }],
        })
      }, SCAN_TIMEOUT_MS)
      timer.unref?.()
      this.pendingScans.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.toDaemon({ type: 'scanRequest', requestId })
    })
  }

  private spawn(input: {
    agentKind: AgentKind
    cwd: string
    title?: string
    origin: SessionMeta['origin']
    resume?: ResumeRef
  }): { sessionId: string } {
    const sessionId = `s${this.nextSessionNum++}`
    const session = new Session({
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      origin: input.origin,
      createdAt: new Date().toISOString(),
      geometry: { ...DEFAULT_GEOMETRY },
      toDaemon: this.toDaemon,
    })
    this.sessions.set(sessionId, session)
    this.toDaemon({
      type: 'spawn',
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      ...(input.resume ? { resume: input.resume } : {}),
      geometry: { ...DEFAULT_GEOMETRY },
    })
    this.broadcastSessions()
    return { sessionId }
  }

  // ---- ws data plane: clients ----
  attachClient(send: Send<ServerMessage>): string {
    const id = `c${this.nextClientNum++}`
    this.clients.set(id, { id, send, viewport: { ...DEFAULT_GEOMETRY }, attached: new Set() })
    send({ type: 'welcome', clientId: id })
    send({ type: 'sessionsChanged', sessions: this.listSessions() })
    return id
  }

  detachClient(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    for (const sessionId of client.attached) this.sessions.get(sessionId)?.detachClient(id)
    this.clients.delete(id)
    this.broadcastSessions()
  }

  onClientMessage(id: string, msg: ClientMessage): void {
    const client = this.clients.get(id)
    if (!client) return
    switch (msg.type) {
      case 'hello':
        client.viewport = { cols: msg.viewport.cols, rows: msg.viewport.rows }
        break
      case 'attach': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) return
        client.attached.add(msg.sessionId)
        session.attachClient(client)
        this.broadcastSessions()
        break
      }
      case 'detach':
        client.attached.delete(msg.sessionId)
        this.sessions.get(msg.sessionId)?.detachClient(id)
        this.broadcastSessions()
        break
      case 'input':
        this.sessions.get(msg.sessionId)?.handleInput(id, msg.data)
        break
      case 'resize':
        this.sessions.get(msg.sessionId)?.handleResize(id, msg.cols, msg.rows)
        break
      case 'requestControl':
        this.sessions.get(msg.sessionId)?.requestControl(id)
        this.broadcastSessions()
        break
      case 'redrawRequest':
        this.sessions.get(msg.sessionId)?.redraw()
        break
    }
  }

  // ---- ws data plane: daemon ----
  onDaemonMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case 'bind':
        this.sessions.get(msg.sessionId)?.markLive(msg.cmd, msg.geometry)
        this.broadcastSessions()
        break
      case 'agentFrame':
        this.sessions.get(msg.sessionId)?.onFrame(msg.seq, msg.data)
        break
      case 'agentExit':
        this.sessions.get(msg.sessionId)?.onExit(msg.code)
        this.broadcastSessions()
        break
      case 'spawnError':
        this.sessions.get(msg.sessionId)?.markSpawnError(msg.message)
        this.broadcastSessions()
        break
      case 'scanResult': {
        const resolve = this.pendingScans.get(msg.requestId)
        if (resolve) {
          this.pendingScans.delete(msg.requestId)
          resolve({ conversations: msg.conversations, diagnostics: msg.diagnostics })
        }
        break
      }
    }
  }

  private broadcastSessions(): void {
    const msg: ServerMessage = { type: 'sessionsChanged', sessions: this.listSessions() }
    for (const c of this.clients.values()) c.send(msg)
  }
}
```

- [ ] **Step 4: Run, verify pass** — `bunx vitest run apps/server/src/relay.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add apps/server/src/relay.ts apps/server/src/relay.test.ts && git commit -m "feat(server): SessionRegistry — multi-session routing + lifecycle"`

---

### Task 3: tRPC router + test infra

**Files:** Rewrite `apps/server/src/router.ts`; create `apps/server/src/router.test.ts`; edit `apps/server/package.json`.

- [ ] **Step 1: Ensure vitest runs in this package**

Read `apps/server/package.json`. Add `"test": "vitest run --passWithNoTests"` to `scripts`. If
`vitest` is not in `devDependencies`, add `"vitest": "^4.1.8"` (match the version other packages
use — check `packages/protocol/package.json`) and run `bun install`.

- [ ] **Step 2: Write the failing router test** — `apps/server/src/router.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

function caller() {
  const registry = new SessionRegistry()
  registry.attachDaemon(() => {})
  return { registry, call: appRouter.createCaller({ registry }) }
}

describe('appRouter', () => {
  it('sessions.create then sessions.list reflects it', async () => {
    const { call } = caller()
    const { sessionId } = await call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    const list = await call.sessions.list()
    expect(list).toMatchObject([{ sessionId, agentKind: 'claude-code', cwd: '/p' }])
  })

  it('sessions.kill removes the session', async () => {
    const { call } = caller()
    const { sessionId } = await call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await call.sessions.kill({ sessionId })
    expect(await call.sessions.list()).toHaveLength(0)
  })

  it('discovery.scan resolves via the registry', async () => {
    const { registry, call } = caller()
    const p = call.discovery.scan()
    // drive the daemon round-trip
    // (registry sent a scanRequest to the no-op daemon; feed a result back)
    registry.onDaemonMessage({
      type: 'scanResult',
      requestId: 'r0',
      conversations: [],
      diagnostics: [],
    })
    await expect(p).resolves.toEqual({ conversations: [], diagnostics: [] })
  })
})
```

(Note: `requestId` is `r0` because `scan()` is the first scan on a fresh registry. If the
implementation numbers differently, adjust the test to read the request id from a daemon spy as in
`relay.test.ts`.)

- [ ] **Step 3: Run, verify fail** — `bun run --filter @podium/server test` → FAIL.

- [ ] **Step 4: Implement** — replace `apps/server/src/router.ts`:

```ts
import { AgentKind, ResumeRef } from '@podium/protocol'
import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import type { SessionRegistry } from './relay'

export interface Context {
  registry: SessionRegistry
}

const t = initTRPC.context<Context>().create()

export const appRouter = t.router({
  sessions: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.listSessions()),
    create: t.procedure
      .input(z.object({ agentKind: AgentKind, cwd: z.string(), title: z.string().optional() }))
      .mutation(({ ctx, input }) => ctx.registry.createSession(input)),
    resume: t.procedure
      .input(
        z.object({
          agentKind: AgentKind,
          cwd: z.string(),
          resume: ResumeRef,
          conversationId: z.string(),
          title: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.resumeSession(input)),
    kill: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.killSession(input)),
  }),
  discovery: t.router({
    scan: t.procedure.query(({ ctx }) => ctx.registry.scan()),
  }),
})

export type AppRouter = typeof appRouter
```

- [ ] **Step 5: Run, verify pass** — `bun run --filter @podium/server test` → PASS (session + relay + router).
- [ ] **Step 6: Commit** — `git add apps/server/src/router.ts apps/server/src/router.test.ts apps/server/package.json && git commit -m "feat(server): tRPC sessions.* + discovery.scan; vitest in apps/server"` (include `bun.lock`/lockfile if `bun install` changed it).

---

### Task 4: Wire registry into server + ws, fix exports, package gate

**Files:** Edit `apps/server/src/wsServer.ts`, `apps/server/src/server.ts`, `apps/server/src/index.ts`.

- [ ] **Step 1: `wsServer.ts`** — change the parameter type from `RelayHub` to `SessionRegistry` and rename `hub`→`registry`. The body is otherwise unchanged (same `attachDaemon`/`onDaemonMessage`/`detachDaemon` and `attachClient`/`onClientMessage`/`detachClient` calls):

```ts
import type { Server } from 'node:http'
import { encode, parseClientMessage, parseDaemonMessage } from '@podium/protocol'
import { WebSocketServer } from 'ws'
import type { SessionRegistry } from './relay'

export interface WsHandle {
  close(): Promise<void>
}

export function attachWebSockets(server: Server, registry: SessionRegistry): WsHandle {
  const daemonWss = new WebSocketServer({ noServer: true })
  const clientWss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname === '/daemon') {
      daemonWss.handleUpgrade(req, socket, head, (ws) => daemonWss.emit('connection', ws, req))
    } else if (pathname === '/client') {
      clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })

  daemonWss.on('connection', (ws) => {
    registry.attachDaemon((msg) => ws.send(encode(msg)))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        registry.onDaemonMessage(parseDaemonMessage(raw.toString()))
      } catch {
        // ignore malformed daemon frames
      }
    })
    ws.on('close', () => registry.detachDaemon())
  })

  clientWss.on('connection', (ws) => {
    const id = registry.attachClient((msg) => ws.send(encode(msg)))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        registry.onClientMessage(id, parseClientMessage(raw.toString()))
      } catch {
        // ignore malformed client frames
      }
    })
    ws.on('close', () => registry.detachClient(id))
  })

  return {
    close() {
      return new Promise<void>((resolve) => {
        for (const ws of daemonWss.clients) ws.terminate()
        for (const ws of clientWss.clients) ws.terminate()
        daemonWss.close(() => clientWss.close(() => resolve()))
      })
    },
  }
}
```

- [ ] **Step 2: `server.ts`** — instantiate `SessionRegistry`, expose it as `registry`, use it in the tRPC context:

```ts
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { attachWebSockets } from './wsServer'

export interface ServerHandle {
  port: number
  registry: SessionRegistry
  close(): Promise<void>
}

export function startServer(opts: { port?: number } = {}): Promise<ServerHandle> {
  const registry = new SessionRegistry()
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext: () => ({ registry }) }))

  return new Promise<ServerHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0 }, (info) => {
      const ws = attachWebSockets(server as unknown as Server, registry)
      resolve({
        port: info.port,
        registry,
        close: () =>
          ws.close().then(
            () =>
              new Promise<void>((res) => {
                ;(server as unknown as Server).close(() => res())
              }),
          ),
      })
    })
  })
}
```

- [ ] **Step 3: `index.ts`** — exports still surface the registry + router type:

```ts
/**
 * @podium/server — session registry + Hono/ws/tRPC server. Exports the tRPC AppRouter type.
 */
export * from './relay'
export * from './session'
export type { AppRouter } from './router'
export type { ServerHandle } from './server'
export { startServer } from './server'
```

- [ ] **Step 4: Package gate**

Run: `bun run --filter @podium/server test` → all pass (session + relay + router).
Run: `bun run --filter @podium/server typecheck` → exit 0.
Run: `bun run --filter @podium/server build` → exit 0.
Run: `bun run lint` → clean for `apps/server` files (run `bun run format` first if Biome would reformat).

(Workspace-wide typecheck stays red — `e2e/` + `terminal-client` not yet updated. Expected.)

- [ ] **Step 5: Commit** — `git add apps/server/src/wsServer.ts apps/server/src/server.ts apps/server/src/index.ts && git commit -m "feat(server): wire SessionRegistry into ws + http; export surface"`

---

## Self-review checklist

- **Spec coverage (§3–6):** registry of sessions ✔; per-session controller gating ✔; takeover (epoch++ / resize / redraw / controllerChanged+geometry) scoped to one session ✔; frame routing isolation ✔; create/resume/kill + server-assigned ids ✔; discovery.scan correlation ✔; persist-on-detach (kill removes; agentExit marks exited+keeps) ✔; `sessionsChanged` on every mutation ✔; `welcome`+snapshot on connect ✔.
- **Type consistency:** `Send<T>` reused; `ClientConn.attached: Set<string>`; tRPC `Context` is `{ registry }`; `createCaller({ registry })` matches; `AgentKind`/`ResumeRef` zod schemas used as tRPC inputs.
- **Isolation test is present and meaningful** (frames for s2 never reach an s1-only client).
- **Gate is package-scoped.** `e2e/` + browser harness update in Phase 6.
- **Known simplification:** `spawnError` surfaces as `status:'exited', exitCode:-1` (reason logged server-side; no error field in `SessionMeta` this increment).
