# Handover & Input Prototype — Phase 3a: terminal-client core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the framework-agnostic, render-free core of `@podium/terminal-client`: a `SessionConnection` (WebSocket transport speaking `@podium/protocol`, with observable client state: role / cols / rows / epoch / lastSeq / connected), an injectable `ViewportSource` seam + `computeGrid`, and a key→bytes encoder for the mobile toolbar — all unit-tested in node with a fake socket (no browser, no new deps).

**Architecture:** `SessionConnection` is the client-side counterpart of the server's `RelayHub`: it owns the connection state machine and emits decoded frame text + state changes via callbacks. It is transport-injectable (`makeSocket`) so it runs identically in a browser (default `new WebSocket`) and in node tests (a fake). xterm rendering, the toolbar UI, controller/spectator letterboxing, the DOM `ViewportSource`, the React/Vite app, and Playwright browser tests are all **Phase 3b**.

**Tech Stack:** TypeScript (strict ESM, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, DOM lib) · `@podium/protocol` · Vitest (node env) · Biome (single quotes, no semicolons, 2-space, 100 col). **No new runtime dependencies.**

---

## Phase 3 roadmap (this plan is 3a)

- **3a — terminal-client core (transport + state + viewport seam + key encoder). ← THIS PLAN.** Unit-tested, no browser.
- **3b — xterm rendering + mobile toolbar + controller/spectator letterbox + DOM ViewportSource + `apps/web` (React+Vite) + Playwright Tier-1/2 e2e (Chromium [+ WebKit if installable]) + synthetic-keyboard chain + `screenHash` sync assertions.** *Separate plan.*

Design spec: `docs/superpowers/specs/2026-06-01-handover-input-prototype-design.md` (§5 controller/spectator, §7 observability + ViewportSource).

---

## File structure (Phase 3a)

| File | Responsibility |
|------|----------------|
| `packages/terminal-client/src/keys.ts` | `SpecialKey` type, `keySequence(key)`, `ctrlSequence(letter)` — logical keys → terminal byte sequences. |
| `packages/terminal-client/src/keys.test.ts` | Key sequence tests. |
| `packages/terminal-client/src/viewport.ts` | `ViewportSource` interface, `InjectableViewportSource` (test/dev driver: `setSize`, `simulateKeyboard`), `computeGrid(px, cell)`. |
| `packages/terminal-client/src/viewport.test.ts` | Viewport seam + grid math tests. |
| `packages/terminal-client/src/connection.ts` | `WebSocketLike`, `ConnectionState`, `SessionConnection` (transport + state machine) + base64/utf8 codec helpers. |
| `packages/terminal-client/src/connection.test.ts` | `SessionConnection` tests with a fake socket. |
| `packages/terminal-client/src/index.ts` | Public surface (re-exports). |

`packages/terminal-client/tsconfig.json` should already extend `../../tooling/tsconfig/dom.json` (Task 1 confirms). Tests run under Vitest's default node env (Node 22 provides `btoa`/`atob`/`TextDecoder` globals; a fake socket is injected so no real `WebSocket` is used).

---

## Task 1: key→bytes encoder

**Files:**
- Create: `packages/terminal-client/src/keys.ts`
- Create: `packages/terminal-client/src/keys.test.ts`
- Confirm: `packages/terminal-client/tsconfig.json`

- [ ] **Step 1: Confirm tsconfig**

Ensure `packages/terminal-client/tsconfig.json` extends the DOM base. It should read:

```json
{
  "extends": "../../tooling/tsconfig/dom.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "ignoreDeprecations": "6.0"
  },
  "include": ["src"]
}
```

If it differs (e.g. missing `outDir`/`rootDir`), update it to the above.

- [ ] **Step 2: Write the failing test**

Create `packages/terminal-client/src/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ctrlSequence, keySequence } from './keys'

describe('key sequences', () => {
  it('maps named keys to terminal byte sequences', () => {
    expect(keySequence('Escape')).toBe('\x1b')
    expect(keySequence('Tab')).toBe('\t')
    expect(keySequence('Enter')).toBe('\r')
    expect(keySequence('Backspace')).toBe('\x7f')
    expect(keySequence('ArrowUp')).toBe('\x1b[A')
    expect(keySequence('ArrowDown')).toBe('\x1b[B')
    expect(keySequence('ArrowRight')).toBe('\x1b[C')
    expect(keySequence('ArrowLeft')).toBe('\x1b[D')
  })

  it('maps Ctrl+letter to control codes', () => {
    expect(ctrlSequence('c')).toBe('\x03')
    expect(ctrlSequence('C')).toBe('\x03')
    expect(ctrlSequence('d')).toBe('\x04')
    expect(ctrlSequence('l')).toBe('\x0c')
    expect(ctrlSequence('a')).toBe('\x01')
  })

  it('throws on a non-letter ctrl target', () => {
    expect(() => ctrlSequence('1')).toThrow()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `bunx vitest run packages/terminal-client/src/keys.test.ts`
Expected: FAIL — cannot resolve `./keys`.

- [ ] **Step 4: Implement**

Create `packages/terminal-client/src/keys.ts`:

```ts
export type SpecialKey =
  | 'Escape'
  | 'Tab'
  | 'Enter'
  | 'Backspace'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowRight'
  | 'ArrowLeft'

const SEQUENCES: Record<SpecialKey, string> = {
  Escape: '\x1b',
  Tab: '\t',
  Enter: '\r',
  Backspace: '\x7f',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
}

export function keySequence(key: SpecialKey): string {
  return SEQUENCES[key]
}

/** Ctrl+<letter> → the corresponding C0 control code (e.g. 'c' → 0x03). */
export function ctrlSequence(letter: string): string {
  const lower = letter.toLowerCase()
  const code = lower.charCodeAt(0)
  if (lower.length !== 1 || code < 97 || code > 122) {
    throw new Error(`ctrlSequence expects a single a–z letter, got: ${letter}`)
  }
  return String.fromCharCode(code - 96)
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bunx vitest run packages/terminal-client/src/keys.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/terminal-client/src/keys.ts packages/terminal-client/src/keys.test.ts packages/terminal-client/tsconfig.json
git commit -m "feat(terminal-client): key->bytes encoder for the mobile toolbar"
```

---

## Task 2: ViewportSource seam + computeGrid

**Files:**
- Create: `packages/terminal-client/src/viewport.ts`
- Create: `packages/terminal-client/src/viewport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/terminal-client/src/viewport.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { computeGrid, InjectableViewportSource } from './viewport'

describe('computeGrid', () => {
  it('floors pixel size by cell size into cols x rows (min 1)', () => {
    expect(computeGrid({ width: 800, height: 480 }, { width: 10, height: 20 })).toEqual({ cols: 80, rows: 24 })
    expect(computeGrid({ width: 805, height: 489 }, { width: 10, height: 20 })).toEqual({ cols: 80, rows: 24 })
    expect(computeGrid({ width: 5, height: 5 }, { width: 10, height: 20 })).toEqual({ cols: 1, rows: 1 })
  })
})

describe('InjectableViewportSource', () => {
  it('reports current size and notifies on change', () => {
    const vp = new InjectableViewportSource({ width: 800, height: 480, dpr: 2 })
    expect(vp.current()).toEqual({ width: 800, height: 480, dpr: 2 })
    const seen: { width: number; height: number; dpr: number }[] = []
    const off = vp.onChange((v) => seen.push(v))
    vp.setSize(400, 300)
    expect(vp.current()).toEqual({ width: 400, height: 300, dpr: 2 })
    expect(seen.at(-1)).toEqual({ width: 400, height: 300, dpr: 2 })
    off()
    vp.setSize(100, 100)
    expect(seen).toHaveLength(1) // unsubscribed
  })

  it('simulateKeyboard shrinks height by the inset and notifies, restore brings it back', () => {
    const vp = new InjectableViewportSource({ width: 400, height: 800, dpr: 3 })
    const seen: number[] = []
    vp.onChange((v) => seen.push(v.height))
    vp.simulateKeyboard(300)
    expect(vp.current().height).toBe(500)
    vp.simulateKeyboard(0)
    expect(vp.current().height).toBe(800)
    expect(seen).toEqual([500, 800])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run packages/terminal-client/src/viewport.test.ts`
Expected: FAIL — cannot resolve `./viewport`.

- [ ] **Step 3: Implement**

Create `packages/terminal-client/src/viewport.ts`:

```ts
export interface ViewportSize {
  width: number
  height: number
  dpr: number
}

export interface CellSize {
  width: number
  height: number
}

export interface Grid {
  cols: number
  rows: number
}

/** Floor a pixel viewport by cell size into a terminal grid (at least 1x1). */
export function computeGrid(px: { width: number; height: number }, cell: CellSize): Grid {
  const cols = Math.max(1, Math.floor(px.width / cell.width))
  const rows = Math.max(1, Math.floor(px.height / cell.height))
  return { cols, rows }
}

/**
 * The seam between the host viewport and the terminal grid. Production wraps
 * `visualViewport` (Phase 3b); this injectable impl drives it deterministically in
 * tests — including the soft-keyboard inset that no headless browser fires faithfully.
 */
export interface ViewportSource {
  current(): ViewportSize
  onChange(cb: (size: ViewportSize) => void): () => void
  dispose(): void
}

export class InjectableViewportSource implements ViewportSource {
  private size: ViewportSize
  private baseHeight: number
  private readonly cbs = new Set<(size: ViewportSize) => void>()

  constructor(initial: ViewportSize) {
    this.size = { ...initial }
    this.baseHeight = initial.height
  }

  current(): ViewportSize {
    return { ...this.size }
  }

  onChange(cb: (size: ViewportSize) => void): () => void {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }

  setSize(width: number, height: number): void {
    this.size = { ...this.size, width, height }
    this.baseHeight = height
    this.emit()
  }

  /** Reproduce a soft keyboard taking `inset` px off the bottom (0 = keyboard closed). */
  simulateKeyboard(inset: number): void {
    this.size = { ...this.size, height: this.baseHeight - inset }
    this.emit()
  }

  dispose(): void {
    this.cbs.clear()
  }

  private emit(): void {
    for (const cb of [...this.cbs]) cb(this.current())
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run packages/terminal-client/src/viewport.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/terminal-client/src/viewport.ts packages/terminal-client/src/viewport.test.ts
git commit -m "feat(terminal-client): injectable ViewportSource seam + computeGrid"
```

---

## Task 3: SessionConnection (transport + state machine)

**Files:**
- Create: `packages/terminal-client/src/connection.ts`
- Create: `packages/terminal-client/src/connection.test.ts`
- Modify: `packages/terminal-client/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/terminal-client/src/connection.test.ts`:

```ts
import { encode, parseClientMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionConnection, type WebSocketLike } from './connection'

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  readonly sent: string[] = []
  closed = false
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.onclose?.({})
  }
  // test helpers
  open(): void {
    this.onopen?.({})
  }
  deliver(serverMsgJson: string): void {
    this.onmessage?.({ data: serverMsgJson })
  }
  sentClient(): ReturnType<typeof parseClientMessage>[] {
    return this.sent.map((s) => parseClientMessage(s))
  }
}

function connect() {
  const sock = new FakeSocket()
  const frames: string[] = []
  const conn = new SessionConnection({
    url: 'ws://test/client',
    viewport: { cols: 80, rows: 24, dpr: 2 },
    makeSocket: () => sock,
    onFrame: (text) => frames.push(text),
  })
  conn.connect()
  sock.open()
  return { sock, conn, frames }
}

describe('SessionConnection', () => {
  it('sends hello + redrawRequest on open and marks connected', () => {
    const { sock, conn } = connect()
    const sent = sock.sentClient()
    expect(sent[0]).toEqual({ type: 'hello', clientId: '', viewport: { cols: 80, rows: 24, dpr: 2 } })
    expect(sent.some((m) => m.type === 'redrawRequest')).toBe(true)
    expect(conn.state().connected).toBe(true)
  })

  it('adopts identity + role=controller from welcome when it is the controller', () => {
    const { sock, conn } = connect()
    sock.deliver(
      encode({ type: 'welcome', clientId: 'c0', sessionId: 's1', controllerId: 'c0', geometry: { cols: 100, rows: 30 } }),
    )
    const s = conn.state()
    expect(s.clientId).toBe('c0')
    expect(s.sessionId).toBe('s1')
    expect(s.controllerId).toBe('c0')
    expect(s.role).toBe('controller')
    expect(s).toMatchObject({ cols: 100, rows: 30 })
  })

  it('decodes outputFrame data to utf8 and tracks seq + epoch', () => {
    const { sock, conn, frames } = connect()
    sock.deliver(encode({ type: 'welcome', clientId: 'c0', sessionId: 's1', controllerId: 'c0', geometry: { cols: 80, rows: 24 } }))
    sock.deliver(encode({ type: 'outputFrame', seq: 7, epoch: 2, data: 'aGVsbG8=' })) // "hello"
    expect(frames.at(-1)).toBe('hello')
    expect(conn.state().lastSeq).toBe(7)
    expect(conn.state().epoch).toBe(2)
  })

  it('becomes spectator when controllerChanged names another client', () => {
    const { sock, conn } = connect()
    sock.deliver(encode({ type: 'welcome', clientId: 'c0', sessionId: 's1', controllerId: 'c0', geometry: { cols: 80, rows: 24 } }))
    sock.deliver(encode({ type: 'controllerChanged', controllerId: 'c1', geometry: { cols: 40, rows: 30 } }))
    const s = conn.state()
    expect(s.role).toBe('spectator')
    expect(s.controllerId).toBe('c1')
    expect(s).toMatchObject({ cols: 40, rows: 30 })
  })

  it('updates geometry on a geometry message', () => {
    const { sock, conn } = connect()
    sock.deliver(encode({ type: 'geometry', cols: 120, rows: 50 }))
    expect(conn.state()).toMatchObject({ cols: 120, rows: 50 })
  })

  it('sendInput base64-encodes bytes into an input message', () => {
    const { sock, conn } = connect()
    conn.sendInput('a') // 0x61
    const input = sock.sentClient().find((m) => m.type === 'input')
    expect(input).toEqual({ type: 'input', data: 'YQ==' })
  })

  it('sendResize, requestControl, redraw emit the right client messages', () => {
    const { sock, conn } = connect()
    conn.sendResize(120, 40)
    conn.requestControl()
    conn.redraw()
    const types = sock.sentClient().map((m) => m.type)
    expect(sock.sentClient()).toContainEqual({ type: 'resize', cols: 120, rows: 40 })
    expect(types).toContain('requestControl')
    expect(types.filter((t) => t === 'redrawRequest').length).toBeGreaterThanOrEqual(2) // open + explicit
  })

  it('marks disconnected on close', () => {
    const { sock, conn } = connect()
    conn.dispose()
    expect(sock.closed).toBe(true)
    expect(conn.state().connected).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run packages/terminal-client/src/connection.test.ts`
Expected: FAIL — cannot resolve `./connection`.

- [ ] **Step 3: Implement**

Create `packages/terminal-client/src/connection.ts`:

```ts
import { encode, parseServerMessage } from '@podium/protocol'

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
  controllerId: string
  sessionId: string
  role: 'controller' | 'spectator'
  cols: number
  rows: number
  epoch: number
  lastSeq: number
}

export interface SessionConnectionOptions {
  url: string
  viewport: ConnectionViewport
  makeSocket?: (url: string) => WebSocketLike
  onFrame?: (text: string) => void
  onState?: (state: ConnectionState) => void
}

function toBase64(bytes: string): string {
  return btoa(bytes)
}

function fromBase64Utf8(b64: string): string {
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export class SessionConnection {
  private readonly opts: SessionConnectionOptions
  private readonly makeSocket: (url: string) => WebSocketLike
  private socket: WebSocketLike | undefined
  private viewport: ConnectionViewport
  private connected = false
  private clientId = ''
  private controllerId = ''
  private sessionId = ''
  private cols: number
  private rows: number
  private epoch = 0
  private lastSeq = -1

  constructor(opts: SessionConnectionOptions) {
    this.opts = opts
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
    this.viewport = { ...opts.viewport }
    this.cols = opts.viewport.cols
    this.rows = opts.viewport.rows
  }

  connect(): void {
    const socket = this.makeSocket(this.opts.url)
    this.socket = socket
    socket.onopen = () => {
      this.connected = true
      this.sendRaw({ type: 'hello', clientId: this.clientId, viewport: { ...this.viewport } })
      this.sendRaw({ type: 'redrawRequest' })
      this.emitState()
    }
    socket.onmessage = (ev) => this.onServerMessage(String(ev.data))
    socket.onclose = () => {
      this.connected = false
      this.emitState()
    }
  }

  sendInput(bytes: string): void {
    this.sendRaw({ type: 'input', data: toBase64(bytes) })
  }

  sendResize(cols: number, rows: number): void {
    this.viewport = { ...this.viewport, cols, rows }
    this.cols = cols
    this.rows = rows
    this.sendRaw({ type: 'resize', cols, rows })
  }

  requestControl(): void {
    this.sendRaw({ type: 'requestControl' })
  }

  redraw(): void {
    this.sendRaw({ type: 'redrawRequest' })
  }

  state(): ConnectionState {
    return {
      connected: this.connected,
      clientId: this.clientId,
      controllerId: this.controllerId,
      sessionId: this.sessionId,
      role: this.clientId !== '' && this.clientId === this.controllerId ? 'controller' : 'spectator',
      cols: this.cols,
      rows: this.rows,
      epoch: this.epoch,
      lastSeq: this.lastSeq,
    }
  }

  dispose(): void {
    this.socket?.close()
    this.socket = undefined
    this.connected = false
    this.emitState()
  }

  private onServerMessage(raw: string): void {
    let msg: ReturnType<typeof parseServerMessage>
    try {
      msg = parseServerMessage(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'welcome':
        this.clientId = msg.clientId
        this.sessionId = msg.sessionId
        this.controllerId = msg.controllerId
        this.cols = msg.geometry.cols
        this.rows = msg.geometry.rows
        break
      case 'outputFrame':
        this.lastSeq = msg.seq
        this.epoch = msg.epoch
        this.opts.onFrame?.(fromBase64Utf8(msg.data))
        break
      case 'controllerChanged':
        this.controllerId = msg.controllerId
        this.cols = msg.geometry.cols
        this.rows = msg.geometry.rows
        break
      case 'geometry':
        this.cols = msg.cols
        this.rows = msg.rows
        break
      case 'agentExit':
        break
    }
    this.emitState()
  }

  private sendRaw(msg: Parameters<typeof encode>[0]): void {
    this.socket?.send(encode(msg))
  }

  private emitState(): void {
    this.opts.onState?.(this.state())
  }
}
```

Replace `packages/terminal-client/src/index.ts` ENTIRELY with:

```ts
/**
 * @podium/terminal-client — browser presentation client. Phase 3a: the framework-
 * agnostic core (connection state machine, viewport seam, key encoder). Rendering,
 * the mobile toolbar, and the DOM viewport source land in Phase 3b.
 */
export * from './connection'
export * from './keys'
export * from './viewport'
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run packages/terminal-client/src/connection.test.ts`
Expected: PASS — 8 passed.

- [ ] **Step 5: Typecheck + build + commit**

Run: `bun run --filter @podium/terminal-client typecheck`
Expected: exit 0.

Run: `bun run --filter @podium/terminal-client build`
Expected: tsup emits `dist/index.js` + `index.d.ts`.

```bash
git add packages/terminal-client/src/connection.ts packages/terminal-client/src/connection.test.ts packages/terminal-client/src/index.ts
git commit -m "feat(terminal-client): SessionConnection transport + observable state"
```

---

## Task 4: Phase 3a green gate

**Files:** none (verification only).

- [ ] **Step 1: Run all terminal-client tests**

Run: `bunx vitest run packages/terminal-client`
Expected: PASS — keys (3) + viewport (3) + connection (8) = 14 passed.

- [ ] **Step 2: Typecheck + build**

Run: `bun run --filter @podium/terminal-client typecheck` → exit 0.
Run: `bun run --filter @podium/terminal-client build` → emits dist + d.ts.

- [ ] **Step 3: Lint**

Run: `bunx biome check packages/terminal-client/src`
Expected: clean (run `bunx biome check --write packages/terminal-client/src` if needed, then re-commit).

- [ ] **Step 4: Phase 3a exit check**

Confirm: `SessionConnection` correctly derives role/geometry/epoch/lastSeq from server messages, sends hello+redrawRequest on open, base64-encodes input, and forwards resize/requestControl/redraw; the `ViewportSource` seam + `simulateKeyboard` + `computeGrid` work; the key encoder maps the toolbar keys. **Next:** Phase 3b (xterm rendering, mobile toolbar, controller/spectator letterbox, DOM ViewportSource, `apps/web`, Playwright Tier-1/2 browser e2e with `screenHash`).

---

## Notes for the executor

- **No new dependencies.** `SessionConnection` uses `@podium/protocol`'s `encode`/`parseServerMessage` (its built dist) and the global `btoa`/`atob`/`TextDecoder`/`WebSocket` (Node 22 + browser). Tests inject a `FakeSocket`, so no real `WebSocket` is opened.
- **Why a `makeSocket` seam:** it lets `SessionConnection` run unchanged in a browser (`new WebSocket`) and in node tests (fake), the same way the server's `RelayHub` is transport-agnostic. The default-arg cast `new WebSocket(url) as unknown as WebSocketLike` bridges the DOM `WebSocket` type to the minimal interface.
- **`role` derivation:** controller iff `clientId !== '' && clientId === controllerId`. Before `welcome`, `clientId` is `''` so role is `spectator` — correct (no control until identified).
- **`lastSeq` starts at -1** so the first real frame (seq 0) is distinguishable from "no frames yet".
- **Encoding:** input bytes are ASCII key sequences (`btoa` is correct); output frames are base64-of-utf8 (decoded via `TextDecoder` so claude's non-ASCII is correct too — not just the ASCII fixture).
- These pieces are consumed by Phase 3b's xterm view + toolbar + `apps/web`; keep the public surface stable.
