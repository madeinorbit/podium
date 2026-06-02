# Handover & Input Prototype — Phase 2b: ws + Hono server + daemon + e2e

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase-2a `RelayHub` to real WebSockets via Hono + `ws`, build the `apps/daemon` that connects `@podium/agent-bridge` to the server, expose a minimal tRPC `session.info` (+ exported `AppRouter` type), and prove the spec's Phase 2 acceptance end-to-end: a real daemon (running the fixture TUI) → real server → raw ws client, with frames flowing, input round-tripping, and takeover bumping `epoch`.

**Architecture:** `apps/server` composes a Hono HTTP app (`/health` + tRPC at `/trpc/*`) served by `@hono/node-server`, with two `ws` WebSocket endpoints (`/daemon`, `/client`) adapted onto the existing transport-agnostic `RelayHub`. `apps/daemon` spawns an `agent-bridge` session and opens a `ws` client to the server's `/daemon`, forwarding frames/exit up and applying control (input/resize/redraw) down. Neither app imports the other; the e2e test in a neutral `e2e/` dir orchestrates both.

**Tech Stack:** Hono · @hono/node-server · ws · @trpc/server · @hono/trpc-server · `@podium/agent-bridge` · `@podium/protocol` (with the Phase-2a `agentFrame`) · Vitest · Biome (single quotes, no semicolons, 2-space, 100 col) · strict ESM TS (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`).

---

## Context (where this builds on)

- Phase 2a (merged on this branch `prototype/phase2-relay`) shipped `@podium/protocol` `agentFrame` and `@podium/server`'s `RelayHub` (transport-agnostic; `attachDaemon`/`attachClient`/`onDaemonMessage`/`onClientMessage`/`detachClient`/`detachDaemon`/`info`). `RelayHub` is exported from `apps/server/src/index.ts`.
- `@podium/protocol` (built dist) exports values `encode`, `parseClientMessage`, `parseDaemonMessage`, `parseControlMessage`, `parseServerMessage` and the message types.
- `@podium/agent-bridge` (built dist) exports `spawnAgent(opts)` → `AgentSession` with `onFrame`, `onExit`, `write`, `resize`, `redraw`, `dispose`, `geometry`, `pid`.
- The deterministic fixture TUI lives at `packages/agent-bridge/test/fixtures/fixture-tui.mjs` (prints `PODIUM-FIXTURE cols=.. rows=.. paint=N` + `last-input=<hex>`; exits 0 on Ctrl-C `0x03`).

Design spec: `docs/superpowers/specs/2026-06-01-handover-input-prototype-design.md` (§3 topology, §4 protocol, §5 handover, §8 acceptance, §9 Phase 2).

---

## File structure (Phase 2b)

| File | Responsibility |
|------|----------------|
| `apps/server/package.json` | Add deps: `hono`, `@hono/node-server`, `@hono/trpc-server`, `@trpc/server`, `ws`; dev `@types/ws`. |
| `apps/server/src/router.ts` | tRPC router (`session.info`) + `Context` + exported `AppRouter` type. |
| `apps/server/src/wsServer.ts` | `attachWebSockets(httpServer, hub)` — `/daemon` + `/client` ws endpoints adapted onto `RelayHub`. |
| `apps/server/src/server.ts` | `startServer({port?})` — Hono app + `serve()` + ws attach; returns `{port, hub, close}`. |
| `apps/server/src/index.ts` | Re-export `relay`, `startServer`, and `type AppRouter`. |
| `apps/server/test/server.test.ts` | HTTP + tRPC test. |
| `apps/server/test/wsServer.test.ts` | ws relay test (raw daemon ws + raw client ws). |
| `apps/server/test/wsTestUtil.ts` | Shared ws test helpers (`openWs`, `waitMessage`). |
| `apps/daemon/package.json` | Add dep `ws`; dev `@types/ws`, `tsx`. |
| `apps/daemon/src/daemon.ts` | `startDaemon(opts)` — agent-bridge ↔ server `/daemon` ws. |
| `apps/daemon/src/index.ts` | Re-export `startDaemon` + types. |
| `apps/daemon/test/daemon.test.ts` | Daemon vs a raw fake server ws. |
| `e2e/relay.e2e.test.ts` | End-to-end: real server + real daemon + raw client (Phase 2 acceptance). |

---

## Task 1: server HTTP app + tRPC `session.info` + `startServer`

**Files:**
- Modify: `apps/server/package.json`
- Create: `apps/server/src/router.ts`
- Create: `apps/server/src/server.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/server/test/server.test.ts`

- [ ] **Step 1: Add dependencies**

Edit `apps/server/package.json` so `dependencies` (currently `@podium/core`, `@podium/protocol`) and `devDependencies` (currently `typescript`) become:

```json
  "dependencies": {
    "@podium/core": "workspace:*",
    "@podium/protocol": "workspace:*",
    "@hono/node-server": "^1.13.7",
    "@hono/trpc-server": "^0.3.4",
    "@trpc/server": "^11.0.0",
    "hono": "^4.6.14",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "@types/ws": "^8.5.13"
  }
```

Run: `bun install`
Expected: resolves with no errors. (If any caret version does not resolve, use the latest compatible release of that package and note it in your report.)

- [ ] **Step 2: Write the failing test**

Create `apps/server/test/server.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { startServer } from '../src/server'

describe('startServer — http + tRPC', () => {
  it('serves /health and tRPC session.info reflecting the hub state', async () => {
    const srv = await startServer()
    try {
      const health = await fetch(`http://localhost:${srv.port}/health`)
      expect(health.status).toBe(200)
      expect(await health.text()).toBe('ok')

      const res = await fetch(`http://localhost:${srv.port}/trpc/session.info`)
      const json = (await res.json()) as { result: { data: { epoch: number; clientCount: number; controllerId: string | null } } }
      expect(json.result.data.epoch).toBe(0)
      expect(json.result.data.clientCount).toBe(0)
      expect(json.result.data.controllerId).toBeNull()
    } finally {
      await srv.close()
    }
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bunx vitest run apps/server/test/server.test.ts`
Expected: FAIL — cannot resolve `../src/server`.

- [ ] **Step 4: Implement the router**

Create `apps/server/src/router.ts`:

```ts
import { initTRPC } from '@trpc/server'
import type { RelayHub, SessionInfo } from './relay'

export interface Context {
  hub: RelayHub
}

const t = initTRPC.context<Context>().create()

export const appRouter = t.router({
  session: t.router({
    info: t.procedure.query(({ ctx }): SessionInfo => ctx.hub.info()),
  }),
})

export type AppRouter = typeof appRouter
```

- [ ] **Step 5: Implement `startServer`**

Create `apps/server/src/server.ts`:

```ts
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { RelayHub } from './relay'
import { appRouter } from './router'

export interface ServerHandle {
  port: number
  hub: RelayHub
  close(): Promise<void>
}

export function startServer(opts: { port?: number } = {}): Promise<ServerHandle> {
  const hub = new RelayHub()
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext: () => ({ hub }) }))

  return new Promise<ServerHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0 }, (info) => {
      resolve({
        port: info.port,
        hub,
        close: () =>
          new Promise<void>((res) => {
            ;(server as unknown as Server).close(() => res())
          }),
      })
    })
  })
}
```

Replace `apps/server/src/index.ts` ENTIRELY with:

```ts
/**
 * @podium/server — relay hub + Hono/ws/tRPC server. Exports the tRPC AppRouter type.
 */
export * from './relay'
export { startServer } from './server'
export type { ServerHandle } from './server'
export type { AppRouter } from './router'
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bunx vitest run apps/server/test/server.test.ts`
Expected: PASS — 1 passed.

- [ ] **Step 7: Typecheck + lint + commit**

Run: `bun run --filter @podium/server typecheck`
Expected: exit 0.

Run: `bunx biome check apps/server/src apps/server/test`
Expected: clean (fix formatting on your files if needed).

```bash
git add apps/server/package.json apps/server/src/router.ts apps/server/src/server.ts apps/server/src/index.ts apps/server/test/server.test.ts bun.lock
git commit -m "feat(server): Hono app + tRPC session.info + startServer"
```

---

## Task 2: WebSocket endpoints (`/daemon`, `/client`) onto `RelayHub`

**Files:**
- Create: `apps/server/src/wsServer.ts`
- Modify: `apps/server/src/server.ts`
- Create: `apps/server/test/wsTestUtil.ts`
- Create: `apps/server/test/wsServer.test.ts`

- [ ] **Step 1: Create shared ws test helpers**

Create `apps/server/test/wsTestUtil.ts`:

```ts
import WebSocket from 'ws'

export function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

export function waitMessage<T>(
  ws: WebSocket,
  parse: (raw: string) => T,
  pred: (msg: T) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('waitMessage: timed out'))
    }, timeoutMs)
    function onMessage(raw: WebSocket.RawData): void {
      let msg: T
      try {
        msg = parse(raw.toString())
      } catch {
        return
      }
      if (pred(msg)) {
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(msg)
      }
    }
    ws.on('message', onMessage)
  })
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/server/test/wsServer.test.ts`:

```ts
import { encode, parseControlMessage, parseServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { startServer } from '../src/server'
import { openWs, waitMessage } from './wsTestUtil'

describe('server WebSocket relay', () => {
  it('relays a daemon agentFrame to a client as an epoch-stamped outputFrame', async () => {
    const srv = await startServer()
    const base = `ws://localhost:${srv.port}`
    const daemon = await openWs(`${base}/daemon`)
    const client = await openWs(`${base}/client`)
    try {
      daemon.send(encode({ type: 'bind', sessionId: 's1', cmd: 'fixture', geometry: { cols: 80, rows: 24 } }))
      const welcome = await waitMessage(client, parseServerMessage, (m) => m.type === 'welcome')
      expect(welcome).toMatchObject({ type: 'welcome', sessionId: 's1' })

      daemon.send(encode({ type: 'agentFrame', seq: 1, data: 'Zm9v' }))
      const frame = await waitMessage(client, parseServerMessage, (m) => m.type === 'outputFrame')
      expect(frame).toEqual({ type: 'outputFrame', seq: 1, epoch: 0, data: 'Zm9v' })
    } finally {
      daemon.close()
      client.close()
      await srv.close()
    }
  })

  it('forwards controller input from a client down to the daemon', async () => {
    const srv = await startServer()
    const base = `ws://localhost:${srv.port}`
    const daemon = await openWs(`${base}/daemon`)
    const client = await openWs(`${base}/client`)
    try {
      daemon.send(encode({ type: 'bind', sessionId: 's1', cmd: 'fixture', geometry: { cols: 80, rows: 24 } }))
      await waitMessage(client, parseServerMessage, (m) => m.type === 'welcome')

      client.send(encode({ type: 'input', data: 'YQ==' }))
      const control = await waitMessage(daemon, parseControlMessage, (m) => m.type === 'input')
      expect(control).toEqual({ type: 'input', data: 'YQ==' })
    } finally {
      daemon.close()
      client.close()
      await srv.close()
    }
  })

  it('ignores upgrades on unknown paths', async () => {
    const srv = await startServer()
    try {
      await expect(openWs(`ws://localhost:${srv.port}/nope`)).rejects.toBeDefined()
    } finally {
      await srv.close()
    }
  })
})
```

(`parseClientMessage` is imported because `wsTestUtil` is generic; it is acceptable if Biome flags it as unused — remove the unused import if so.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `bunx vitest run apps/server/test/wsServer.test.ts`
Expected: FAIL — `/daemon` and `/client` upgrades are not handled yet (no ws server), so `openWs` rejects/times out.

- [ ] **Step 4: Implement `attachWebSockets`**

Create `apps/server/src/wsServer.ts`:

```ts
import type { Server } from 'node:http'
import { encode, parseClientMessage, parseDaemonMessage } from '@podium/protocol'
import { WebSocketServer } from 'ws'
import type { RelayHub } from './relay'

export interface WsHandle {
  close(): Promise<void>
}

export function attachWebSockets(server: Server, hub: RelayHub): WsHandle {
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
    hub.attachDaemon((msg) => ws.send(encode(msg)))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        hub.onDaemonMessage(parseDaemonMessage(raw.toString()))
      } catch {
        // ignore malformed daemon frames
      }
    })
    ws.on('close', () => hub.detachDaemon())
  })

  clientWss.on('connection', (ws) => {
    const id = hub.attachClient((msg) => ws.send(encode(msg)))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        hub.onClientMessage(id, parseClientMessage(raw.toString()))
      } catch {
        // ignore malformed client frames
      }
    })
    ws.on('close', () => hub.detachClient(id))
  })

  return {
    close() {
      return new Promise<void>((resolve) => {
        daemonWss.close(() => clientWss.close(() => resolve()))
      })
    },
  }
}
```

- [ ] **Step 5: Wire it into `startServer`**

In `apps/server/src/server.ts`, add the import (with the other imports):

```ts
import { attachWebSockets } from './wsServer'
```

Then in the `serve(...)` callback, attach the ws handle and include it in `close()`. Replace the `resolve({...})` block with:

```ts
      const ws = attachWebSockets(server as unknown as Server, hub)
      resolve({
        port: info.port,
        hub,
        close: () =>
          ws.close().then(
            () =>
              new Promise<void>((res) => {
                ;(server as unknown as Server).close(() => res())
              }),
          ),
      })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run apps/server/test/wsServer.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 7: Typecheck + lint + commit**

Run: `bun run --filter @podium/server typecheck`
Expected: exit 0.

Run: `bunx biome check apps/server/src apps/server/test`
Expected: clean.

```bash
git add apps/server/src/wsServer.ts apps/server/src/server.ts apps/server/test/wsServer.test.ts apps/server/test/wsTestUtil.ts
git commit -m "feat(server): /daemon + /client WebSocket endpoints onto RelayHub"
```

---

## Task 3: the daemon (`agent-bridge` ↔ server `/daemon`)

**Files:**
- Modify: `apps/daemon/package.json`
- Confirm/Create: `apps/daemon/tsconfig.json`
- Create: `apps/daemon/src/daemon.ts`
- Modify: `apps/daemon/src/index.ts`
- Create: `apps/daemon/test/daemon.test.ts`

- [ ] **Step 1: Add dependencies**

Edit `apps/daemon/package.json` so `dependencies` (currently `@podium/agent-bridge`, `@podium/protocol`, `@podium/core`) and `devDependencies` become:

```json
  "dependencies": {
    "@podium/agent-bridge": "workspace:*",
    "@podium/protocol": "workspace:*",
    "@podium/core": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "@types/ws": "^8.5.13",
    "tsx": "^4.22.4"
  }
```

Run: `bun install`
Expected: resolves with no errors.

- [ ] **Step 2: Confirm the tsconfig**

Ensure `apps/daemon/tsconfig.json` reads exactly:

```json
{
  "extends": "../../tooling/tsconfig/node.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/daemon/test/daemon.test.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { encode, parseDaemonMessage } from '@podium/protocol'
import { type AddressInfo, WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { startDaemon } from '../src/index'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

function decoded(raw: import('ws').RawData) {
  return parseDaemonMessage(raw.toString())
}

describe('startDaemon', () => {
  it('binds to the server and forwards agent frames; applies control input', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const port = (wss.address() as AddressInfo).port

    const seen: ReturnType<typeof decoded>[] = []
    let serverWs: import('ws').WebSocket | undefined
    wss.on('connection', (ws) => {
      serverWs = ws
      ws.on('message', (raw) => {
        try {
          seen.push(decoded(raw))
        } catch {
          /* ignore */
        }
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      sessionId: 's1',
      cmd: process.execPath,
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })

    try {
      await viWaitFor(() => seen.some((m) => m.type === 'bind'))
      expect(seen.find((m) => m.type === 'bind')).toMatchObject({
        type: 'bind',
        sessionId: 's1',
        geometry: { cols: 80, rows: 24 },
      })

      // send a control input down; the fixture echoes last-input=61 in a forwarded frame.
      // (Asserting via the input->frame round-trip is deterministic; the fixture's
      // spontaneous initial paint may land before ws-open and is intentionally not relied on.)
      serverWs?.send(encode({ type: 'input', data: Buffer.from('a', 'utf8').toString('base64') }))
      await viWaitFor(() =>
        seen.some(
          (m) =>
            m.type === 'agentFrame' &&
            Buffer.from(m.data, 'base64').toString('utf8').includes('last-input=61'),
        ),
      )
    } finally {
      await daemon.close()
      await new Promise<void>((res) => wss.close(() => res()))
    }
  })
})

async function viWaitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('viWaitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bunx vitest run apps/daemon/test/daemon.test.ts`
Expected: FAIL — cannot resolve `startDaemon` from `../src/index`.

- [ ] **Step 5: Implement the daemon**

Create `apps/daemon/src/daemon.ts`:

```ts
import { spawnAgent } from '@podium/agent-bridge'
import { encode, parseControlMessage } from '@podium/protocol'
import WebSocket, { type RawData } from 'ws'

export interface DaemonOptions {
  serverUrl: string
  sessionId: string
  cmd: string
  args?: string[]
  cols?: number
  rows?: number
}

export interface DaemonHandle {
  close(): Promise<void>
}

export function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  const session = spawnAgent({ cmd: opts.cmd, args: opts.args, cols, rows })
  const ws = new WebSocket(`${opts.serverUrl}/daemon`)

  session.onFrame((frame) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encode({ type: 'agentFrame', seq: frame.seq, data: frame.data }))
    }
  })
  session.onExit((code) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode({ type: 'agentExit', code }))
  })

  ws.on('message', (raw: RawData) => {
    let msg: ReturnType<typeof parseControlMessage>
    try {
      msg = parseControlMessage(raw.toString())
    } catch {
      return
    }
    switch (msg.type) {
      case 'input':
        session.write(msg.data)
        break
      case 'resize':
        session.resize(msg.cols, msg.rows)
        break
      case 'redraw':
        session.redraw()
        break
    }
  })

  const handle: DaemonHandle = {
    close() {
      return new Promise<void>((resolve) => {
        session.dispose()
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
    ws.once('open', () => {
      ws.send(
        encode({ type: 'bind', sessionId: opts.sessionId, cmd: opts.cmd, geometry: { cols, rows } }),
      )
      resolve(handle)
    })
    ws.once('error', (err) => {
      session.dispose()
      reject(err)
    })
  })
}
```

Replace `apps/daemon/src/index.ts` ENTIRELY with:

```ts
/**
 * @podium/daemon — per-machine agent host. Spawns an agent via @podium/agent-bridge
 * and relays it to @podium/server over a WebSocket.
 */
export { startDaemon } from './daemon'
export type { DaemonOptions, DaemonHandle } from './daemon'
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bunx vitest run apps/daemon/test/daemon.test.ts`
Expected: PASS — 1 passed.

- [ ] **Step 7: Typecheck + lint + commit**

Run: `bun run --filter @podium/daemon typecheck`
Expected: exit 0.

Run: `bunx biome check apps/daemon/src apps/daemon/test`
Expected: clean.

```bash
git add apps/daemon/package.json apps/daemon/tsconfig.json apps/daemon/src/daemon.ts apps/daemon/src/index.ts apps/daemon/test/daemon.test.ts bun.lock
git commit -m "feat(daemon): relay agent-bridge session to server over WebSocket"
```

---

## Task 4: end-to-end — real daemon → server → raw client (Phase 2 acceptance)

A neutral `e2e/` test orchestrates both apps (imported by relative source path, so neither app depends on the other).

**Files:**
- Create: `e2e/relay.e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Create `e2e/relay.e2e.test.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { encode, parseServerMessage } from '@podium/protocol'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import { startDaemon } from '../apps/daemon/src/daemon'
import { startServer } from '../apps/server/src/server'

const FIXTURE = fileURLToPath(
  new URL('../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function collect(ws: WebSocket) {
  let text = ''
  const seen: ReturnType<typeof parseServerMessage>[] = []
  ws.on('message', (raw: WebSocket.RawData) => {
    let msg: ReturnType<typeof parseServerMessage>
    try {
      msg = parseServerMessage(raw.toString())
    } catch {
      return
    }
    seen.push(msg)
    if (msg.type === 'outputFrame') text += Buffer.from(msg.data, 'base64').toString('utf8')
  })
  return {
    get text() {
      return text
    },
    get seen() {
      return seen
    },
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('e2e: daemon -> server -> client', () => {
  it('streams real fixture output to a client, round-trips input, and bumps epoch on takeover', async () => {
    const srv = await startServer()
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${srv.port}`,
      sessionId: 's1',
      cmd: process.execPath,
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })
    const client = await openWs(`ws://localhost:${srv.port}/client`)
    const c = collect(client)
    try {
      // 0) force a fresh repaint so the just-connected client sees current output —
      //    the fixture only paints spontaneously once, possibly before this client joined.
      client.send(encode({ type: 'redrawRequest' }))
      // 1) live fixture output reaches the client through the full chain
      await waitFor(() => c.text.includes('cols=80 rows=24'))

      // 2) input typed at the client round-trips to the agent and back
      client.send(encode({ type: 'input', data: Buffer.from('a', 'utf8').toString('base64') }))
      await waitFor(() => c.text.includes('last-input=61'))

      // 3) takeover bumps epoch (verify via the server's hub) and resizes the agent
      client.send(encode({ type: 'resize', cols: 100, rows: 30 }))
      client.send(encode({ type: 'requestControl' }))
      await waitFor(() => srv.hub.info().epoch === 1)
      expect(srv.hub.info().geometry).toEqual({ cols: 100, rows: 30 })
      await waitFor(() => c.text.includes('cols=100 rows=30'))
    } finally {
      client.close()
      await daemon.close()
      await srv.close()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run e2e/relay.e2e.test.ts`
Expected: FAIL initially only if a prior task is incomplete; with Tasks 1–3 done it may already pass. If it fails for a real reason, debug per `superpowers:systematic-debugging`. (This task adds no new implementation — it is the integration proof. If it passes immediately, that is the expected success.)

- [ ] **Step 3: Run to verify it passes**

Run: `bunx vitest run e2e/relay.e2e.test.ts`
Expected: PASS — 1 passed (the full daemon→server→client chain over real sockets, with real `node-pty`).

- [ ] **Step 4: Stability check (real sockets + PTY are timing-sensitive)**

Run it 10 times to confirm it is not flaky:

```bash
cd /home/user/src/other/podium
f=0; for i in $(seq 1 10); do bunx vitest run e2e/relay.e2e.test.ts >/dev/null 2>&1 || f=$((f+1)); done; echo "e2e failures: $f / 10"
```

Expected: `e2e failures: 0 / 10`. If any fail, debug per `superpowers:systematic-debugging` (do NOT just raise timeouts) and report.

- [ ] **Step 5: Lint + commit**

Run: `bunx biome check e2e`
Expected: clean.

```bash
git add e2e/relay.e2e.test.ts
git commit -m "test(e2e): daemon -> server -> client over real sockets (Phase 2 acceptance)"
```

---

## Task 5: Phase 2 green gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full Phase 2 surface**

Run: `bunx vitest run packages/protocol apps/server/test apps/daemon/test e2e`
Expected: PASS — protocol (8) + server relay/http/ws (15 + 1 + 3) + daemon (1) + e2e (1) all green.

- [ ] **Step 2: Typecheck server + daemon**

Run: `bun run --filter @podium/server typecheck` → exit 0.
Run: `bun run --filter @podium/daemon typecheck` → exit 0.

- [ ] **Step 3: Lint**

Run: `bunx biome check apps/server apps/daemon e2e packages/protocol/src`
Expected: clean (run `bunx biome check --write` on those paths if needed, then re-commit).

- [ ] **Step 4: Phase 2 exit check**

Confirm the spec's Phase 2 acceptance: a real daemon running the fixture over `node-pty` streams frames through the server to a raw ws client; client input round-trips to the agent; takeover bumps `epoch` and resizes the agent — all over real WebSockets, with the relay logic unit-tested (2a) and the wiring integration-tested (2b). **Next:** Phase 3 (terminal-client + web — the browser UI, Tier 1–2 tests).

---

## Notes for the executor

- **Async test hygiene:** every test must `await` ws `open` before sending, and close all sockets + the server in a `finally`. A leaked server/socket hangs Vitest. The helpers (`openWs`, `waitMessage`, `collect`, `waitFor`) encapsulate this.
- **`ws` RawData:** text frames arrive as a Node `Buffer`; `.toString()` yields the JSON string. Type message handlers' param as `import('ws').RawData` (or `WebSocket.RawData`).
- **Multi-endpoint ws:** use `noServer: true` + a single `server.on('upgrade')` router (the robust documented pattern), not two `{ server, path }` instances.
- **No app→app dependency:** the daemon and server never import each other. Only the neutral `e2e/` test imports both, by relative source path — it is a test orchestrator, not app runtime code.
- **tRPC GET:** a query with no input is reachable at `GET /trpc/<router>.<proc>`; the response shape is `{ result: { data } }`.
- **Dependency versions:** the carets are known-good ranges; if `bun install` cannot resolve one, use the latest compatible release and note it.
- **Determinism:** all tests use the deterministic fixture TUI (not `claude`). Real `claude` is Phase 4.
