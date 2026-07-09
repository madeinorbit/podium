# Handover & Input Prototype — Phase 2a: protocol agentFrame + RelayHub

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the daemon→server `agentFrame` wire message and build `RelayHub` — a transport-agnostic class in `apps/server` that owns the entire relay/control/handover model (bind, epoch-stamped frame fan-out, controller gating of input/resize, takeover with epoch bump + resize + redraw, client lifecycle), proven by a deterministic unit suite using fake `send` functions.

**Architecture:** `RelayHub` knows nothing about WebSockets — it exposes `attachDaemon(send)`, `attachClient(send)`, `onDaemonMessage`, `onClientMessage`, `detachClient`, `detachDaemon`, `info()`, where each `send` is an injected callback. Phase 2b will adapt real `ws` sockets onto these. The server owns `epoch` (bumped on takeover) and stamps it onto client `outputFrame`s; the daemon's `agentFrame` carries only `seq`+`data`.

**Tech Stack:** TypeScript (strict ESM, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`) · zod (protocol) · Vitest · Biome (single quotes, no semicolons, 2-space, 100 col). **No new runtime dependencies** — `RelayHub` uses only `@podium/protocol` types.

---

## Phase 2 roadmap (this plan is 2a)

- **2a — protocol `agentFrame` + `RelayHub` (transport-agnostic relay logic). ← THIS PLAN.**
- **2b — ws + Hono server + daemon + e2e + minimal tRPC.** Wires `RelayHub` to real sockets, connects the daemon to `@podium/agent-bridge`, and proves the spec's Phase 2 acceptance (daemon→server→raw ws client). *Separate plan after 2a lands.*

Design spec: `docs/superpowers/specs/2026-06-01-handover-input-prototype-design.md` (§4 protocol, §5 controller/handover).

---

## Epoch ownership decision (resolves a spec gap)

The server owns `epoch`. `@podium/agent-bridge` emits `AgentFrame { seq, data }` with no epoch (confirmed in Phase 1). So:
- **daemon → server** uses a new `agentFrame { seq, data }` message (no epoch).
- **server → client** uses the existing `outputFrame { seq, epoch, data }`; `RelayHub` copies `seq`, adds its current `epoch`.
- `epoch` starts at 0 and increments by 1 on every successful `requestControl` (takeover).

---

## File structure (Phase 2a)

| File | Responsibility |
|------|----------------|
| `packages/protocol/src/messages.ts` | Add `AgentFrameMessage`; change `DaemonMessage` to `union(Bind, AgentFrame, AgentExit)`. |
| `packages/protocol/src/messages.test.ts` | Add an `agentFrame` round-trip test. |
| `apps/server/src/relay.ts` | `RelayHub` + `Send<T>` + `SessionInfo` types. The whole relay/control model. |
| `apps/server/src/index.ts` | Re-export: `export * from './relay'`. |
| `apps/server/test/relay.test.ts` | Deterministic unit suite (fake `send`s). |

`apps/server/tsconfig.json` already extends `../../tooling/tsconfig/node.json` with `include: ["src"]` — no change needed (tests in `test/` are run by Vitest, matching the Phase-1 agent-bridge pattern).

---

## Task 1: protocol — add `agentFrame`, retype `DaemonMessage`

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/protocol/src/messages.test.ts`, add `parseDaemonMessage` to the existing import from `./messages` if not already imported, and add this test inside the existing `describe('protocol codec', ...)` block:

```ts
  it('round-trips a daemon agentFrame message', () => {
    const msg = { type: 'agentFrame', seq: 7, data: 'aGVsbG8=' } as const
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run packages/protocol/src/messages.test.ts -t agentFrame`
Expected: FAIL — `agentFrame` is not a member of `DaemonMessage` yet, so `parseDaemonMessage` throws.

- [ ] **Step 3: Add the schema and retype the union**

In `packages/protocol/src/messages.ts`, add `AgentFrameMessage` immediately after `RedrawMessage` (in the daemon/server section):

```ts
export const AgentFrameMessage = z.object({
  type: z.literal('agentFrame'),
  seq: z.number().int().nonnegative(),
  data: z.string(),
})
```

Then change the `DaemonMessage` union from using `OutputFrameMessage` to `AgentFrameMessage`. Find:

```ts
export const DaemonMessage = z.discriminatedUnion('type', [BindMessage, OutputFrameMessage, AgentExitMessage])
```

Replace with:

```ts
export const DaemonMessage = z.discriminatedUnion('type', [BindMessage, AgentFrameMessage, AgentExitMessage])
```

(Leave `OutputFrameMessage` defined — it is still used by `ServerMessage`. Leave `ControlMessage` unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run packages/protocol/src/messages.test.ts`
Expected: PASS — all protocol tests pass (the existing `daemon bind` round-trip still works; the new `agentFrame` one passes).

- [ ] **Step 5: Typecheck and rebuild protocol (downstream consumers read its dist)**

Run: `bun run --filter @podium/protocol typecheck`
Expected: exit 0.

Run: `bun run --filter @podium/protocol build`
Expected: tsup emits `packages/protocol/dist/index.js` + `index.d.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): add daemon agentFrame message (seq+data, server owns epoch)"
```

---

## Task 2: `RelayHub` — daemon side + client lifecycle

Implements construction, daemon attach/detach, `onDaemonMessage` (bind / agentFrame fan-out with epoch / agentExit), `attachClient` (welcome + first-client-becomes-controller), `detachClient` (controller reassignment), `info()`. `onClientMessage` is present but unimplemented (throws) — Task 3 implements it.

**Files:**
- Create: `apps/server/src/relay.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/server/test/relay.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/relay.test.ts`:

```ts
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { RelayHub } from '../src/relay'

function capture<T>() {
  const msgs: T[] = []
  const send = (m: T): void => {
    msgs.push(m)
  }
  return { msgs, send }
}

describe('RelayHub — daemon side + lifecycle', () => {
  it('records session state on bind and reports it via info()', () => {
    const hub = new RelayHub()
    hub.attachDaemon(capture<ControlMessage>().send)
    hub.onDaemonMessage({ type: 'bind', sessionId: 's1', cmd: 'fixture', geometry: { cols: 80, rows: 24 } })
    const info = hub.info()
    expect(info.sessionId).toBe('s1')
    expect(info.cmd).toBe('fixture')
    expect(info.geometry).toEqual({ cols: 80, rows: 24 })
    expect(info.epoch).toBe(0)
    expect(info.clientCount).toBe(0)
    expect(info.controllerId).toBeNull()
  })

  it('sends a welcome to a new client and makes the first client the controller', () => {
    const hub = new RelayHub()
    hub.onDaemonMessage({ type: 'bind', sessionId: 's1', cmd: 'fixture', geometry: { cols: 80, rows: 24 } })
    const a = capture<ServerMessage>()
    const id = hub.attachClient(a.send)
    expect(a.msgs).toHaveLength(1)
    expect(a.msgs[0]).toEqual({
      type: 'welcome',
      clientId: id,
      sessionId: 's1',
      controllerId: id,
      geometry: { cols: 80, rows: 24 },
    })
    expect(hub.info().controllerId).toBe(id)
    expect(hub.info().clientCount).toBe(1)
  })

  it('fans out an agentFrame to all clients as an epoch-stamped outputFrame', () => {
    const hub = new RelayHub()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send)
    hub.attachClient(b.send)
    hub.onDaemonMessage({ type: 'agentFrame', seq: 5, data: 'Zm9v' })
    const expected = { type: 'outputFrame', seq: 5, epoch: 0, data: 'Zm9v' }
    expect(a.msgs.at(-1)).toEqual(expected)
    expect(b.msgs.at(-1)).toEqual(expected)
  })

  it('fans out agentExit to all clients', () => {
    const hub = new RelayHub()
    const a = capture<ServerMessage>()
    hub.attachClient(a.send)
    hub.onDaemonMessage({ type: 'agentExit', code: 0 })
    expect(a.msgs.at(-1)).toEqual({ type: 'agentExit', code: 0 })
  })

  it('reassigns the controller when the controller detaches', () => {
    const hub = new RelayHub()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    const idA = hub.attachClient(a.send)
    const idB = hub.attachClient(b.send)
    expect(hub.info().controllerId).toBe(idA)
    hub.detachClient(idA)
    expect(hub.info().controllerId).toBe(idB)
    hub.detachClient(idB)
    expect(hub.info().controllerId).toBeNull()
    expect(hub.info().clientCount).toBe(0)
  })

  it('tolerates daemon messages with no daemon attached', () => {
    const hub = new RelayHub()
    expect(() => hub.onDaemonMessage({ type: 'agentExit', code: 1 })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run apps/server/test/relay.test.ts`
Expected: FAIL — cannot resolve `../src/relay`.

- [ ] **Step 3: Implement `RelayHub` (daemon side + lifecycle; `onClientMessage` stubbed)**

Create `apps/server/src/relay.ts`:

```ts
import type {
  ClientMessage,
  ControlMessage,
  DaemonMessage,
  Geometry,
  ServerMessage,
} from '@podium/protocol'

export type Send<T> = (msg: T) => void

interface ClientConn {
  id: string
  send: Send<ServerMessage>
  viewport: Geometry
}

export interface SessionInfo {
  sessionId: string
  cmd: string
  controllerId: string | null
  geometry: Geometry
  epoch: number
  clientCount: number
}

export class RelayHub {
  private daemonSend: Send<ControlMessage> | undefined
  private sessionId = ''
  private cmd = ''
  private geometry: Geometry = { cols: 80, rows: 24 }
  private epoch = 0
  private controllerId: string | undefined
  private readonly clients = new Map<string, ClientConn>()
  private nextClientNum = 0

  attachDaemon(send: Send<ControlMessage>): void {
    this.daemonSend = send
  }

  detachDaemon(): void {
    this.daemonSend = undefined
  }

  onDaemonMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case 'bind':
        this.sessionId = msg.sessionId
        this.cmd = msg.cmd
        this.geometry = msg.geometry
        break
      case 'agentFrame':
        this.broadcast({ type: 'outputFrame', seq: msg.seq, epoch: this.epoch, data: msg.data })
        break
      case 'agentExit':
        this.broadcast({ type: 'agentExit', code: msg.code })
        break
    }
  }

  attachClient(send: Send<ServerMessage>): string {
    const id = `c${this.nextClientNum}`
    this.nextClientNum += 1
    this.clients.set(id, { id, send, viewport: { ...this.geometry } })
    const controllerId = (this.controllerId ??= id)
    send({
      type: 'welcome',
      clientId: id,
      sessionId: this.sessionId,
      controllerId,
      geometry: this.geometry,
    })
    return id
  }

  detachClient(id: string): void {
    this.clients.delete(id)
    if (this.controllerId === id) {
      const next = this.clients.keys().next()
      this.controllerId = next.done ? undefined : next.value
    }
  }

  onClientMessage(_id: string, _msg: ClientMessage): void {
    throw new Error('not implemented')
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      cmd: this.cmd,
      controllerId: this.controllerId ?? null,
      geometry: { ...this.geometry },
      epoch: this.epoch,
      clientCount: this.clients.size,
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.send(msg)
  }
}
```

Replace `apps/server/src/index.ts` entirely with:

```ts
/**
 * @podium/server — API/web backend. Relay hub + (Phase 2b) Hono + ws + tRPC.
 */
export * from './relay'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run apps/server/test/relay.test.ts`
Expected: PASS — 6 passed.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter @podium/server typecheck`
Expected: exit 0 (resolves `@podium/protocol` types from its rebuilt dist).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/index.ts apps/server/test/relay.test.ts
git commit -m "feat(server): RelayHub daemon side + client lifecycle (epoch-stamped fan-out)"
```

---

## Task 3: `RelayHub` — client control (gating, takeover, redraw)

Implements `onClientMessage`: `hello`/`resize` viewport tracking, controller-gated `input`/`resize` forwarding, `requestControl` takeover (epoch bump + daemon resize+redraw + broadcast), `redrawRequest`.

**Files:**
- Modify: `apps/server/src/relay.ts`
- Modify: `apps/server/test/relay.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `apps/server/test/relay.test.ts` (after the existing one). The `capture` helper is already defined at the top of the file and is in scope:

```ts
describe('RelayHub — client control', () => {
  function setup() {
    const hub = new RelayHub()
    const daemon = capture<ControlMessage>()
    hub.attachDaemon(daemon.send)
    hub.onDaemonMessage({ type: 'bind', sessionId: 's1', cmd: 'fixture', geometry: { cols: 80, rows: 24 } })
    return { hub, daemon }
  }

  it('forwards input from the controller to the daemon', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const id = hub.attachClient(a.send)
    hub.onClientMessage(id, { type: 'input', data: 'YQ==' })
    expect(daemon.msgs).toContainEqual({ type: 'input', data: 'YQ==' })
  })

  it('drops input from a non-controller (spectator)', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send) // controller
    const idB = hub.attachClient(b.send) // spectator
    hub.onClientMessage(idB, { type: 'input', data: 'YQ==' })
    expect(daemon.msgs).not.toContainEqual({ type: 'input', data: 'YQ==' })
  })

  it('applies a controller resize to the session geometry and forwards it', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const id = hub.attachClient(a.send)
    hub.onClientMessage(id, { type: 'resize', cols: 120, rows: 40 })
    expect(hub.info().geometry).toEqual({ cols: 120, rows: 40 })
    expect(daemon.msgs).toContainEqual({ type: 'resize', cols: 120, rows: 40 })
  })

  it('does not change session geometry on a spectator resize', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send) // controller
    const idB = hub.attachClient(b.send) // spectator
    hub.onClientMessage(idB, { type: 'resize', cols: 50, rows: 20 })
    expect(hub.info().geometry).toEqual({ cols: 80, rows: 24 })
    expect(daemon.msgs).not.toContainEqual({ type: 'resize', cols: 50, rows: 20 })
  })

  it('takeover: requestControl bumps epoch, resizes+redraws the daemon, broadcasts to all', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send) // controller c0
    const idB = hub.attachClient(b.send) // spectator c1
    // c1 reports its (mobile) viewport first, then takes control
    hub.onClientMessage(idB, { type: 'resize', cols: 40, rows: 30 })
    hub.onClientMessage(idB, { type: 'requestControl' })

    expect(hub.info().controllerId).toBe(idB)
    expect(hub.info().epoch).toBe(1)
    expect(hub.info().geometry).toEqual({ cols: 40, rows: 30 })
    // daemon told to resize to the new controller's grid, then redraw
    expect(daemon.msgs).toContainEqual({ type: 'resize', cols: 40, rows: 30 })
    expect(daemon.msgs).toContainEqual({ type: 'redraw' })
    // every client learns about the new controller + geometry
    expect(a.msgs).toContainEqual({ type: 'controllerChanged', controllerId: idB, geometry: { cols: 40, rows: 30 } })
    expect(b.msgs).toContainEqual({ type: 'geometry', cols: 40, rows: 30 })
  })

  it('frames after a takeover carry the bumped epoch', () => {
    const { hub } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send)
    const idB = hub.attachClient(b.send)
    hub.onClientMessage(idB, { type: 'requestControl' })
    hub.onDaemonMessage({ type: 'agentFrame', seq: 9, data: 'eA==' })
    expect(a.msgs.at(-1)).toEqual({ type: 'outputFrame', seq: 9, epoch: 1, data: 'eA==' })
  })

  it('redrawRequest forwards a redraw to the daemon', () => {
    const { hub, daemon } = setup()
    const a = capture<ServerMessage>()
    const id = hub.attachClient(a.send)
    hub.onClientMessage(id, { type: 'redrawRequest' })
    expect(daemon.msgs).toContainEqual({ type: 'redraw' })
  })

  it('hello updates the client viewport used on takeover', () => {
    const { hub } = setup()
    const a = capture<ServerMessage>()
    const b = capture<ServerMessage>()
    hub.attachClient(a.send)
    const idB = hub.attachClient(b.send)
    hub.onClientMessage(idB, { type: 'hello', clientId: idB, viewport: { cols: 33, rows: 21, dpr: 2 } })
    hub.onClientMessage(idB, { type: 'requestControl' })
    expect(hub.info().geometry).toEqual({ cols: 33, rows: 21 })
  })

  it('ignores client messages for an unknown id', () => {
    const { hub, daemon } = setup()
    expect(() => hub.onClientMessage('ghost', { type: 'redrawRequest' })).not.toThrow()
    expect(daemon.msgs).not.toContainEqual({ type: 'redraw' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run apps/server/test/relay.test.ts`
Expected: FAIL — the new "client control" tests throw `not implemented` from `onClientMessage`.

- [ ] **Step 3: Implement `onClientMessage`**

In `apps/server/src/relay.ts`, replace the stub:

```ts
  onClientMessage(_id: string, _msg: ClientMessage): void {
    throw new Error('not implemented')
  }
```

with:

```ts
  onClientMessage(id: string, msg: ClientMessage): void {
    const client = this.clients.get(id)
    if (client === undefined) return
    switch (msg.type) {
      case 'hello':
        client.viewport = { cols: msg.viewport.cols, rows: msg.viewport.rows }
        break
      case 'resize':
        client.viewport = { cols: msg.cols, rows: msg.rows }
        if (id === this.controllerId) {
          this.geometry = { cols: msg.cols, rows: msg.rows }
          this.daemonSend?.({ type: 'resize', cols: msg.cols, rows: msg.rows })
        }
        break
      case 'input':
        if (id === this.controllerId) this.daemonSend?.({ type: 'input', data: msg.data })
        break
      case 'requestControl':
        this.controllerId = id
        this.geometry = { ...client.viewport }
        this.epoch += 1
        this.daemonSend?.({ type: 'resize', cols: this.geometry.cols, rows: this.geometry.rows })
        this.daemonSend?.({ type: 'redraw' })
        this.broadcast({ type: 'controllerChanged', controllerId: id, geometry: this.geometry })
        this.broadcast({ type: 'geometry', cols: this.geometry.cols, rows: this.geometry.rows })
        break
      case 'redrawRequest':
        this.daemonSend?.({ type: 'redraw' })
        break
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run apps/server/test/relay.test.ts`
Expected: PASS — 15 passed (6 from Task 2 + 9 here).

- [ ] **Step 5: Typecheck**

Run: `bun run --filter @podium/server typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/relay.ts apps/server/test/relay.test.ts
git commit -m "feat(server): RelayHub client control — gating, takeover, redraw"
```

---

## Task 4: Phase 2a green gate

**Files:** none (verification only).

- [ ] **Step 1: Run the Phase 2a + protocol tests**

Run: `bunx vitest run packages/protocol/src/messages.test.ts apps/server/test/relay.test.ts`
Expected: PASS — protocol (8) + server relay (15) = 23 passed.

- [ ] **Step 2: Typecheck protocol + server**

Run: `bun run --filter @podium/protocol typecheck`
Expected: exit 0.

Run: `bun run --filter @podium/server typecheck`
Expected: exit 0.

- [ ] **Step 3: Lint the touched files**

Run: `bunx biome check packages/protocol/src apps/server/src apps/server/test`
Expected: clean. If Biome reports formatting, run `bunx biome check --write` on those paths and re-run until clean, then `git commit -am "chore: phase 2a formatting"` (only if there were changes).

- [ ] **Step 4: Phase 2a exit check**

Confirm: protocol `agentFrame` round-trips; `RelayHub` deterministically implements bind, epoch-stamped fan-out, first-client-controller, controller-gated input/resize, takeover (epoch bump + daemon resize+redraw + broadcast), redraw, and lifecycle — all green with zero sockets. **Next:** request the Phase 2b plan (ws + Hono + daemon + e2e + tRPC).

---

## Notes for the executor

- **No new dependencies.** `RelayHub` imports only *types* from `@podium/protocol` (`import type`), erased at runtime. Its tests construct plain message literals. The only build dependency is protocol's rebuilt `dist` (Task 1, Step 5) for typecheck.
- **Why `onClientMessage` throws in Task 2:** keeps the class compiling while Task 3 drives it via TDD. No test calls it until Task 3.
- **`(this.controllerId ??= id)`** returns a non-null `string` (the existing or newly-assigned controller), which is what `welcome.controllerId` requires — avoids a `string | undefined` type error.
- **`msgs.at(-1)`** is used to assert "the most recent message" without indexing math under `noUncheckedIndexedAccess`.
