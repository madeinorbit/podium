# Multiple Sessions — Phase 5: terminal-client SocketHub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single-session `SessionConnection` into a `SocketHub` (owns the one ws, sends `hello`, tracks the server-assigned `clientId`, fans `sessionId`-tagged messages to per-session connections, exposes a `sessions()` observable) plus a hub-backed per-session `SessionConnection` — without regressing the hardened fit-on-connect / keyboard / takeover behavior.

**Architecture:** `SocketHub.attach(sessionId)` returns a `SessionConnection` bound to that session. The hub routes server frames by `sessionId`; the connection sends `sessionId`-tagged input/resize/control. `session-mount` is rewritten to take a hub + sessionId and wire a terminal view to one session. The data plane (hub + connection) is unit-tested with a fake socket; `session-mount` (DOM/xterm) is validated by the **Phase 6 browser e2e**.

**Tech Stack:** TypeScript (ESM, strict), Vitest. Package: `packages/terminal-client`. Depends on `@podium/protocol`.

**Spec:** `docs/superpowers/specs/2026-06-03-multiple-sessions-design.md` §8.

---

## Sequencing note

Package-scoped gate: `bun run --filter @podium/terminal-client test|typecheck|build` + `bun run lint`.
The package's `*.test.ts` run via root vitest today; Task 1 adds a `test` script (+ `vitest` devDep)
so the filtered gate works. **`session-mount.ts` / `terminal-view.ts` / `toolbar.ts` / `dom-viewport.ts`
are DOM/xterm code with no unit tests — they only need to TYPECHECK + BUILD this phase; their behavior
(fit-on-connect, keyboard, takeover, per-session switching) is proven by the Phase 6 e2e.** `apps/web`
+ `e2e/` still use the old API and stay red until Phase 6 — not a gate. Do NOT run workspace-wide checks.

---

## File structure

- `packages/terminal-client/src/connection.ts` — rewrite: `SocketHub` + hub-backed `SessionConnection`.
- `packages/terminal-client/src/connection.test.ts` — rewrite: unit tests for both (fake socket).
- `packages/terminal-client/src/session-mount.ts` — rewrite: hub-backed single-session mount.
- `packages/terminal-client/src/index.ts` — export `SocketHub` (+ existing).
- `packages/terminal-client/package.json` — add `vitest` devDep + `test` script.

---

### Task 1: Test infra

**Files:** Edit `packages/terminal-client/package.json`.

- [ ] **Step 1:** Add `"test": "vitest run --passWithNoTests"` to `scripts`; add `"vitest": "^4.1.8"` to `devDependencies` if absent; `bun install`.
- [ ] **Step 2: Commit** — `git add packages/terminal-client/package.json bun.lock && git commit -m "chore(terminal-client): add vitest + test script"`

---

### Task 2: SocketHub + hub-backed SessionConnection

**Files:** Rewrite `connection.ts`; rewrite `connection.test.ts`.

- [ ] **Step 1: Write the failing tests** — `packages/terminal-client/src/connection.test.ts`:

```ts
import { type ServerMessage, encode } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SocketHub, type WebSocketLike } from './connection'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  recv(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

function setup() {
  const sock = new FakeSocket()
  const hub = new SocketHub({
    url: 'ws://x',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    makeSocket: () => sock,
  })
  return { sock, hub }
}
const b64 = (s: string): string => btoa(s)

describe('SocketHub', () => {
  it('sends hello with the viewport on open', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    expect(sock.parsed()).toContainEqual({
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
  })

  it('captures the server-assigned clientId from welcome', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })
    expect(hub.clientId).toBe('c0')
  })

  it('exposes sessionsChanged via sessions() + onSessions', () => {
    const { sock, hub } = setup()
    const seen: number[] = []
    hub.onSessions((s) => seen.push(s.length))
    hub.connect()
    sock.open()
    const meta = {
      sessionId: 's1', agentKind: 'claude-code' as const, title: 't', cwd: '/w',
      status: 'live' as const, controllerId: 'c0', geometry: { cols: 80, rows: 24 },
      epoch: 0, clientCount: 1, createdAt: '2026-06-03T00:00:00.000Z', origin: { kind: 'spawn' as const },
    }
    sock.recv({ type: 'sessionsChanged', sessions: [meta] })
    expect(hub.sessions()).toEqual([meta])
    expect(seen.at(-1)).toBe(1)
  })

  it('attach sends an attach message and returns a SessionConnection', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const conn = hub.attach('s1')
    expect(conn.sessionId).toBe('s1')
    expect(sock.parsed()).toContainEqual({ type: 'attach', sessionId: 's1' })
  })

  it('re-sends attach for existing connections on reconnect (open)', () => {
    const { sock, hub } = setup()
    hub.attach('s1') // attached before connect
    hub.connect()
    sock.open()
    expect(sock.parsed().filter((m) => m.type === 'attach')).toContainEqual({ type: 'attach', sessionId: 's1' })
  })

  it('routes frames to the matching session only (isolation)', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })
    const f1: string[] = []
    const f2: string[] = []
    hub.attach('s1', { onFrame: (t) => f1.push(t) })
    hub.attach('s2', { onFrame: (t) => f2.push(t) })
    sock.recv({ type: 'outputFrame', sessionId: 's1', seq: 0, epoch: 0, data: b64('one') })
    sock.recv({ type: 'outputFrame', sessionId: 's2', seq: 0, epoch: 0, data: b64('two') })
    expect(f1).toEqual(['one'])
    expect(f2).toEqual(['two'])
  })

  it('drops session-scoped messages for unknown sessions without throwing', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    expect(() =>
      sock.recv({ type: 'outputFrame', sessionId: 'ghost', seq: 0, epoch: 0, data: b64('x') }),
    ).not.toThrow()
  })
})

describe('SessionConnection (hub-backed)', () => {
  it('computes role from the hub clientId vs the session controllerId', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })
    const conn = hub.attach('s1')
    sock.recv({ type: 'attached', sessionId: 's1', controllerId: 'c0', geometry: { cols: 90, rows: 30 }, epoch: 0 })
    expect(conn.state()).toMatchObject({ role: 'controller', cols: 90, rows: 30, controllerId: 'c0' })
    sock.recv({ type: 'controllerChanged', sessionId: 's1', controllerId: 'c9', geometry: { cols: 90, rows: 30 } })
    expect(conn.state().role).toBe('spectator')
  })

  it('tags input/resize/requestControl/redraw with the sessionId', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const conn = hub.attach('s1')
    conn.sendInput('x')
    conn.sendResize(120, 40)
    conn.requestControl()
    conn.redraw()
    const sent = sock.parsed()
    expect(sent).toContainEqual({ type: 'input', sessionId: 's1', data: b64('x') })
    expect(sent).toContainEqual({ type: 'resize', sessionId: 's1', cols: 120, rows: 40 })
    expect(sent).toContainEqual({ type: 'requestControl', sessionId: 's1' })
    expect(sent).toContainEqual({ type: 'redrawRequest', sessionId: 's1' })
  })

  it('updates lastSeq/epoch and emits the decoded frame', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const frames: string[] = []
    const conn = hub.attach('s1', { onFrame: (t) => frames.push(t) })
    sock.recv({ type: 'outputFrame', sessionId: 's1', seq: 5, epoch: 2, data: b64('hello') })
    expect(frames).toEqual(['hello'])
    expect(conn.state()).toMatchObject({ lastSeq: 5, epoch: 2 })
  })
})
```

- [ ] **Step 2: Run, verify fail** — `bun run --filter @podium/terminal-client test` → FAIL (no `SocketHub`).

- [ ] **Step 3: Implement** — replace `connection.ts` entirely:

```ts
import { encode, parseServerMessage, type ServerMessage, type SessionMeta } from '@podium/protocol'

export interface WebSocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
}

export interface ConnectionViewport {
  cols: number
  rows: number
  dpr: number
}

export interface ConnectionState {
  connected: boolean
  clientId: string
  controllerId: string | null
  sessionId: string
  role: 'controller' | 'spectator'
  cols: number
  rows: number
  epoch: number
  lastSeq: number
}

export interface SessionCallbacks {
  onFrame?: (text: string) => void
  onState?: (state: ConnectionState) => void
}

export interface SocketHubOptions {
  url: string
  viewport: ConnectionViewport
  makeSocket?: (url: string) => WebSocketLike
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64Utf8(b64: string): string {
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/** One ws, multiplexed across N sessions. Owns the connection + server-assigned clientId. */
export class SocketHub {
  private readonly opts: SocketHubOptions
  private readonly makeSocket: (url: string) => WebSocketLike
  private socket: WebSocketLike | undefined
  private connectedFlag = false
  private clientIdValue = ''
  private sessionList: SessionMeta[] = []
  private readonly connections = new Map<string, SessionConnection>()
  private readonly sessionObservers = new Set<(s: SessionMeta[]) => void>()

  constructor(opts: SocketHubOptions) {
    this.opts = opts
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
  }

  get connected(): boolean {
    return this.connectedFlag
  }
  get clientId(): string {
    return this.clientIdValue
  }

  connect(): void {
    if (this.socket !== undefined) return
    const socket = this.makeSocket(this.opts.url)
    this.socket = socket
    socket.onopen = () => {
      this.connectedFlag = true
      this.sendRaw({ type: 'hello', clientId: this.clientIdValue, viewport: { ...this.opts.viewport } })
      for (const sessionId of this.connections.keys()) this.sendRaw({ type: 'attach', sessionId })
      this.notifyConnections()
    }
    socket.onmessage = (ev) => this.route(String(ev.data))
    socket.onclose = () => {
      this.connectedFlag = false
      this.notifyConnections()
    }
  }

  attach(sessionId: string, cb: SessionCallbacks = {}): SessionConnection {
    let conn = this.connections.get(sessionId)
    if (conn === undefined) {
      conn = new SessionConnection(this, sessionId, cb, this.opts.viewport)
      this.connections.set(sessionId, conn)
      if (this.connectedFlag) this.sendRaw({ type: 'attach', sessionId })
    } else {
      conn.setCallbacks(cb)
    }
    return conn
  }

  detach(sessionId: string): void {
    if (this.connections.delete(sessionId) && this.connectedFlag) {
      this.sendRaw({ type: 'detach', sessionId })
    }
  }

  sessions(): SessionMeta[] {
    return this.sessionList
  }

  onSessions(cb: (s: SessionMeta[]) => void): () => void {
    this.sessionObservers.add(cb)
    cb(this.sessionList)
    return () => this.sessionObservers.delete(cb)
  }

  /** Used by SessionConnection to send its sessionId-tagged messages. */
  send(msg: Parameters<typeof encode>[0]): void {
    this.sendRaw(msg)
  }

  dispose(): void {
    this.socket?.close()
    this.socket = undefined
    this.connectedFlag = false
    this.notifyConnections()
  }

  private route(raw: string): void {
    let msg: ServerMessage
    try {
      msg = parseServerMessage(raw)
    } catch {
      return
    }
    if (msg.type === 'welcome') {
      this.clientIdValue = msg.clientId
      this.notifyConnections()
      return
    }
    if (msg.type === 'sessionsChanged') {
      this.sessionList = msg.sessions
      for (const o of this.sessionObservers) o(this.sessionList)
      return
    }
    this.connections.get(msg.sessionId)?.ingest(msg)
  }

  private notifyConnections(): void {
    for (const c of this.connections.values()) c.notifyHubChange()
  }

  private sendRaw(msg: Parameters<typeof encode>[0]): void {
    this.socket?.send(encode(msg))
  }
}

/** A per-session view of the hub: tagged sends + the session's authoritative state. */
export class SessionConnection {
  readonly sessionId: string
  private readonly hub: SocketHub
  private cb: SessionCallbacks
  private controllerId: string | null = null
  private cols: number
  private rows: number
  private epoch = 0
  private lastSeq = -1

  constructor(hub: SocketHub, sessionId: string, cb: SessionCallbacks, viewport: ConnectionViewport) {
    this.hub = hub
    this.sessionId = sessionId
    this.cb = cb
    this.cols = viewport.cols
    this.rows = viewport.rows
  }

  setCallbacks(cb: SessionCallbacks): void {
    this.cb = cb
  }

  sendInput(bytes: string): void {
    this.hub.send({ type: 'input', sessionId: this.sessionId, data: utf8ToBase64(bytes) })
  }

  sendResize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.hub.send({ type: 'resize', sessionId: this.sessionId, cols, rows })
  }

  requestControl(): void {
    this.hub.send({ type: 'requestControl', sessionId: this.sessionId })
  }

  redraw(): void {
    this.hub.send({ type: 'redrawRequest', sessionId: this.sessionId })
  }

  state(): ConnectionState {
    const clientId = this.hub.clientId
    return {
      connected: this.hub.connected,
      clientId,
      controllerId: this.controllerId,
      sessionId: this.sessionId,
      role: clientId !== '' && clientId === this.controllerId ? 'controller' : 'spectator',
      cols: this.cols,
      rows: this.rows,
      epoch: this.epoch,
      lastSeq: this.lastSeq,
    }
  }

  /** Hub-internal: apply a session-scoped server message. */
  ingest(msg: ServerMessage): void {
    switch (msg.type) {
      case 'attached':
        this.controllerId = msg.controllerId
        this.cols = msg.geometry.cols
        this.rows = msg.geometry.rows
        this.epoch = msg.epoch
        this.emit()
        break
      case 'outputFrame':
        this.lastSeq = msg.seq
        this.epoch = msg.epoch
        this.emit()
        this.cb.onFrame?.(fromBase64Utf8(msg.data))
        break
      case 'controllerChanged':
        this.controllerId = msg.controllerId
        this.cols = msg.geometry.cols
        this.rows = msg.geometry.rows
        this.emit()
        break
      case 'geometry':
        this.cols = msg.cols
        this.rows = msg.rows
        this.emit()
        break
      case 'agentExit':
        this.emit()
        break
      default:
        break
    }
  }

  /** Hub-internal: connection/clientId changed → recompute role. */
  notifyHubChange(): void {
    this.emit()
  }

  private emit(): void {
    this.cb.onState?.(this.state())
  }
}
```

- [ ] **Step 4: Run, verify pass** — `bun run --filter @podium/terminal-client test` → PASS (hub + connection; plus existing keys/viewport tests).
- [ ] **Step 5: Commit** — `git add packages/terminal-client/src/connection.ts packages/terminal-client/src/connection.test.ts && git commit -m "feat(terminal-client): SocketHub multiplexer + hub-backed SessionConnection"`

---

### Task 3: Rewrite session-mount + exports

**Files:** Rewrite `session-mount.ts`; edit `index.ts`.

These are DOM/xterm-coupled (no unit tests) — they must TYPECHECK + BUILD; behavior is proven by the Phase 6 e2e. Preserve the hardened semantics exactly: fit-on-connect when becoming controller, `view.onData` → `sendInput`, controller-gated viewport resize, and the `simulateKeyboard` test hook.

- [ ] **Step 1: Rewrite `session-mount.ts`:**

```ts
import { type ConnectionState, type SessionConnection, SocketHub } from './connection'
import { DomViewportSource } from './dom-viewport'
import { TerminalView } from './terminal-view'
import { mountKeyToolbar } from './toolbar'

export interface MountSessionOptions {
  hub: SocketHub
  sessionId: string
  toolbarEl?: HTMLElement
  test?: boolean
  onState?: (state: ConnectionState) => void
}

export interface MountedSession {
  connection: SessionConnection
  view: TerminalView
  dispose(): void
}

export function mountSession(el: HTMLElement, opts: MountSessionOptions): MountedSession {
  const { hub, sessionId } = opts
  const view = new TerminalView()
  view.mount(el)
  const fitted = view.fit()

  let wasController = false
  let onControllerEnter: (() => void) | undefined

  const connection = hub.attach(sessionId, {
    onFrame: (text) => view.write(text),
    onState: (state) => {
      if (view.cols() !== state.cols || view.rows() !== state.rows) {
        view.resize(state.cols, state.rows)
      }
      el.dataset.role = state.role
      el.dataset.epoch = String(state.epoch)
      if (state.role === 'controller') {
        if (!wasController) {
          wasController = true
          onControllerEnter?.()
        }
      } else {
        wasController = false
      }
      opts.onState?.(state)
    },
  })
  // The terminal was created at `fitted`; make sure the agent matches our viewport.
  connection.sendResize(fitted.cols, fitted.rows)

  // On becoming controller, fit the terminal to THIS client's viewport and tell the agent.
  // The initial layout resize fires before we are made controller, so without this the
  // session would stay at the daemon's initial grid.
  onControllerEnter = () => {
    requestAnimationFrame(() => {
      const s = connection.state()
      if (s.role !== 'controller') return
      const grid = view.fit()
      if (grid.cols !== s.cols || grid.rows !== s.rows) connection.sendResize(grid.cols, grid.rows)
    })
  }

  const offInput = view.onData((data) => connection.sendInput(data))

  const viewport = new DomViewportSource(el)
  const offViewport = viewport.onChange(() => {
    if (connection.state().role !== 'controller') return
    const grid = view.fit()
    connection.sendResize(grid.cols, grid.rows)
  })

  const offToolbar = opts.toolbarEl ? mountKeyToolbar(opts.toolbarEl, connection) : () => {}

  view.focus()

  if (opts.test) {
    ;(globalThis as unknown as { __podium?: unknown }).__podium = {
      state: () => connection.state(),
      screenHash: () => view.screenHash(),
      screenText: () => view.screenText(),
      sendInput: (s: string) => connection.sendInput(s),
      takeControl: () => connection.requestControl(),
      sessions: () => hub.sessions(),
      attach: (id: string) => hub.attach(id),
      simulateKeyboard: (inset: number) => {
        if (inset > 0) {
          const currentH = el.getBoundingClientRect().height
          const effectiveInset = Math.max(inset, Math.ceil(currentH * 0.5))
          const newH = `${Math.max(1, currentH - effectiveInset)}px`
          el.style.flex = 'none'
          el.style.height = newH
          void el.offsetHeight
        } else {
          el.style.flex = ''
          el.style.height = ''
          void el.offsetHeight
        }
        const grid = view.fit()
        connection.sendResize(grid.cols, grid.rows)
      },
    }
  }

  return {
    connection,
    view,
    dispose() {
      offInput()
      offViewport()
      offToolbar()
      viewport.dispose()
      hub.detach(sessionId)
      view.dispose()
    },
  }
}
```

Note vs the old mount: the hub owns `connect()`/socket lifecycle (the web app calls `hub.connect()`); `mountSession` no longer connects. `dispose()` detaches the session instead of closing the socket. `__podium` gains `sessions()` + `attach(id)`.

- [ ] **Step 2: Edit `index.ts`** — ensure `SocketHub` is exported alongside the existing surface. If it uses explicit exports, add `SocketHub`, `SessionConnection`, `SocketHubOptions`, `SessionCallbacks`, `ConnectionState`, `ConnectionViewport`, `WebSocketLike`, `mountSession`, `MountSessionOptions`, `MountedSession`. (Read the file and match its style.)

- [ ] **Step 3: Package gate**
  - `bun run --filter @podium/terminal-client test` → pass.
  - `bun run --filter @podium/terminal-client typecheck` → exit 0 (session-mount/terminal-view/toolbar compile against the new API).
  - `bun run --filter @podium/terminal-client build` → exit 0 (tsup ESM + DTS).
  - `bun run lint` → clean (run `bun run format` first if Biome would reformat).

- [ ] **Step 4: Commit** — `git add packages/terminal-client/src/session-mount.ts packages/terminal-client/src/index.ts && git commit -m "feat(terminal-client): hub-backed session mount + sessions()/attach() observability"`

---

## Self-review checklist

- **Spec coverage (§8):** `SocketHub` owns one ws + `hello` + `clientId`; `attach(sessionId)` → `SessionConnection`; routes `sessionId`-tagged frames; `sessions()` + `onSessions` from `sessionsChanged`; per-session `SessionConnection` API stable (`sendInput`/`sendResize`/`requestControl`/`redraw`/`state`); tRPC/UI stay out (web's job); `__podium` gains `sessions()`/`attach()`. ✔
- **No regression by construction:** the `session-mount` onState logic (view resize to authoritative geometry, `data-role`/`data-epoch`, controller-enter rAF fit), `view.onData`→`sendInput`, controller-gated viewport resize, and `simulateKeyboard` are carried over verbatim — only the connection source (hub.attach) and lifecycle (detach vs socket close) changed.
- **Isolation tested:** a frame for s1 reaches only s1's connection.
- **Role correctness:** computed from `hub.clientId` vs the session's `controllerId`; recomputed on welcome (clientId) and on controllerChanged.
- **Gate is package-scoped; session-mount behavior validated by the Phase 6 e2e.**
