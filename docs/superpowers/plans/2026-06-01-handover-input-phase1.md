# Handover & Input Prototype — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@podium/protocol` (the wire message union) and `@podium/agent-bridge` (a `node-pty`-backed agent session with spawn / input / resize / **redraw-nudge** / frames), proven by a deterministic alt-screen fixture TUI and a green Tier-0 Vitest suite — no browser, no daemon/server yet.

**Architecture:** `@podium/protocol` is leaf, zod-only, isomorphic, and exports zod schemas + inferred types + JSON codecs. `@podium/agent-bridge` (Node) depends on protocol type-only and wraps `node-pty` behind a small `AgentSession` interface. A fixture TUI (a ~25-line alt-screen program that prints its own geometry + a paint counter + last input, and repaints on `SIGWINCH`) makes the bridge's behavior deterministic and assertable without `claude` or auth.

**Tech Stack:** Bun workspaces · TypeScript (strict ESM, `verbatimModuleSyntax`) · zod · node-pty · Vitest · Biome (single quotes, no semicolons, 2-space, 100 col) · tsup (lib build).

---

## Phase roadmap (context — only Phase 1 is detailed here)

- **Phase 0 — Unblock browser. ✅ DONE.** AppArmor `harness-chrome-for-testing` profile loaded; CfT launches headless **with** sandbox (verified). `adb` install + pointing Playwright at the CfT binary are deferred to Phase 3 (where they're first needed).
- **Phase 1 — protocol + agent-bridge + fixture (Tier 0 green). ← THIS PLAN.**
- **Phase 2 — daemon + server relay** (`apps/daemon` hosts the bridge; `apps/server` = Hono + `ws` relay + controller tracking + minimal tRPC). *Separate plan after Phase 1 lands.*
- **Phase 3 — terminal-client + web (Tier 1–2 green)** (xterm, `ViewportSource` seam, key toolbar, controller/spectator render, observability contract; Playwright e2e on Chromium + WebKit). *Separate plan.*
- **Phase 4 — real `claude` + real-phone (Tier 3) pass.** *Separate plan.*

---

## File structure (Phase 1)

| File | Responsibility |
|------|----------------|
| `packages/protocol/src/messages.ts` | zod schemas, inferred types, JSON codecs for all four channels (client→server, server→client, daemon→server, server→daemon). |
| `packages/protocol/src/index.ts` | Public surface: `export * from './messages'`. |
| `packages/protocol/src/messages.test.ts` | Codec round-trip + validation-rejection tests. |
| `packages/protocol/package.json` | Add `zod` dependency. |
| `packages/agent-bridge/src/session.ts` | `AgentSession` interface, `SpawnOptions`, `AgentFrame`, and `spawnAgent()` (node-pty wrapper). |
| `packages/agent-bridge/src/index.ts` | Public surface: `export * from './session'`. |
| `packages/agent-bridge/package.json` | Add `node-pty` dependency. |
| `packages/agent-bridge/tsconfig.json` | Extends `node.json` (confirm/create). |
| `packages/agent-bridge/test/fixtures/fixture-tui.mjs` | Deterministic alt-screen TUI used as the spawn target in tests. |
| `packages/agent-bridge/test/helpers.ts` | `collect()` (accumulate decoded frames, parse paint counters) + `waitFor()`. |
| `packages/agent-bridge/test/session.test.ts` | Tier-0 behavior tests. |

---

## Task 1: `@podium/protocol` — wire messages + codecs

**Files:**
- Modify: `packages/protocol/package.json`
- Create: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Add the `zod` dependency**

Edit `packages/protocol/package.json` to add a `dependencies` block (it currently has none — keep the existing `devDependencies`):

```json
  "dependencies": {
    "zod": "^3.24.0"
  },
```

Then from the repo root:

Run: `bun install`
Expected: resolves with no errors; `zod` symlinked into `node_modules`.

- [ ] **Step 2: Write the failing codec test**

Create `packages/protocol/src/messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { encode, parseClientMessage, parseServerMessage } from './messages'

describe('protocol codec', () => {
  it('round-trips a client input message', () => {
    const msg = { type: 'input', data: 'YQ==' } as const
    expect(parseClientMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a server output frame', () => {
    const msg = { type: 'outputFrame', seq: 3, epoch: 1, data: 'AAA=' } as const
    expect(parseServerMessage(encode(msg))).toEqual(msg)
  })

  it('rejects an unknown client message type', () => {
    expect(() => parseClientMessage(JSON.stringify({ type: 'nope' }))).toThrow()
  })

  it('rejects a resize with non-positive dimensions', () => {
    expect(() => parseClientMessage(JSON.stringify({ type: 'resize', cols: 0, rows: 24 }))).toThrow()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bunx vitest run packages/protocol/src/messages.test.ts`
Expected: FAIL — cannot resolve `./messages` (module does not exist yet).

- [ ] **Step 4: Implement the schemas + codecs**

Create `packages/protocol/src/messages.ts`:

```ts
import { z } from 'zod'

const positiveInt = z.number().int().positive()

export const Geometry = z.object({ cols: positiveInt, rows: positiveInt })
export type Geometry = z.infer<typeof Geometry>

export const Viewport = z.object({ cols: positiveInt, rows: positiveInt, dpr: z.number().positive() })
export type Viewport = z.infer<typeof Viewport>

// ---- Browser client -> server ----
export const HelloMessage = z.object({ type: z.literal('hello'), clientId: z.string(), viewport: Viewport })
export const InputMessage = z.object({ type: z.literal('input'), data: z.string() })
export const ResizeMessage = z.object({ type: z.literal('resize'), cols: positiveInt, rows: positiveInt })
export const RequestControlMessage = z.object({ type: z.literal('requestControl') })
export const RedrawRequestMessage = z.object({ type: z.literal('redrawRequest') })

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  InputMessage,
  ResizeMessage,
  RequestControlMessage,
  RedrawRequestMessage,
])
export type ClientMessage = z.infer<typeof ClientMessage>

// ---- Server -> browser client ----
export const WelcomeMessage = z.object({
  type: z.literal('welcome'),
  clientId: z.string(),
  sessionId: z.string(),
  controllerId: z.string(),
  geometry: Geometry,
})
export const OutputFrameMessage = z.object({
  type: z.literal('outputFrame'),
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  data: z.string(),
})
export const ControllerChangedMessage = z.object({
  type: z.literal('controllerChanged'),
  controllerId: z.string(),
  geometry: Geometry,
})
export const GeometryMessage = z.object({ type: z.literal('geometry'), cols: positiveInt, rows: positiveInt })
export const AgentExitMessage = z.object({ type: z.literal('agentExit'), code: z.number().int() })

export const ServerMessage = z.discriminatedUnion('type', [
  WelcomeMessage,
  OutputFrameMessage,
  ControllerChangedMessage,
  GeometryMessage,
  AgentExitMessage,
])
export type ServerMessage = z.infer<typeof ServerMessage>

// ---- Daemon <-> server ----
export const BindMessage = z.object({
  type: z.literal('bind'),
  sessionId: z.string(),
  cmd: z.string(),
  geometry: Geometry,
})
export const RedrawMessage = z.object({ type: z.literal('redraw') })

// daemon -> server
export const DaemonMessage = z.discriminatedUnion('type', [BindMessage, OutputFrameMessage, AgentExitMessage])
export type DaemonMessage = z.infer<typeof DaemonMessage>

// server -> daemon
export const ControlMessage = z.discriminatedUnion('type', [InputMessage, ResizeMessage, RedrawMessage])
export type ControlMessage = z.infer<typeof ControlMessage>

// ---- codec ----
type AnyMessage = ClientMessage | ServerMessage | DaemonMessage | ControlMessage

export function encode(msg: AnyMessage): string {
  return JSON.stringify(msg)
}

export function parseClientMessage(raw: string): ClientMessage {
  return ClientMessage.parse(JSON.parse(raw))
}
export function parseServerMessage(raw: string): ServerMessage {
  return ServerMessage.parse(JSON.parse(raw))
}
export function parseDaemonMessage(raw: string): DaemonMessage {
  return DaemonMessage.parse(JSON.parse(raw))
}
export function parseControlMessage(raw: string): ControlMessage {
  return ControlMessage.parse(JSON.parse(raw))
}
```

Replace `packages/protocol/src/index.ts` entirely with:

```ts
/**
 * @podium/protocol — wire types + codecs for agent/terminal sessions.
 */
export * from './messages'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bunx vitest run packages/protocol/src/messages.test.ts`
Expected: PASS — 4 passed.

- [ ] **Step 6: Typecheck and build protocol (so downstream packages can resolve its types)**

Run: `bun run --filter @podium/protocol typecheck`
Expected: no errors.

Run: `bun run --filter @podium/protocol build`
Expected: tsup emits `packages/protocol/dist/index.js` + `index.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/package.json packages/protocol/src/messages.ts packages/protocol/src/index.ts packages/protocol/src/messages.test.ts bun.lock
git commit -m "feat(protocol): wire message union + zod codecs"
```

---

## Task 2: `@podium/agent-bridge` — setup, fixture, and test helpers

This task adds the dependency, the fixture TUI, the test helpers, and the type surface + a deliberately-unimplemented `spawnAgent` so the package compiles before behavior is added.

**Files:**
- Modify: `packages/agent-bridge/package.json`
- Confirm/Create: `packages/agent-bridge/tsconfig.json`
- Create: `packages/agent-bridge/src/session.ts`
- Modify: `packages/agent-bridge/src/index.ts`
- Create: `packages/agent-bridge/test/fixtures/fixture-tui.mjs`
- Create: `packages/agent-bridge/test/helpers.ts`

- [ ] **Step 1: Add the `node-pty` dependency**

Edit `packages/agent-bridge/package.json` — add `node-pty` to the existing `dependencies` block (which already contains only `@podium/protocol`). The result:

```json
  "dependencies": {
    "@podium/protocol": "workspace:*",
    "node-pty": "^1.0.0"
  },
```

Run: `bun install`
Expected: resolves; `node-pty` present (it ships prebuilt binaries for Node 22). If a build is triggered, it completes without error.

- [ ] **Step 2: Confirm the tsconfig extends node.json**

Ensure `packages/agent-bridge/tsconfig.json` reads exactly:

```json
{
  "extends": "../../tooling/tsconfig/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "ignoreDeprecations": "6.0"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create the fixture TUI**

Create `packages/agent-bridge/test/fixtures/fixture-tui.mjs`:

```js
#!/usr/bin/env node
// Deterministic alt-screen TUI for agent-bridge Tier-0 tests.
// Prints its PTY geometry, a monotonically increasing paint counter, and the
// hex of the last input chunk. Repaints on SIGWINCH (stdout 'resize').
let paint = 0
let lastInput = ''

function render() {
  paint += 1
  const cols = process.stdout.columns ?? 0
  const rows = process.stdout.rows ?? 0
  process.stdout.write('\x1b[2J\x1b[H')
  process.stdout.write(`PODIUM-FIXTURE cols=${cols} rows=${rows} paint=${paint}\r\n`)
  process.stdout.write(`last-input=${lastInput}\r\n`)
}

process.stdout.write('\x1b[?1049h') // enter alt screen
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', (buf) => {
  lastInput = Buffer.from(buf).toString('hex')
  if (lastInput === '03') {
    process.stdout.write('\x1b[?1049l') // leave alt screen
    process.exit(0) // Ctrl-C exits cleanly
  }
  render()
})
process.stdout.on('resize', render)
render()
```

- [ ] **Step 4: Create the test helpers**

Create `packages/agent-bridge/test/helpers.ts`:

```ts
import type { AgentSession } from '../src/index'

export interface Collector {
  readonly text: string
  readonly seqs: number[]
  maxPaint(): number
}

export function collect(session: AgentSession): Collector {
  let buffer = ''
  const seqs: number[] = []
  session.onFrame((f) => {
    buffer += Buffer.from(f.data, 'base64').toString('utf8')
    seqs.push(f.seq)
  })
  return {
    get text() {
      return buffer
    },
    get seqs() {
      return seqs
    },
    maxPaint() {
      const re = /paint=(\d+)/g
      let max = 0
      let m: RegExpExecArray | null = re.exec(buffer)
      while (m !== null) {
        max = Math.max(max, Number(m[1]))
        m = re.exec(buffer)
      }
      return max
    },
  }
}

export async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
```

- [ ] **Step 5: Create the type surface + unimplemented `spawnAgent`**

Create `packages/agent-bridge/src/session.ts`:

```ts
import type { Geometry } from '@podium/protocol'

export interface SpawnOptions {
  cmd: string
  args?: string[]
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
}

export interface AgentFrame {
  seq: number
  /** base64 of raw PTY output bytes */
  data: string
}

export interface AgentSession {
  readonly pid: number
  onFrame(cb: (frame: AgentFrame) => void): () => void
  onExit(cb: (code: number) => void): () => void
  /** base64 of input bytes to inject into the PTY */
  write(dataBase64: string): void
  resize(cols: number, rows: number): void
  /** Force a real repaint even when geometry is unchanged. */
  redraw(): void
  geometry(): Geometry
  dispose(): void
}

export function spawnAgent(_opts: SpawnOptions): AgentSession {
  throw new Error('not implemented')
}
```

Replace `packages/agent-bridge/src/index.ts` entirely with:

```ts
/**
 * @podium/agent-bridge — node-pty-backed agent sessions (spawn, input, resize,
 * redraw, frames). Speaks @podium/protocol geometry types.
 */
export * from './session'
```

- [ ] **Step 6: Typecheck**

Run: `bun run --filter @podium/agent-bridge typecheck`
Expected: no errors (protocol's `dist/index.d.ts` from Task 1 resolves the `Geometry` type import).

- [ ] **Step 7: Commit**

```bash
git add packages/agent-bridge/package.json packages/agent-bridge/tsconfig.json packages/agent-bridge/src/session.ts packages/agent-bridge/src/index.ts packages/agent-bridge/test/fixtures/fixture-tui.mjs packages/agent-bridge/test/helpers.ts bun.lock
git commit -m "chore(agent-bridge): add node-pty, fixture TUI, test helpers, type surface"
```

---

## Task 3: `spawnAgent` core — spawn, frames, input, resize, exit, dispose

**Files:**
- Modify: `packages/agent-bridge/src/session.ts`
- Create: `packages/agent-bridge/test/session.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/agent-bridge/test/session.test.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAgent } from '../src/index'
import { collect, waitFor } from './helpers'

const FIXTURE = fileURLToPath(new URL('./fixtures/fixture-tui.mjs', import.meta.url))

function toB64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

function start() {
  return spawnAgent({ cmd: process.execPath, args: [FIXTURE], cols: 80, rows: 24 })
}

describe('spawnAgent core', () => {
  it('emits an initial frame with the PTY geometry', async () => {
    const s = start()
    const c = collect(s)
    await waitFor(() => c.text.includes('cols=80 rows=24'))
    expect(c.text).toContain('PODIUM-FIXTURE')
    expect(s.geometry()).toEqual({ cols: 80, rows: 24 })
    s.dispose()
  })

  it('round-trips input to the PTY', async () => {
    const s = start()
    const c = collect(s)
    await waitFor(() => c.text.includes('paint='))
    s.write(toB64('a')) // 'a' === 0x61
    await waitFor(() => c.text.includes('last-input=61'))
    expect(c.text).toContain('last-input=61')
    s.dispose()
  })

  it('resizes the PTY and the TUI repaints at the new geometry', async () => {
    const s = start()
    const c = collect(s)
    await waitFor(() => c.text.includes('cols=80 rows=24'))
    s.resize(100, 30)
    await waitFor(() => c.text.includes('cols=100 rows=30'))
    expect(s.geometry()).toEqual({ cols: 100, rows: 30 })
    s.dispose()
  })

  it('assigns monotonically increasing frame seq', async () => {
    const s = start()
    const c = collect(s)
    s.write(toB64('x')) // force at least one extra repaint
    await waitFor(() => c.seqs.length >= 2)
    const seqs = c.seqs
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i] as number).toBeGreaterThan(seqs[i - 1] as number)
    }
    s.dispose()
  })

  it('emits exit when the agent process ends', async () => {
    const s = start()
    let code: number | undefined
    s.onExit((c) => {
      code = c
    })
    const c = collect(s)
    await waitFor(() => c.text.includes('paint='))
    s.write(toB64('\x03')) // Ctrl-C → fixture exits 0
    await waitFor(() => code !== undefined)
    expect(code).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run packages/agent-bridge/test/session.test.ts`
Expected: FAIL — every test throws `not implemented`.

- [ ] **Step 3: Implement `spawnAgent` (redraw still stubbed)**

Replace the body of `packages/agent-bridge/src/session.ts` (keep the interfaces above `spawnAgent`; replace from the `import` line and the `spawnAgent` function). Full file:

```ts
import { spawn, type IPty } from 'node-pty'
import type { Geometry } from '@podium/protocol'

export interface SpawnOptions {
  cmd: string
  args?: string[]
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
}

export interface AgentFrame {
  seq: number
  /** base64 of raw PTY output bytes */
  data: string
}

export interface AgentSession {
  readonly pid: number
  onFrame(cb: (frame: AgentFrame) => void): () => void
  onExit(cb: (code: number) => void): () => void
  write(dataBase64: string): void
  resize(cols: number, rows: number): void
  redraw(): void
  geometry(): Geometry
  dispose(): void
}

export function spawnAgent(opts: SpawnOptions): AgentSession {
  let cols = opts.cols
  let rows = opts.rows
  let seq = 0
  let disposed = false
  const frameCbs = new Set<(f: AgentFrame) => void>()
  const exitCbs = new Set<(code: number) => void>()

  const proc: IPty = spawn(opts.cmd, opts.args ?? [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env } as Record<string, string>,
  })

  proc.onData((data: string) => {
    const frame: AgentFrame = { seq, data: Buffer.from(data, 'utf8').toString('base64') }
    seq += 1
    for (const cb of frameCbs) cb(frame)
  })

  proc.onExit(({ exitCode }) => {
    for (const cb of exitCbs) cb(exitCode)
  })

  return {
    get pid() {
      return proc.pid
    },
    onFrame(cb) {
      frameCbs.add(cb)
      return () => frameCbs.delete(cb)
    },
    onExit(cb) {
      exitCbs.add(cb)
      return () => exitCbs.delete(cb)
    },
    write(dataBase64) {
      proc.write(Buffer.from(dataBase64, 'base64').toString('utf8'))
    },
    resize(c, r) {
      cols = c
      rows = r
      proc.resize(c, r)
    },
    redraw() {
      throw new Error('not implemented')
    },
    geometry() {
      return { cols, rows }
    },
    dispose() {
      if (disposed) return
      disposed = true
      frameCbs.clear()
      exitCbs.clear()
      try {
        proc.kill()
      } catch {
        // process already exited
      }
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run packages/agent-bridge/test/session.test.ts`
Expected: PASS — 5 passed (the `redraw` test does not exist yet).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/session.ts packages/agent-bridge/test/session.test.ts
git commit -m "feat(agent-bridge): spawn/frames/input/resize/exit over node-pty"
```

---

## Task 4: `redraw()` — the resize-nudge

The subtle bit: resizing a PTY to the size it already has may emit no repaint. `redraw()` nudges geometry (`rows → rows-1 → rows` on the next tick) to force a real `SIGWINCH` repaint.

**Files:**
- Modify: `packages/agent-bridge/src/session.ts`
- Modify: `packages/agent-bridge/test/session.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test inside the `describe('spawnAgent core', ...)` block in `packages/agent-bridge/test/session.test.ts` (before the closing `})` of the describe):

```ts
  it('redraw() forces a fresh repaint even when geometry is unchanged', async () => {
    const s = start()
    const c = collect(s)
    await waitFor(() => c.maxPaint() >= 1)
    const before = c.maxPaint()
    s.redraw()
    await waitFor(() => c.maxPaint() > before)
    expect(c.maxPaint()).toBeGreaterThan(before)
    expect(s.geometry()).toEqual({ cols: 80, rows: 24 }) // geometry restored
    s.dispose()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run packages/agent-bridge/test/session.test.ts -t redraw`
Expected: FAIL — `redraw()` throws `not implemented`.

- [ ] **Step 3: Implement the nudge**

In `packages/agent-bridge/src/session.ts`, add a nudge-timer variable alongside the other `let` declarations at the top of `spawnAgent`:

```ts
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined
```

Replace the `redraw()` method with:

```ts
    redraw() {
      if (disposed) return
      if (rows <= 1) {
        proc.write('\x0c') // Ctrl-L fallback when a nudge is impossible
        return
      }
      proc.resize(cols, rows - 1)
      nudgeTimer = setTimeout(() => {
        if (!disposed) proc.resize(cols, rows)
      }, 0)
    },
```

And in `dispose()`, clear the timer — change the body to:

```ts
    dispose() {
      if (disposed) return
      disposed = true
      if (nudgeTimer) clearTimeout(nudgeTimer)
      frameCbs.clear()
      exitCbs.clear()
      try {
        proc.kill()
      } catch {
        // process already exited
      }
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run packages/agent-bridge/test/session.test.ts`
Expected: PASS — 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/session.ts packages/agent-bridge/test/session.test.ts
git commit -m "feat(agent-bridge): redraw() via resize-nudge to force a repaint"
```

---

## Task 5: Phase 1 green gate

Verify the whole workspace is green and the publishable libs build.

**Files:** none (verification + optional formatting fixes only).

- [ ] **Step 1: Run the full test suite**

Run: `bun run test`
Expected: PASS — protocol (4) + agent-bridge (6) tests pass; no other tests yet.

- [ ] **Step 2: Typecheck the whole workspace**

Run: `bun run typecheck`
Expected: every workspace package typechecks with no errors.

- [ ] **Step 3: Lint/format**

Run: `bun run lint`
Expected: PASS. If Biome reports formatting diffs, run `bun run format` and re-run `bun run lint` until clean.

- [ ] **Step 4: Build the publishable libraries**

Run: `bun run build`
Expected: `@podium/protocol` and `@podium/agent-bridge` each emit `dist/index.js` + `index.d.ts` via tsup with no errors.

- [ ] **Step 5: Commit any formatting fixes**

```bash
git add -A
git commit -m "chore: phase 1 green — protocol + agent-bridge (Tier 0) passing" || echo "nothing to commit"
```

- [ ] **Step 6: Phase 1 exit check**

Confirm, in order: `bun run test` ✅ · `bun run typecheck` ✅ · `bun run lint` ✅ · `bun run build` ✅. Phase 1 is complete — the bridge spawns a real PTY, streams seq-numbered frames, injects input, resizes, and forces a repaint on demand, all proven against a deterministic fixture. **Next:** request the Phase 2 plan (daemon + server relay).

---

## Notes for the executor

- **node-pty under Vitest:** Vitest 4's default `forks` pool runs each test file in a child process, which is safe for native addons. If you hit a native-module load error, set `test.pool = 'forks'` explicitly in `vitest.config.ts`.
- **Encoding scope:** frames/input are base64 of UTF-8 strings (node-pty's default). Control/escape keys (Esc, Ctrl-C, arrows) are all < 0x80 and round-trip cleanly. Raw binary safety and backpressure are explicitly out of scope (see spec §4, §5).
- **Why build protocol before agent-bridge typechecks:** `@podium/protocol`'s `exports` point at `dist`, so its `.d.ts` must exist for agent-bridge's type-only `import` to resolve. The type import is erased at runtime (`verbatimModuleSyntax`), so Vitest does not need protocol's JS — but `tsc` does need its types.
```
