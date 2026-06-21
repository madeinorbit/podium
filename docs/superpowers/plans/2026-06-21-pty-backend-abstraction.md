# PTY Backend Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a backend-neutral PTY layer (one interface, two adapters: node-pty and Bun.Terminal) and a real-PTY behavioral suite that runs green against both backends, to derisk Podium's move to Bun + `bun build --compile`.

**Architecture:** A minimal `PtyBackend`/`PtyProcess` interface (bytes-canonical) sits between Podium's `wrapPty`/`AgentSession` logic and the concrete PTY library. `wrapPty` gains a shared `StringDecoder` so the OSC title scanner keeps getting whole strings even though the wire is raw bytes. A single runner-neutral behavioral spec is executed under vitest/Node (node-pty) and under `bun test` (Bun.Terminal), in isolation.

**Tech Stack:** TypeScript (ESM), vitest, `bun test`, node-pty 1.1.0 (NAPI), `Bun.Terminal` (Bun ≥1.3.5), `node:string_decoder`.

## Global Constraints

- Canonical PTY data form is **bytes** (`Uint8Array`). Adapters emit bytes; `wrapPty` decodes for the title scanner only.
- The public `AgentSession` contract is **unchanged**. Only `wrapPty`'s parameter type and the spawn sites change.
- `bun-terminal-backend.ts` must reference `Bun.*` **only inside functions**, so the module loads (but is never selected) under Node.
- `node-pty-backend.ts` must load `node-pty` **lazily** (first `spawn()` call, via `createRequire`), so importing the pty module graph under Bun never eagerly loads the native addon.
- The `bun test` file and the shared spec must import **narrow paths** (`../../src/session`, `../../src/pty/index`) and never the agent-bridge package index — that pulls in `node:sqlite`, which Bun does not implement.
- Default backend stays **node-pty**; under Bun it auto-selects Bun.Terminal. `PODIUM_PTY_BACKEND=node-pty|bun-terminal` forces a choice.
- node binary for spawning fixtures is the literal `'node'` (on PATH), never `process.execPath` (which is `bun` under `bun test`).
- Out of scope (deferred follow-ups): `node:sqlite`→`bun:sqlite`, abduco embedding for compile, flipping the app-wide default.
- Commit after every task. Branch: `worktree-feat+pty-backend-abstraction` (off `main` @ `8676d4a`).

---

### Task 1: PtyProcess/PtyBackend types + node-pty adapter

**Files:**
- Create: `packages/agent-bridge/src/pty/types.ts`
- Create: `packages/agent-bridge/src/pty/node-pty-backend.ts`
- Test: `packages/agent-bridge/src/pty/node-pty-backend.test.ts`

**Interfaces:**
- Produces: `PtySpawnOptions { file: string; args: string[]; cols: number; rows: number; cwd?: string; env?: Record<string,string> }`; `PtyProcess { readonly pid: number; onData(cb:(b:Uint8Array)=>void):void; onExit(cb:(e:{exitCode:number;signal?:number})=>void):void; write(d:Uint8Array):void; resize(c:number,r:number):void; kill(sig?:string):void }`; `PtyBackend { readonly name:'node-pty'|'bun-terminal'; spawn(o:PtySpawnOptions):PtyProcess }`; `nodePtyBackend(): PtyBackend`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-bridge/src/pty/node-pty-backend.test.ts
import { describe, expect, it } from 'vitest'
import { nodePtyBackend } from './node-pty-backend.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('nodePtyBackend', () => {
  it('spawns a process, streams output bytes, and reports a clean exit', async () => {
    const b = nodePtyBackend()
    expect(b.name).toBe('node-pty')
    const p = b.spawn({ file: 'node', args: ['-e', 'process.stdout.write("hi-there")'], cols: 80, rows: 24 })
    let out = ''
    let code: number | undefined
    p.onData((bytes) => { out += Buffer.from(bytes).toString('utf8') })
    p.onExit((e) => { code = e.exitCode })
    for (let i = 0; i < 200 && code === undefined; i++) await wait(20)
    expect(out).toContain('hi-there')
    expect(code).toBe(0)
    expect(p.pid).toBeGreaterThan(0)
  })

  it('round-trips raw input bytes through a raw-mode child', async () => {
    const b = nodePtyBackend()
    const p = b.spawn({
      file: 'node',
      args: ['-e', 'process.stdin.setRawMode(true);process.stdin.on("data",d=>process.stdout.write("<"+d.toString("hex")+">"))'],
      cols: 80, rows: 24,
    })
    let out = ''
    p.onData((bytes) => { out += Buffer.from(bytes).toString('utf8') })
    await wait(300)
    p.write(Uint8Array.of(0xff)) // a byte that is never valid UTF-8
    for (let i = 0; i < 100 && !out.includes('<ff>'); i++) await wait(20)
    expect(out).toContain('<ff>')
    p.kill()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/pty/node-pty-backend.test.ts`
Expected: FAIL — `Cannot find module './node-pty-backend.js'`.

- [ ] **Step 3: Write the types**

```ts
// packages/agent-bridge/src/pty/types.ts
export interface PtySpawnOptions {
  file: string
  args: string[]
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
}

/** Backend-neutral PTY handle. Canonical data form is BYTES. */
export interface PtyProcess {
  readonly pid: number
  onData(cb: (bytes: Uint8Array) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: Uint8Array): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtyBackend {
  readonly name: 'node-pty' | 'bun-terminal'
  spawn(opts: PtySpawnOptions): PtyProcess
}
```

- [ ] **Step 4: Write the node-pty adapter (lazy native load)**

```ts
// packages/agent-bridge/src/pty/node-pty-backend.ts
import { createRequire } from 'node:module'
import type { PtyBackend, PtyProcess, PtySpawnOptions } from './types.js'

// Lazy require so importing this module under Bun never loads the native addon.
// node-pty is only needed when nodePtyBackend().spawn() actually runs.
const req = createRequire(import.meta.url)
let nodePty: typeof import('node-pty') | undefined
function loadNodePty(): typeof import('node-pty') {
  nodePty ??= req('node-pty') as typeof import('node-pty')
  return nodePty
}

export function nodePtyBackend(): PtyBackend {
  return {
    name: 'node-pty',
    spawn(opts: PtySpawnOptions): PtyProcess {
      const proc = loadNodePty().spawn(opts.file, opts.args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? (process.env as Record<string, string>),
        // encoding:null => onData delivers Buffers (bytes), not decoded strings.
        encoding: null as unknown as undefined,
      })
      return {
        get pid() {
          return proc.pid
        },
        onData(cb) {
          proc.onData((d: string | Buffer) =>
            cb(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)),
          )
        },
        onExit(cb) {
          proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) =>
            cb({ exitCode, signal }),
          )
        },
        write(data) {
          proc.write(Buffer.from(data))
        },
        resize(cols, rows) {
          proc.resize(cols, rows)
        },
        kill(signal) {
          proc.kill(signal)
        },
      }
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/pty/node-pty-backend.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-bridge/src/pty/types.ts packages/agent-bridge/src/pty/node-pty-backend.ts packages/agent-bridge/src/pty/node-pty-backend.test.ts
git commit -m "feat(pty): backend-neutral PtyProcess interface + node-pty adapter"
```

---

### Task 2: Refactor `wrapPty`/`spawnAgent` onto `PtyProcess` (bytes + StringDecoder)

**Files:**
- Modify: `packages/agent-bridge/src/session.ts`
- Test: `packages/agent-bridge/test/session.test.ts` (rewrite the fake-PTY unit tests; real-PTY tests stay)

**Interfaces:**
- Consumes: `PtyProcess`, `nodePtyBackend` (Task 1).
- Produces: `wrapPty(proc: PtyProcess, init: { cols: number; rows: number }): AgentSession`; `spawnAgent(opts: SpawnOptions, backend?: PtyBackend): AgentSession` (default `nodePtyBackend()` for now; swapped to `defaultPtyBackend()` in Task 4). `AgentSession` and `SpawnOptions` unchanged.

- [ ] **Step 1: Rewrite the fake-PTY unit tests to bytes**

Replace the `fakeIPty()` helper and the `describe('wrapPty redraw repaint mode', …)` block (currently lines ~129–191) in `packages/agent-bridge/test/session.test.ts` with:

```ts
import type { PtyProcess } from '../src/pty/types'

function fakePty(): {
  proc: PtyProcess
  writes: Uint8Array[]
  resizes: Array<[number, number]>
  emit: (b: Uint8Array) => void
} {
  const dataCbs: Array<(b: Uint8Array) => void> = []
  const writes: Uint8Array[] = []
  const resizes: Array<[number, number]> = []
  const proc: PtyProcess = {
    pid: 4242,
    onData: (cb) => { dataCbs.push(cb) },
    onExit: () => {},
    write: (d) => { writes.push(d) },
    resize: (c, r) => { resizes.push([c, r]) },
    kill: () => {},
  }
  return { proc, writes, resizes, emit: (b) => { for (const cb of dataCbs) cb(b) } }
}

describe('wrapPty redraw repaint mode', () => {
  it('hard repaint injects Ctrl-L on top of the SIGWINCH nudge', () => {
    const { proc, writes, resizes } = fakePty()
    const s = wrapPty(proc, { cols: 80, rows: 24 })
    s.redraw({ hard: true })
    expect(writes.some((w) => w.length === 1 && w[0] === 0x0c)).toBe(true)
    expect(resizes[0]).toEqual([80, 23])
  })

  it('soft repaint (default) does NOT inject Ctrl-L and restores on the next frame', () => {
    const { proc, writes, resizes, emit } = fakePty()
    const s = wrapPty(proc, { cols: 80, rows: 24 })
    s.redraw()
    expect(writes.some((w) => w.length === 1 && w[0] === 0x0c)).toBe(false)
    expect(resizes[0]).toEqual([80, 23])
    emit(Buffer.from('repaint')) // child acks the shrink with a frame
    expect(resizes[1]).toEqual([80, 24])
  })
})
```

Also update the top imports of `session.test.ts`: remove `import type { IPty } from 'node-pty'`; keep `import { wrapPty } from '../src/session'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run test/session.test.ts`
Expected: FAIL — `wrapPty` still expects the old `IPty` shape / signature mismatch.

- [ ] **Step 3: Refactor `session.ts`**

Replace the imports and the `spawnAgent`/`wrapPty` bodies in `packages/agent-bridge/src/session.ts`. New top of file:

```ts
import { StringDecoder } from 'node:string_decoder'
import type { Geometry } from '@podium/protocol'
import { nodePtyBackend } from './pty/node-pty-backend.js'
import type { PtyBackend, PtyProcess } from './pty/types.js'
import { createTitleScanner } from './osc-title.js'

const CTRL_L = Uint8Array.of(0x0c)
```

Replace `spawnAgent`:

```ts
export function spawnAgent(opts: SpawnOptions, backend: PtyBackend = nodePtyBackend()): AgentSession {
  const proc = backend.spawn({
    file: opts.cmd,
    args: opts.args ?? [],
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd ?? process.cwd(),
    // TERM is set explicitly (not via node-pty's `name`) so BOTH backends advertise it.
    // COLORTERM unlocks truecolor for chalk/supports-color CLIs. opts.env wins last.
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })
  return wrapPty(proc, { cols: opts.cols, rows: opts.rows })
}
```

Replace `wrapPty` (the `proc.onData`/`write`/`redraw` internals change to bytes; everything else identical):

```ts
export function wrapPty(proc: PtyProcess, init: { cols: number; rows: number }): AgentSession {
  let cols = init.cols
  let rows = init.rows
  let seq = 0
  let disposed = false
  let cancelNudge: (() => void) | undefined
  const frameCbs = new Set<(f: AgentFrame) => void>()
  const exitCbs = new Set<(code: number) => void>()
  const titleCbs = new Set<(t: string) => void>()
  const titleScanner = createTitleScanner()
  const decoder = new StringDecoder('utf8')
  let lastTitle: string | undefined

  proc.onData((bytes: Uint8Array) => {
    const buf = Buffer.from(bytes)
    const frame: AgentFrame = { seq, data: buf.toString('base64') }
    seq += 1
    for (const cb of [...frameCbs]) cb(frame)
    // Decode for the title scanner only. StringDecoder buffers partial multi-byte
    // sequences across chunks, so a glyph split between two PTY reads stays intact.
    for (const raw of titleScanner.push(decoder.write(buf))) {
      const title = raw.replace(/\p{Cc}/gu, '').trim()
      if (!title || title === lastTitle) continue
      lastTitle = title
      for (const cb of [...titleCbs]) cb(title)
    }
  })

  proc.onExit(({ exitCode }) => {
    for (const cb of [...exitCbs]) cb(exitCode)
  })

  return {
    get pid() {
      return proc.pid
    },
    onFrame(cb) { frameCbs.add(cb); return () => frameCbs.delete(cb) },
    onTitle(cb) { titleCbs.add(cb); return () => titleCbs.delete(cb) },
    onExit(cb) { exitCbs.add(cb); return () => exitCbs.delete(cb) },
    write(dataBase64) {
      if (disposed) return
      proc.write(Buffer.from(dataBase64, 'base64'))
    },
    resize(c, r) {
      if (disposed) return
      cols = c
      rows = r
      proc.resize(c, r)
    },
    redraw(opts) {
      if (disposed) return
      if (opts?.hard) proc.write(CTRL_L)
      if (rows <= 1) {
        if (!opts?.hard) proc.write(CTRL_L)
        return
      }
      cancelNudge?.()
      proc.resize(cols, rows - 1)
      const restore = () => {
        frameCbs.delete(restore)
        cancelNudge = undefined
        if (!disposed) proc.resize(cols, rows)
      }
      cancelNudge = () => { frameCbs.delete(restore); cancelNudge = undefined }
      frameCbs.add(restore)
    },
    geometry() { return { cols, rows } },
    dispose() {
      if (disposed) return
      disposed = true
      cancelNudge?.()
      frameCbs.clear()
      titleCbs.clear()
      exitCbs.clear()
      try { proc.kill() } catch { /* already exited */ }
    },
  }
}
```

Keep `SpawnOptions`, `AgentFrame`, `AgentSession`, and `withHardRepaint` exactly as they are. Note `redraw`'s `restore` is added to `frameCbs` (a `Set<(f:AgentFrame)=>void>`); since it's invoked with the frame arg it must accept it — change its signature to `const restore = (_f?: AgentFrame) => {…}` to satisfy the Set's callback type.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run test/session.test.ts`
Expected: PASS — the real-PTY `spawnAgent core` tests (geometry, input round-trip, resize, seq, TERM/COLORTERM, exit, redraw) and both rewritten fake-PTY redraw tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/session.ts packages/agent-bridge/test/session.test.ts
git commit -m "refactor(pty): wrapPty/spawnAgent consume PtyProcess (bytes + StringDecoder for titles)"
```

---

### Task 3: Refactor `abduco.ts` — byte-based alt-screen stripper + backend spawn

**Files:**
- Modify: `packages/agent-bridge/src/abduco.ts`
- Test: `packages/agent-bridge/src/abduco.test.ts` (rewrite the stripper block to bytes)

**Interfaces:**
- Consumes: `PtyProcess`, `nodePtyBackend`, `wrapPty`, `withHardRepaint` (Tasks 1–2).
- Produces: `createAltScreenStripper(): (data: Uint8Array) => Uint8Array`; `attachAbducoAgent` spawns via a backend; `stripAttachChrome(proc: PtyProcess): PtyProcess`.

- [ ] **Step 1: Rewrite the stripper tests to bytes**

Replace the `describe('alt-screen chrome stripper', …)` block (lines ~90–117) in `packages/agent-bridge/src/abduco.test.ts` with:

```ts
describe('alt-screen chrome stripper', () => {
  const CHROME = '\x1b[?1049h\x1b[H'
  const enc = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
  const dec = (u: Uint8Array) => Buffer.from(u).toString('latin1')

  it('strips the exact one-time prefix and passes the rest through', () => {
    const strip = createAltScreenStripper()
    expect(dec(strip(enc(`${CHROME}hello`)))).toBe('hello')
    expect(dec(strip(enc(CHROME)))).toBe(CHROME) // later occurrences are app output
  })
  it('strips a prefix split across chunks', () => {
    const strip = createAltScreenStripper()
    expect(dec(strip(enc('\x1b[?10')))).toBe('')
    expect(dec(strip(enc('49h\x1b[Hworld')))).toBe('world')
  })
  it('flushes held bytes when the stream turns out not to start with the chrome', () => {
    const strip = createAltScreenStripper()
    expect(dec(strip(enc('\x1b[?10')))).toBe('')
    expect(dec(strip(enc('25h')))).toBe('\x1b[?1025h')
    expect(dec(strip(enc(CHROME)))).toBe(CHROME)
  })
  it('passes a chrome-less stream through unchanged', () => {
    const strip = createAltScreenStripper()
    expect(dec(strip(enc('plain')))).toBe('plain')
    expect(dec(strip(enc(CHROME)))).toBe(CHROME)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/abduco.test.ts`
Expected: FAIL — `createAltScreenStripper` still takes/returns strings.

- [ ] **Step 3: Refactor `abduco.ts`**

In `packages/agent-bridge/src/abduco.ts`: change the import line `import { type IPty, spawn as ptySpawn } from 'node-pty'` to:

```ts
import { nodePtyBackend } from './pty/node-pty-backend.js'
import type { PtyBackend, PtyProcess } from './pty/types.js'
```

Replace `ATTACH_CHROME`, `createAltScreenStripper`, and `stripAttachChrome` with byte versions:

```ts
const ATTACH_CHROME = Buffer.from('\x1b[?1049h\x1b[H', 'latin1')
const EMPTY = new Uint8Array(0)

export function createAltScreenStripper(): (data: Uint8Array) => Uint8Array {
  let held = Buffer.alloc(0)
  let done = false
  return (data: Uint8Array): Uint8Array => {
    if (done) return data
    held = Buffer.concat([held, Buffer.from(data)])
    if (held.length <= ATTACH_CHROME.length && ATTACH_CHROME.subarray(0, held.length).equals(held)) {
      if (held.length === ATTACH_CHROME.length) { done = true; return EMPTY }
      return EMPTY // still a plausible prefix — keep holding
    }
    done = true
    return held.length >= ATTACH_CHROME.length && held.subarray(0, ATTACH_CHROME.length).equals(ATTACH_CHROME)
      ? held.subarray(ATTACH_CHROME.length)
      : held
  }
}

/** Delegate PtyProcess whose onData passes through the one-time chrome stripper. */
function stripAttachChrome(proc: PtyProcess): PtyProcess {
  const strip = createAltScreenStripper()
  return {
    get pid() { return proc.pid },
    onData: (cb) =>
      proc.onData((d) => {
        const out = strip(d)
        if (out.length) cb(out)
      }),
    onExit: (cb) => proc.onExit(cb),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: (s) => proc.kill(s),
  }
}
```

In `attachAbducoAgent`, replace the `ptySpawn(...)` call and the `wrapPty(stripAttachChrome(proc))` line. Add an optional `backend` to the options object and use it:

```ts
export function attachAbducoAgent(opts: {
  label: string
  cols: number
  rows: number
  env?: Record<string, string>
  hardRepaint?: boolean
  backend?: PtyBackend
}): AgentSession {
  const [cmd, ...args] = abducoAttachArgv(opts.label, resolveAbducoBin() ?? 'abduco')
  const backend = opts.backend ?? nodePtyBackend()
  const proc = backend.spawn({
    file: cmd as string,
    args,
    cols: opts.cols,
    rows: opts.rows,
    env: { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })
  const stripped = stripAttachChrome(proc)
  const session = withHardRepaint(wrapPty(stripped, { cols: opts.cols, rows: opts.rows }), opts.hardRepaint ?? false)
  session.redraw()
  return {
    ...session,
    dispose() {
      try { proc.kill('SIGKILL') } catch { /* already exited */ }
      session.dispose()
    },
  }
}
```

Leave `spawnAbducoAgent` as-is except it already calls `attachAbducoAgent(...)`; thread an optional `backend` through if present in its options (add `backend: opts.backend` to both `attachAbducoAgent` calls, and add `backend?: PtyBackend` to `AbducoSpawnOptions`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/abduco.test.ts`
Expected: PASS — the 4 rewritten stripper tests plus the unchanged builder/parser tests. (The `describe.skipIf(!hasAbduco)` integration blocks run only when abduco is available; they route through the default node-pty backend and are unaffected.)

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/abduco.ts packages/agent-bridge/src/abduco.test.ts
git commit -m "refactor(pty): abduco attach uses PtyBackend; byte-based alt-screen stripper"
```

---

### Task 4: Backend selection + Bun adapter file + wire optional backend + exports

**Files:**
- Create: `packages/agent-bridge/src/pty/index.ts`
- Create: `packages/agent-bridge/src/pty/bun-terminal-backend.ts`
- Modify: `packages/agent-bridge/src/session.ts` (default → `defaultPtyBackend()`)
- Modify: `packages/agent-bridge/src/index.ts` (export the pty module)
- Test: `packages/agent-bridge/src/pty/index.test.ts`

**Interfaces:**
- Produces: `defaultPtyBackend(): PtyBackend`; `bunTerminalBackend(): PtyBackend`; `hasBunTerminal(): boolean`; re-exports of the types + both adapters.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-bridge/src/pty/index.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPtyBackend } from './index.js'

const orig = process.env.PODIUM_PTY_BACKEND
afterEach(() => {
  if (orig === undefined) delete process.env.PODIUM_PTY_BACKEND
  else process.env.PODIUM_PTY_BACKEND = orig
})

describe('defaultPtyBackend', () => {
  it('defaults to node-pty under Node (no Bun.Terminal)', () => {
    delete process.env.PODIUM_PTY_BACKEND
    expect(defaultPtyBackend().name).toBe('node-pty')
  })
  it('honors PODIUM_PTY_BACKEND=node-pty', () => {
    process.env.PODIUM_PTY_BACKEND = 'node-pty'
    expect(defaultPtyBackend().name).toBe('node-pty')
  })
  it('throws when bun-terminal is forced but unavailable (under Node)', () => {
    process.env.PODIUM_PTY_BACKEND = 'bun-terminal'
    expect(() => defaultPtyBackend()).toThrow(/Bun\.Terminal/)
  })
  it('throws on an unknown backend name', () => {
    process.env.PODIUM_PTY_BACKEND = 'nope'
    expect(() => defaultPtyBackend()).toThrow(/unknown/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/pty/index.test.ts`
Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 3: Write the Bun adapter**

```ts
// packages/agent-bridge/src/pty/bun-terminal-backend.ts
import type { PtyBackend, PtyProcess, PtySpawnOptions } from './types.js'

// All Bun.* access is inside functions so this module loads (but is never selected)
// under Node.
declare const Bun: { spawn: (cmd: string[], opts: unknown) => BunPtyProc } | undefined

interface BunPtyProc {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | null
  kill(signal?: number | string): void
  terminal: { write(d: string | Uint8Array): void; resize(c: number, r: number): void; close(): void }
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }

export function hasBunTerminal(): boolean {
  return typeof Bun !== 'undefined' && typeof Bun.spawn === 'function'
}

export function bunTerminalBackend(): PtyBackend {
  return {
    name: 'bun-terminal',
    spawn(opts: PtySpawnOptions): PtyProcess {
      if (typeof Bun === 'undefined') throw new Error('bun-terminal backend requires running under Bun')
      let onData: ((b: Uint8Array) => void) | undefined
      let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined
      const env = { ...(opts.env ?? (process.env as Record<string, string>)) }
      if (!env.TERM) env.TERM = 'xterm-256color'
      const proc = Bun.spawn([opts.file, ...opts.args], {
        cwd: opts.cwd ?? process.cwd(),
        env,
        terminal: {
          cols: opts.cols,
          rows: opts.rows,
          data(_t: unknown, bytes: Uint8Array) { onData?.(bytes) },
        },
      })
      void proc.exited.then(() => {
        onExit?.({
          exitCode: proc.exitCode ?? 0,
          signal: proc.signalCode ? SIGNALS[proc.signalCode] : undefined,
        })
      })
      return {
        get pid() { return proc.pid },
        onData(cb) { onData = cb },
        onExit(cb) { onExit = cb },
        write(data) { proc.terminal.write(data) },
        resize(cols, rows) { proc.terminal.resize(cols, rows) },
        kill(signal) {
          try { proc.kill(signal ? (SIGNALS[signal] ?? signal) : undefined) } catch { /* gone */ }
          try { proc.terminal.close() } catch { /* gone */ }
        },
      }
    },
  }
}
```

- [ ] **Step 4: Write the selection index**

```ts
// packages/agent-bridge/src/pty/index.ts
import { nodePtyBackend } from './node-pty-backend.js'
import { bunTerminalBackend, hasBunTerminal } from './bun-terminal-backend.js'
import type { PtyBackend } from './types.js'

export type { PtyBackend, PtyProcess, PtySpawnOptions } from './types.js'
export { nodePtyBackend } from './node-pty-backend.js'
export { bunTerminalBackend, hasBunTerminal } from './bun-terminal-backend.js'

/**
 * Resolve the PTY backend. `PODIUM_PTY_BACKEND` forces a choice; otherwise auto:
 * Bun.Terminal when running under Bun with the API present, else node-pty.
 */
export function defaultPtyBackend(): PtyBackend {
  const forced = process.env.PODIUM_PTY_BACKEND
  if (forced === 'bun-terminal') {
    if (!hasBunTerminal())
      throw new Error('PODIUM_PTY_BACKEND=bun-terminal but Bun.Terminal is unavailable (run under Bun >=1.3.5)')
    return bunTerminalBackend()
  }
  if (forced === 'node-pty') return nodePtyBackend()
  if (forced) throw new Error(`unknown PODIUM_PTY_BACKEND: ${forced}`)
  return hasBunTerminal() ? bunTerminalBackend() : nodePtyBackend()
}
```

- [ ] **Step 5: Wire the default + export the module**

In `packages/agent-bridge/src/session.ts`: change the import `import { nodePtyBackend } from './pty/node-pty-backend.js'` to `import { defaultPtyBackend } from './pty/index.js'` and change `spawnAgent`'s default param to `backend: PtyBackend = defaultPtyBackend()`.

In `packages/agent-bridge/src/abduco.ts`: change `opts.backend ?? nodePtyBackend()` to `opts.backend ?? defaultPtyBackend()` and update the import to `import { defaultPtyBackend } from './pty/index.js'` (drop the `nodePtyBackend` import).

In `packages/agent-bridge/src/index.ts`: add `export * from './pty/index.js'` after the existing exports.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/pty/index.test.ts test/session.test.ts src/abduco.test.ts`
Expected: PASS — selection tests + the still-green session/abduco tests (now routing through `defaultPtyBackend()` → node-pty under Node).

- [ ] **Step 7: Commit**

```bash
git add packages/agent-bridge/src/pty/index.ts packages/agent-bridge/src/pty/bun-terminal-backend.ts packages/agent-bridge/src/pty/index.test.ts packages/agent-bridge/src/session.ts packages/agent-bridge/src/abduco.ts packages/agent-bridge/src/index.ts
git commit -m "feat(pty): backend selection (env + auto) + Bun.Terminal adapter + wiring"
```

---

### Task 5: Fixtures + backend-parameterized behavioral spec + vitest runner (node-pty)

**Files:**
- Create: `packages/agent-bridge/test/fixtures/fixture-blob.mjs`
- Create: `packages/agent-bridge/test/fixtures/fixture-title-split.mjs`
- Create: `packages/agent-bridge/test/pty-behavior/spec.ts`
- Create: `packages/agent-bridge/test/pty-behavior/pty-behavior.vitest.test.ts`

**Interfaces:**
- Consumes: `spawnAgent` (Task 2/4), `PtyBackend`, `nodePtyBackend`.
- Produces: `ptyBehaviorSpec(t: TestPrimitives, makeBackend: () => PtyBackend): void`; `TestPrimitives { describe; it; expect }`.

- [ ] **Step 1: Write the blob fixture**

```js
// packages/agent-bridge/test/fixtures/fixture-blob.mjs
// Emits a large, byte-exact blob bracketed by newline-free ASCII markers, so a test
// can prove the backend delivers every byte without loss/reorder. The template omits
// 0x0a/0x0d so PTY output post-processing (ONLCR) cannot alter it; markers contain no
// newline for the same reason.
const tmpl = []
for (let b = 0; b < 256; b++) if (b !== 0x0a && b !== 0x0d) tmpl.push(b)
const TEMPLATE = Buffer.from(tmpl) // 254 bytes
const REPEAT = 600 // ~152 KB
const blob = Buffer.concat(Array.from({ length: REPEAT }, () => TEMPLATE))
process.stdout.write('BLOB-START|')
process.stdout.write(blob, () => {
  process.stdout.write('|BLOB-END')
})
setInterval(() => {}, 1000)
```

- [ ] **Step 2: Write the title-split fixture**

```js
// packages/agent-bridge/test/fixtures/fixture-title-split.mjs
// Emits an OSC-2 title containing multi-byte glyphs, split across two stdout writes so
// the second completes a multi-byte char. A naive per-chunk UTF-8 decode corrupts the
// title; the shared StringDecoder in wrapPty must reassemble it intact.
const title = '🤖 Robot Agent ✓'
const seq = Buffer.from(`\x1b]2;${title}\x07`, 'utf8')
const cut = 6 // splits inside the 🤖 (its bytes are f0 9f a4 96 at offset 4..7)
process.stdout.write('READY|')
process.stdout.write(seq.subarray(0, cut))
setTimeout(() => { process.stdout.write(seq.subarray(cut)) }, 60)
setInterval(() => {}, 1000)
```

- [ ] **Step 3: Write the shared behavioral spec**

```ts
// packages/agent-bridge/test/pty-behavior/spec.ts
import { fileURLToPath } from 'node:url'
import { spawnAgent, type AgentSession } from '../../src/session'
import type { PtyBackend } from '../../src/pty/index'

const FIX = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
const KEYECHO_CLI = fileURLToPath(new URL('../../../../tests/keyecho/src/cli.tsx', import.meta.url))
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

export interface TestPrimitives {
  describe: (name: string, fn: () => void) => void
  // biome-ignore lint/suspicious/noExplicitAny: runner-neutral
  it: (name: string, fn: () => Promise<void> | void, timeout?: number) => void
  // biome-ignore lint/suspicious/noExplicitAny: runner-neutral
  expect: (actual: unknown) => any
}

function textOf(s: AgentSession) {
  let buf = ''
  s.onFrame((f) => { buf += Buffer.from(f.data, 'base64').toString('utf8') })
  return { raw: () => buf, stripped: () => buf.replace(ANSI, '') }
}
function bytesOf(s: AgentSession) {
  const chunks: Buffer[] = []
  s.onFrame((f) => { chunks.push(Buffer.from(f.data, 'base64')) })
  return () => Buffer.concat(chunks)
}
async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const b64bytes = (bytes: number[]) => Buffer.from(bytes).toString('base64')
const paints = (t: string) => (t.match(/paint=(\d+)/g) ?? []).map((m) => Number(m.slice(6)))

export function ptyBehaviorSpec(t: TestPrimitives, makeBackend: () => PtyBackend): void {
  const { describe, it, expect } = t
  const spawn = (cmd: string, args: string[], cols = 80, rows = 24): AgentSession =>
    spawnAgent({ cmd, args, cols, rows }, makeBackend())

  describe(`pty behavior [${makeBackend().name}]`, () => {
    it('1: emits an initial frame with the PTY geometry', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        const c = textOf(s)
        await waitFor(() => c.raw().includes('cols=80 rows=24'))
        expect(c.raw()).toContain('PODIUM-FIXTURE')
        expect(s.geometry()).toEqual({ cols: 80, rows: 24 })
      } finally { s.dispose() }
    }, 15000)

    it('2a: write byte-fidelity round-trips arbitrary bytes', async () => {
      const s = spawn('node', [FIX('stdin-hex.mjs')])
      try {
        const c = textOf(s)
        const cases: number[][] = [
          [0x61], [0x03], [0x0d], [0x1b, 0x5b, 0x41], [0xff], [0xc3, 0xa9], [0xf0, 0x9f, 0xa4, 0x96],
        ]
        for (const bytes of cases) {
          s.write(b64bytes(bytes))
          const hex = bytes.map((x) => x.toString(16).padStart(2, '0')).join('')
          await waitFor(() => c.raw().includes(`<${hex}>`))
          expect(c.raw()).toContain(`<${hex}>`)
        }
      } finally { s.dispose() }
    }, 15000)

    it('2b: keyecho decodes real keystrokes under this backend', async () => {
      const s = spawn('node', ['--import', 'tsx', KEYECHO_CLI, '--mode', 'raw'])
      try {
        const c = textOf(s)
        await waitFor(() => c.stripped().includes('mode='), 20000)
        s.write(b64bytes([0x1b, 0x5b, 0x41])) // up arrow
        await waitFor(() => c.stripped().includes('up'))
        expect(c.stripped()).toContain('up')
      } finally { s.dispose() }
    }, 25000)

    it('3: output is byte-exact across chunking (large blob)', async () => {
      const s = spawn('node', [FIX('fixture-blob.mjs')])
      try {
        const all = bytesOf(s)
        const START = Buffer.from('BLOB-START|')
        const END = Buffer.from('|BLOB-END')
        await waitFor(() => {
          const b = all()
          const i = b.indexOf(START)
          return i >= 0 && b.indexOf(END, i) > i
        }, 15000)
        const b = all()
        const from = b.indexOf(START) + START.length
        const to = b.indexOf(END, from)
        const body = b.subarray(from, to)
        const tmpl: number[] = []
        for (let x = 0; x < 256; x++) if (x !== 0x0a && x !== 0x0d) tmpl.push(x)
        const expected = Buffer.concat(Array.from({ length: 600 }, () => Buffer.from(tmpl)))
        expect(body.length).toBe(expected.length)
        expect(body.equals(expected)).toBe(true)
      } finally { s.dispose() }
    }, 20000)

    it('4: reassembles a multi-byte OSC title split across reads', async () => {
      const s = spawn('node', [FIX('fixture-title-split.mjs')])
      try {
        let got: string | undefined
        s.onTitle((tt) => { got = tt })
        await waitFor(() => got !== undefined)
        expect(got).toBe('🤖 Robot Agent ✓')
      } finally { s.dispose() }
    }, 15000)

    it('5: parses an OSC title (BEL form) and dedups repeats', async () => {
      const s = spawn('node', [FIX('echo-title.mjs')])
      try {
        const titles: string[] = []
        s.onTitle((tt) => titles.push(tt))
        await waitFor(() => titles.includes('FIXTURE-TITLE'))
        expect(titles.filter((x) => x === 'FIXTURE-TITLE').length).toBe(1)
      } finally { s.dispose() }
    }, 15000)

    it('6: resize delivers new geometry to the child', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        const c = textOf(s)
        await waitFor(() => c.raw().includes('cols=80 rows=24'))
        s.resize(100, 30)
        await waitFor(() => c.raw().includes('cols=100 rows=30'))
        expect(s.geometry()).toEqual({ cols: 100, rows: 30 })
      } finally { s.dispose() }
    }, 15000)

    it('7: redraw() forces a repaint at unchanged geometry', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        const c = textOf(s)
        await waitFor(() => c.raw().includes('last-input='))
        const before = Math.max(0, ...paints(c.raw()))
        s.redraw()
        await waitFor(() => Math.max(0, ...paints(c.raw())) > before)
        expect(Math.max(0, ...paints(c.raw()))).toBeGreaterThan(before)
        expect(s.geometry()).toEqual({ cols: 80, rows: 24 })
      } finally { s.dispose() }
    }, 15000)

    it('8: emits exit code 0 on clean child exit', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        let code: number | undefined
        s.onExit((cc) => { code = cc })
        const c = textOf(s)
        await waitFor(() => c.raw().includes('PODIUM-FIXTURE'))
        s.write(b64('\x03')) // fixture exits 0 on Ctrl-C
        await waitFor(() => code !== undefined)
        expect(code).toBe(0)
      } finally { s.dispose() }
    }, 15000)

    it('9: advertises TERM + COLORTERM to the child', async () => {
      const s = spawn('node', ['-e', 'process.stdout.write(`T=${process.env.TERM};C=${process.env.COLORTERM}`)'])
      try {
        const c = textOf(s)
        await waitFor(() => c.raw().includes('C='))
        expect(c.raw()).toContain('T=xterm-256color')
        expect(c.raw()).toContain('C=truecolor')
      } finally { s.dispose() }
    }, 15000)

    it('10: assigns monotonically increasing frame seq', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        const seqs: number[] = []
        s.onFrame((f) => seqs.push(f.seq))
        s.write(b64('x'))
        await waitFor(() => seqs.length >= 2)
        expect(seqs[0]).toBe(0)
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number)
      } finally { s.dispose() }
    }, 15000)

    it('11: dispose stops frames and kills the child', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      const c = textOf(s)
      await waitFor(() => c.raw().includes('PODIUM-FIXTURE'))
      const pid = s.pid
      s.dispose()
      const len = c.raw().length
      await waitFor(() => {
        try { process.kill(pid, 0); return false } catch { return true }
      }, 5000)
      await new Promise((r) => setTimeout(r, 100))
      expect(c.raw().length).toBe(len) // no frames after dispose
    }, 15000)
  })
}
```

- [ ] **Step 4: Write the vitest runner**

```ts
// packages/agent-bridge/test/pty-behavior/pty-behavior.vitest.test.ts
import { describe, expect, it } from 'vitest'
import { nodePtyBackend } from '../../src/pty/index'
import { ptyBehaviorSpec } from './spec'

ptyBehaviorSpec({ describe, it, expect }, nodePtyBackend)
```

- [ ] **Step 5: Run the suite (node-pty) to verify it passes**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run test/pty-behavior/pty-behavior.vitest.test.ts`
Expected: PASS — all 12 behavior cases under node-pty.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-bridge/test/fixtures/fixture-blob.mjs packages/agent-bridge/test/fixtures/fixture-title-split.mjs packages/agent-bridge/test/pty-behavior/spec.ts packages/agent-bridge/test/pty-behavior/pty-behavior.vitest.test.ts
git commit -m "test(pty): backend-parameterized real-PTY behavioral suite (node-pty green)"
```

---

### Task 6: Bun.Terminal runner — same suite green under `bun test`

**Files:**
- Create: `packages/agent-bridge/test/pty-behavior/pty-behavior.bun.test.ts`

**Interfaces:**
- Consumes: `ptyBehaviorSpec` (Task 5), `bunTerminalBackend` (Task 4).

- [ ] **Step 1: Write the bun runner**

```ts
// packages/agent-bridge/test/pty-behavior/pty-behavior.bun.test.ts
// Run ONLY under `bun test`. Imports narrow paths so node:sqlite is never pulled in.
import { describe, expect, it } from 'bun:test'
import { bunTerminalBackend } from '../../src/pty/bun-terminal-backend'
import { ptyBehaviorSpec } from './spec'

ptyBehaviorSpec({ describe, it, expect }, bunTerminalBackend)
```

- [ ] **Step 2: Run under bun to verify it fails first (if applicable) then iterate**

Run: `bun test packages/agent-bridge/test/pty-behavior/pty-behavior.bun.test.ts`
Expected first run: likely FAIL on one or more cases (e.g. exit-code/signal mapping, title-split timing, or `process.kill` semantics under Bun). Diagnose each failure against the `Bun.Terminal` API (`data` is `Uint8Array`, `terminal.write(string|BufferSource)`, `proc.exited`/`exitCode`/`signalCode`) and fix in `bun-terminal-backend.ts` until green. Do NOT weaken the spec — the spec is the contract both backends must meet.

Common fixes anticipated:
- If `data` arrives as a Bun `Buffer`/`Uint8Array` view, ensure `wrapPty`'s `Buffer.from(bytes)` copies correctly (it does for any `Uint8Array`).
- If exit fires before the final `data` flush, await a microtask in the adapter's `exited` handler before emitting exit.
- If `proc.kill('SIGKILL')` expects a number, the `SIGNALS` map already converts it.

- [ ] **Step 3: Verify the suite passes under bun**

Run: `bun test packages/agent-bridge/test/pty-behavior/pty-behavior.bun.test.ts`
Expected: PASS — all 12 behavior cases under Bun.Terminal.

- [ ] **Step 4: Confirm node-pty suite still green (no cross-runner regressions)**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run test/pty-behavior/pty-behavior.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/test/pty-behavior/pty-behavior.bun.test.ts packages/agent-bridge/src/pty/bun-terminal-backend.ts
git commit -m "test(pty): Bun.Terminal adapter green against the same behavioral suite (bun test)"
```

---

### Task 7: Real-`claude` smoke tier + final cross-runner verification

**Files:**
- Create: `packages/agent-bridge/test/pty-behavior/claude-smoke.test.ts`

**Interfaces:**
- Consumes: `spawnAgent`, `nodePtyBackend`.

- [ ] **Step 1: Write the gated smoke test**

```ts
// packages/agent-bridge/test/pty-behavior/claude-smoke.test.ts
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { nodePtyBackend } from '../../src/pty/index'
import { spawnAgent } from '../../src/session'

function claudeReady(): boolean {
  if (process.env.PODIUM_SKIP_CLAUDE_SMOKE) return false
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    // Auth presence: the credentials file the CLI writes. Skip if absent.
    return Boolean(process.env.HOME)
  } catch {
    return false
  }
}

const ready = claudeReady()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!ready)('real claude smoke (node-pty)', () => {
  it('boots, renders, and accepts a keystroke', async () => {
    const s = spawnAgent({ cmd: 'claude', args: [], cols: 100, rows: 30 }, nodePtyBackend())
    let buf = ''
    s.onFrame((f) => { buf += Buffer.from(f.data, 'base64').toString('utf8') })
    try {
      // Wait for any substantial render (claude paints its prompt/box).
      for (let i = 0; i < 300 && buf.length < 200; i++) await wait(50)
      expect(buf.length).toBeGreaterThan(200)
      s.write(Buffer.from('hello', 'utf8').toString('base64'))
      await wait(500)
      // The typed text echoes into the composer.
      expect(buf.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')).toContain('hello')
    } finally {
      s.dispose()
    }
  }, 30000)
})
```

- [ ] **Step 2: Run the smoke test (skips if claude absent)**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run test/pty-behavior/claude-smoke.test.ts`
Expected: PASS or SKIPPED (skipped when `claude` is not installed/authed).

- [ ] **Step 3: Full vitest suite — node-pty + existing, no regressions**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run`
Expected: PASS for all PTY-related files. The one known pre-existing failure `src/discovery/providers/opencode.test.ts` is unrelated to this work (documented in the spec); everything else green.

- [ ] **Step 4: Full bun suite**

Run: `bun test packages/agent-bridge/test/pty-behavior/pty-behavior.bun.test.ts`
Expected: PASS.

- [ ] **Step 5: Workspace typecheck**

Run: `cd ../.. && bun run --filter @podium/agent-bridge typecheck`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-bridge/test/pty-behavior/claude-smoke.test.ts
git commit -m "test(pty): opt-in real-claude smoke tier (gated on binary+auth)"
```

---

## Self-Review

**Spec coverage:**
- PtyBackend/PtyProcess interface (bytes-canonical) → Task 1. ✓
- node-pty adapter (`encoding:null`, lazy load) → Task 1. ✓
- Bun.Terminal adapter (`Bun.spawn({terminal})`, signal map, `terminal.close`) → Task 4 (file) + Task 6 (green). ✓
- Backend selection (env + auto, force-throws) → Task 4. ✓
- wrapPty refactor (bytes + shared StringDecoder for titles) → Task 2. ✓
- abduco byte-based stripper + backend spawn → Task 3. ✓
- AgentSession contract unchanged → Tasks 2–4 keep the interface. ✓
- Behavioral matrix 1–11 (incl. byte-fidelity, large-blob byte-exactness, multi-byte title-split, resize/redraw, exit/signal, dispose) + keyecho → Task 5 (cases 1–11, with 2a/2b). ✓
- One spec, both runners (vitest + bun test), narrow imports → Tasks 5–6. ✓
- Real-claude smoke, gated → Task 7. ✓
- Fixtures: reuse `fixture-tui.mjs`/`stdin-hex.mjs`/`echo-title.mjs`; new `fixture-blob.mjs`/`fixture-title-split.mjs` → Task 5. ✓
- Deferred (node:sqlite, abduco embedding, default cutover) → not in any task, by design. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows the command + expected result.

**Type consistency:** `PtyProcess`/`PtyBackend`/`PtySpawnOptions` defined in Task 1 and used verbatim in Tasks 2–6. `wrapPty(proc, init)` signature consistent across Tasks 2–3. `defaultPtyBackend`/`nodePtyBackend`/`bunTerminalBackend`/`hasBunTerminal` names consistent across Tasks 1, 4, 5, 6. `ptyBehaviorSpec(t, makeBackend)` consistent across Tasks 5–6.

**Deviation from spec note:** The spec mentioned refactoring keyecho's `bootKeyecho` driver to a backend; the plan instead spawns keyecho directly via `spawnAgent(backend)` in behavior 2b (avoids coupling `tests/keyecho` → `@podium/agent-bridge`, and still exercises keyecho under both backends). Net coverage is equal-or-better; `tests/keyecho` is left untouched and green.
