# Podium Loop Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the daemon's background work (the 15s discovery scan and the `/proc` memory walk) from blocking the interactive event loop, so keystroke echo never stalls.

**Architecture:** Move heavy batch jobs onto a `worker_threads` Worker (its own event loop) owned by the daemon. Replace the periodic full conversation rescan with delta emission (changed + removed) computed on the worker, plus event-driven single-file refresh from the existing per-session transcript tailer. Add permanent event-loop-lag instrumentation to server and daemon.

**Tech Stack:** TypeScript, Bun (live runtime; `bun --conditions=@podium/source scripts/daemon.ts`), `node:worker_threads`, `node:perf_hooks` (`monitorEventLoopDelay`), vitest, node:sqlite/bun:sqlite (`@podium/core/sqlite`).

## Global Constraints

- Live daemon runs from **source under Bun**; worker entry must load as `.ts` via `new Worker(new URL('./discovery-worker.ts', import.meta.url), { type: 'module' })`.
- The daemon is single-threaded and serves 90+ live PTY sessions; **no new synchronous work > a few ms may be added to its main loop.**
- Errors are **never silent** — every dropped/failed path logs (throttled where it could flood), matching the existing `warnDroppedControlFrame` / `console.warn('[podium] …')` convention.
- Follow existing module style: `type: 'module'`, named exports, small focused files, `unref()` on background timers.
- Job-logic lives in **pure, separately-testable functions** (`discovery-jobs.ts`); the worker entry is a thin shell; the worker client takes an **injectable worker factory** so most tests need no real thread.
- Bun-compile/packaging compatibility (the parked dist build) is a **verification checklist item**, not a code change here.

---

## File Structure

**Create:**
- `packages/core/src/loop-metrics.ts` — `monitorEventLoopDelay` sampler + long-tick logger (shared by server + daemon).
- `packages/core/src/loop-metrics.test.ts`
- `apps/daemon/src/discovery-jobs.ts` — pure job functions: `runMemoryBreakdownJob`, `runIndexRefreshJob`.
- `apps/daemon/src/discovery-jobs.test.ts`
- `apps/daemon/src/discovery-worker.ts` — thin worker entry (parentPort ↔ discovery-jobs).
- `apps/daemon/src/worker-client.ts` — `DiscoveryWorkerClient` (spawn, runJob, coalesce, timeout, restart).
- `apps/daemon/src/worker-client.test.ts`
- `apps/daemon/src/worker-isolation.test.ts` — Bun integration test: heavy job does not block the main loop.
- `scripts/loop-probe.mjs` — promote the diagnostic prober (copy from the findings report's tooling).

**Modify:**
- `packages/core/src/index.ts` — export loop-metrics.
- `apps/server/src/server.ts` (or `index.ts`) and `apps/daemon/src/daemon.ts` — start the loop-metrics sampler at boot (env-gated).
- `apps/daemon/src/daemon.ts` — route `memoryBreakdown` and the discovery scan through the worker client; emit deltas; event-driven refresh from the tail hook.
- `apps/server/src/relay.ts` + `apps/server/src/store.ts` — apply conversation deltas (upsert changed + delete removed).
- `packages/protocol/src/messages.ts` — add `removed` to the conversation result message (or a new `conversationsDelta`).
- `packages/agent-bridge/src/discovery/scanner.ts` — add a delta-returning result (`changed`, `removed`) to `scanAgentConversationsCached`.

---

## Phase 0 — Permanent loop instrumentation (independent; ship first)

### Task 1: `loop-metrics` sampler + long-tick logger

**Files:**
- Create: `packages/core/src/loop-metrics.ts`
- Test: `packages/core/src/loop-metrics.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './loop-metrics.js'`)

**Interfaces:**
- Produces:
  - `startLoopMetrics(opts: { label: string; longTickMs?: number; sampleMs?: number; log?: (m: string) => void; now?: () => number }): { stop(): void; snapshot(): { p50: number; p99: number; max: number } }`
  - Behavior: samples `monitorEventLoopDelay`; every `sampleMs` (default 1000) checks max; if a tick exceeded `longTickMs` (default 100) it calls `log` with `"[podium:loop] <label> long tick <ms>ms"` (throttled to once per `sampleMs`). Env-gated by the caller via `PODIUM_LOOP_PROFILE`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/loop-metrics.test.ts
import { describe, it, expect } from 'vitest'
import { startLoopMetrics } from './loop-metrics.js'

describe('loop-metrics', () => {
  it('reports percentiles and warns on a long tick', async () => {
    const logs: string[] = []
    const m = startLoopMetrics({ label: 'test', longTickMs: 20, sampleMs: 50, log: (s) => logs.push(s) })
    // Block the loop ~80ms so a long tick is recorded.
    const end = Date.now() + 80
    while (Date.now() < end) {/* busy */}
    await new Promise((r) => setTimeout(r, 120))
    const snap = m.snapshot()
    m.stop()
    expect(snap.max).toBeGreaterThan(20)
    expect(logs.some((l) => l.includes('long tick'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/user/src/other/podium/.claude/worktrees/typing-latency-profiling && bun run vitest run packages/core/src/loop-metrics.test.ts`
Expected: FAIL — `Cannot find module './loop-metrics.js'`.

- [ ] **Step 3: Implement `loop-metrics.ts`**

```ts
// packages/core/src/loop-metrics.ts
import { monitorEventLoopDelay } from 'node:perf_hooks'

export interface LoopMetricsHandle {
  stop(): void
  snapshot(): { p50: number; p99: number; max: number }
}

/**
 * Sample this process's event-loop delay and warn when a single tick blocks the
 * loop longer than `longTickMs`. The systemd watchdog only catches a full wedge
 * (>30s); this surfaces the sub-second stalls that ruin typing.
 */
export function startLoopMetrics(opts: {
  label: string
  longTickMs?: number
  sampleMs?: number
  log?: (m: string) => void
  now?: () => number
}): LoopMetricsHandle {
  const longTickMs = opts.longTickMs ?? 100
  const sampleMs = opts.sampleMs ?? 1000
  const log = opts.log ?? ((m: string) => console.warn(m))
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  const timer = setInterval(() => {
    const maxMs = h.max / 1e6
    if (maxMs > longTickMs) log(`[podium:loop] ${opts.label} long tick ${maxMs.toFixed(0)}ms`)
    h.reset()
  }, sampleMs)
  timer.unref?.()
  return {
    stop() { clearInterval(timer); h.disable() },
    snapshot() {
      return { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 }
    },
  }
}
```

- [ ] **Step 4: Add the export**

In `packages/core/src/index.ts`, after `export * from './settings.js'`, add:

```ts
export * from './loop-metrics.js'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /home/user/src/other/podium/.claude/worktrees/typing-latency-profiling && bun run vitest run packages/core/src/loop-metrics.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/loop-metrics.ts packages/core/src/loop-metrics.test.ts packages/core/src/index.ts
git commit -m "feat(core): event-loop-lag sampler + long-tick logger"
```

### Task 2: Wire loop-metrics into server + daemon boot (env-gated) and promote the prober

**Files:**
- Modify: `apps/daemon/src/daemon.ts` (near the top of `startDaemon`, after imports resolved), `apps/server/src/server.ts` (at server start).
- Create: `scripts/loop-probe.mjs`

**Interfaces:**
- Consumes: `startLoopMetrics` from `@podium/core`.

- [ ] **Step 1: Gate on env in the daemon**

Add an import at the top of `apps/daemon/src/daemon.ts`:

```ts
import { startLoopMetrics } from '@podium/core'
```

Inside `startDaemon(...)`, immediately after the daemon's top-level state is set up (place it next to the other `const … =` setup around `daemon.ts:671`), add:

```ts
if (process.env.PODIUM_LOOP_PROFILE) startLoopMetrics({ label: 'daemon' })
```

- [ ] **Step 2: Gate on env in the server**

In `apps/server/src/server.ts`, after the HTTP/WS server is created and before/at listen, add the import `import { startLoopMetrics } from '@podium/core'` and:

```ts
if (process.env.PODIUM_LOOP_PROFILE) startLoopMetrics({ label: 'server' })
```

- [ ] **Step 3: Promote the prober**

Create `scripts/loop-probe.mjs` with the triangulating prober (own-lag vs server WS RTT vs daemon HTTP RTT). Copy the implementation verbatim from the diagnostic tooling referenced in `docs/superpowers/specs/2026-06-24-typing-latency-findings.md` (the `loop-probe.mjs` produced during diagnosis). Add a one-line usage header: `// bun scripts/loop-probe.mjs <durationSec> <csvPath>`.

- [ ] **Step 4: Typecheck**

Run: `cd /home/user/src/other/podium/.claude/worktrees/typing-latency-profiling && bun run --filter @podium/daemon typecheck && bun run --filter @podium/server typecheck`
Expected: PASS (no type errors).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/daemon.ts apps/server/src/server.ts scripts/loop-probe.mjs
git commit -m "feat(server,daemon): env-gated loop-lag instrumentation + loop-probe tool"
```

---

## Phase 1 — Worker foundation

### Task 3: Pure memory-breakdown job function

**Files:**
- Create: `apps/daemon/src/discovery-jobs.ts`
- Test: `apps/daemon/src/discovery-jobs.test.ts`

**Interfaces:**
- Consumes: `snapshotProcesses`, `attributeMemory`, `SessionProcessHint`, `MemoryAttribution` from `./memory-breakdown`.
- Produces:
  - `interface MemoryBreakdownJobInput { sessions: SessionProcessHint[]; roots: string[]; selfPid: number; procRoot?: string }`
  - `function runMemoryBreakdownJob(input: MemoryBreakdownJobInput): MemoryAttribution` — pure wrapper over `attributeMemory(snapshotProcesses(procRoot), sessions, roots, { selfPid })`.

- [ ] **Step 1: Write the failing test** (uses a `/proc` fixture so it is deterministic)

```ts
// apps/daemon/src/discovery-jobs.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMemoryBreakdownJob } from './discovery-jobs.js'

function fakeProc(root: string, pid: number, ppid: number, comm: string, cmdline: string, rssPages: number) {
  const d = join(root, String(pid))
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`)
  writeFileSync(join(d, 'statm'), `1000 ${rssPages} 0 0 0 0 0`)
  writeFileSync(join(d, 'cmdline'), cmdline.replaceAll(' ', '\0'))
}

describe('runMemoryBreakdownJob', () => {
  it('attributes a labelled process subtree to its session', () => {
    const root = mkdtempSync(join(tmpdir(), 'proc-'))
    fakeProc(root, 100, 1, 'abduco', 'abduco -n podium-S1 claude', 50)
    fakeProc(root, 101, 100, 'claude', 'claude --foo', 200)
    const out = runMemoryBreakdownJob({
      sessions: [{ sessionId: 'S1', label: 'podium-S1', pid: 100 }],
      roots: [], selfPid: 999, procRoot: root,
    })
    const agent = out.agents.find((a) => a.sessionId === 'S1')
    expect(agent).toBeTruthy()
    expect(agent!.processCount).toBe(2)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run vitest run apps/daemon/src/discovery-jobs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the job**

```ts
// apps/daemon/src/discovery-jobs.ts
import {
  attributeMemory,
  type MemoryAttribution,
  type SessionProcessHint,
  snapshotProcesses,
} from './memory-breakdown'

export interface MemoryBreakdownJobInput {
  sessions: SessionProcessHint[]
  roots: string[]
  selfPid: number
  procRoot?: string
}

/** Pure: the /proc walk + attribution, runnable on a worker thread or inline. */
export function runMemoryBreakdownJob(input: MemoryBreakdownJobInput): MemoryAttribution {
  return attributeMemory(
    snapshotProcesses(input.procRoot ?? '/proc'),
    input.sessions,
    input.roots,
    { selfPid: input.selfPid },
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run vitest run apps/daemon/src/discovery-jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/discovery-jobs.ts apps/daemon/src/discovery-jobs.test.ts
git commit -m "feat(daemon): pure runMemoryBreakdownJob (relocatable /proc walk)"
```

### Task 4: Worker entry + job protocol

**Files:**
- Create: `apps/daemon/src/discovery-worker.ts`

**Interfaces:**
- Produces (shared protocol types, exported for the client + tests):
  - `type WorkerJob = { id: string; kind: 'memoryBreakdown'; input: MemoryBreakdownJobInput } | { id: string; kind: 'indexRefresh'; input: IndexRefreshJobInput }`
  - `type WorkerResult = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: string }`
  - (`IndexRefreshJobInput` is added in Task 8; until then the worker handles only `memoryBreakdown`.)

- [ ] **Step 1: Implement the thin worker shell**

```ts
// apps/daemon/src/discovery-worker.ts
import { parentPort } from 'node:worker_threads'
import { type MemoryBreakdownJobInput, runMemoryBreakdownJob } from './discovery-jobs'

export type WorkerJob = { id: string; kind: 'memoryBreakdown'; input: MemoryBreakdownJobInput }
export type WorkerResult =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string }

if (parentPort) {
  const port = parentPort
  port.on('message', (job: WorkerJob) => {
    try {
      let value: unknown
      if (job.kind === 'memoryBreakdown') value = runMemoryBreakdownJob(job.input)
      else throw new Error(`unknown job kind: ${(job as { kind: string }).kind}`)
      port.postMessage({ id: job.id, ok: true, value } satisfies WorkerResult)
    } catch (err) {
      port.postMessage({
        id: job.id, ok: false, error: err instanceof Error ? err.message : String(err),
      } satisfies WorkerResult)
    }
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter @podium/daemon typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/discovery-worker.ts
git commit -m "feat(daemon): worker entry + job protocol (memoryBreakdown)"
```

### Task 5: `DiscoveryWorkerClient` (spawn, coalesce, timeout, restart)

**Files:**
- Create: `apps/daemon/src/worker-client.ts`
- Test: `apps/daemon/src/worker-client.test.ts`

**Interfaces:**
- Consumes: `WorkerJob`, `WorkerResult` from `./discovery-worker`.
- Produces:
  - `interface WorkerLike { postMessage(m: unknown): void; on(ev: 'message' | 'error' | 'exit', cb: (a: any) => void): void; terminate(): void }`
  - `class DiscoveryWorkerClient { constructor(opts?: { spawn?: () => WorkerLike; timeoutMs?: number; log?: (m: string) => void }); runJob(kind: WorkerJob['kind'], input: unknown): Promise<unknown>; stop(): void }`
  - Behavior: lazy-spawns the worker; **one in-flight job per kind** (a second `runJob` of the same kind returns the same promise); rejects + restarts the worker on `error`/`exit`/timeout; default `spawn` builds the real worker.

- [ ] **Step 1: Write the failing test** (fake worker — no real thread)

```ts
// apps/daemon/src/worker-client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DiscoveryWorkerClient, type WorkerLike } from './worker-client.js'

function makeFakeWorker() {
  const handlers: Record<string, ((a: any) => void)[]> = { message: [], error: [], exit: [] }
  const w: WorkerLike & { emit: (e: string, a: any) => void; sent: any[] } = {
    sent: [],
    postMessage(m: any) { this.sent.push(m) },
    on(ev, cb) { handlers[ev].push(cb) },
    terminate() { handlers.exit.forEach((h) => h(0)) },
    emit(e, a) { handlers[e].forEach((h) => h(a)) },
  }
  return w
}

describe('DiscoveryWorkerClient', () => {
  it('resolves a job when the worker replies', async () => {
    const fake = makeFakeWorker()
    const c = new DiscoveryWorkerClient({ spawn: () => fake })
    const p = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    const job = fake.sent[0]
    fake.emit('message', { id: job.id, ok: true, value: { agents: [], projects: [] } })
    await expect(p).resolves.toEqual({ agents: [], projects: [] })
    c.stop()
  })

  it('coalesces a second same-kind job into the first', async () => {
    const fake = makeFakeWorker()
    const c = new DiscoveryWorkerClient({ spawn: () => fake })
    const p1 = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    const p2 = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    expect(fake.sent.length).toBe(1)
    fake.emit('message', { id: fake.sent[0].id, ok: true, value: 7 })
    expect(await p1).toBe(7)
    expect(await p2).toBe(7)
    c.stop()
  })

  it('rejects in-flight jobs and respawns when the worker exits', async () => {
    let spawns = 0
    const workers: any[] = []
    const c = new DiscoveryWorkerClient({ spawn: () => { spawns++; const w = makeFakeWorker(); workers.push(w); return w } })
    const p = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    workers[0].emit('exit', 1)
    await expect(p).rejects.toThrow()
    // next job triggers a fresh spawn
    void c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: 1 })
    expect(spawns).toBe(2)
    c.stop()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run vitest run apps/daemon/src/worker-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

```ts
// apps/daemon/src/worker-client.ts
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { WorkerJob, WorkerResult } from './discovery-worker'

export interface WorkerLike {
  postMessage(m: unknown): void
  on(ev: 'message' | 'error' | 'exit', cb: (a: any) => void): void
  terminate(): void
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

function defaultSpawn(): WorkerLike {
  return new Worker(new URL('./discovery-worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
}

export class DiscoveryWorkerClient {
  private worker?: WorkerLike
  private readonly pending = new Map<string, Pending>()
  private readonly inflightByKind = new Map<string, Promise<unknown>>()
  private readonly spawn: () => WorkerLike
  private readonly timeoutMs: number
  private readonly log: (m: string) => void

  constructor(opts: { spawn?: () => WorkerLike; timeoutMs?: number; log?: (m: string) => void } = {}) {
    this.spawn = opts.spawn ?? defaultSpawn
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.log = opts.log ?? ((m) => console.warn(m))
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker
    const w = this.spawn()
    w.on('message', (r: WorkerResult) => this.settle(r))
    w.on('error', (e: Error) => this.crash(e))
    w.on('exit', (code: number) => { if (code !== 0) this.crash(new Error(`worker exited ${code}`)) })
    this.worker = w
    return w
  }

  private settle(r: WorkerResult): void {
    const p = this.pending.get(r.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(r.id)
    if (r.ok) p.resolve(r.value)
    else p.reject(new Error(r.error))
  }

  private crash(err: Error): void {
    this.log(`[podium:daemon] discovery worker crashed: ${err.message} — respawning`)
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
    this.inflightByKind.clear()
    try { this.worker?.terminate() } catch {}
    this.worker = undefined
  }

  runJob(kind: WorkerJob['kind'], input: unknown): Promise<unknown> {
    const existing = this.inflightByKind.get(kind)
    if (existing) return existing
    const id = randomUUID()
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.settle({ id, ok: false, error: `${kind} timed out` }), this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ensureWorker().postMessage({ id, kind, input } as WorkerJob)
    }).finally(() => { this.inflightByKind.delete(kind) })
    this.inflightByKind.set(kind, promise)
    return promise
  }

  stop(): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('stopped')) }
    this.pending.clear()
    this.inflightByKind.clear()
    try { this.worker?.terminate() } catch {}
    this.worker = undefined
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run vitest run apps/daemon/src/worker-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/worker-client.ts apps/daemon/src/worker-client.test.ts
git commit -m "feat(daemon): DiscoveryWorkerClient (coalesce, timeout, auto-restart)"
```

---

## Phase 2 — Route the memory walk through the worker

### Task 6: Daemon `memoryBreakdown` uses the worker + loop-isolation test

**Files:**
- Modify: `apps/daemon/src/daemon.ts` (the `memoryBreakdown` function at `daemon.ts:895-924`; add a `DiscoveryWorkerClient` instance near `daemon.ts:671`; stop it in the daemon `close()` path).
- Create: `apps/daemon/src/worker-isolation.test.ts`

**Interfaces:**
- Consumes: `DiscoveryWorkerClient` from `./worker-client`; `runMemoryBreakdownJob` shape `MemoryAttribution`.

- [ ] **Step 1: Add the worker client to the daemon**

In `apps/daemon/src/daemon.ts`, add `import { DiscoveryWorkerClient } from './worker-client'` at the top, and near the discovery state setup (`daemon.ts:671`):

```ts
const workerClient = new DiscoveryWorkerClient()
```

Find the daemon's shutdown/`close()`/`disposeAll` path and add `workerClient.stop()` alongside the other teardown.

- [ ] **Step 2: Make `memoryBreakdown` async via the worker**

Replace the body of `memoryBreakdown` (`daemon.ts:895-924`). The hint/roots/selfPid construction is unchanged; only the `snapshotProcesses()`/`attributeMemory()` call moves to the worker:

```ts
const memoryBreakdown = async (requestId: string, roots: string[]): Promise<void> => {
  const memory = sampleHostMemory()
  const supported = process.platform === 'linux'
  let agents: MemoryAttribution['agents'] = []
  let projects: MemoryAttribution['projects'] = []
  if (supported) {
    try {
      const result = (await workerClient.runJob('memoryBreakdown', {
        sessions: [...bridges.entries()].map(([sessionId, session]) => ({
          sessionId, label: `podium-${sessionId}`, pid: session.pid,
        })),
        roots,
        selfPid: process.pid,
      })) as MemoryAttribution
      agents = result.agents
      projects = result.projects
    } catch (err) {
      console.warn(`[podium:daemon] memoryBreakdown job failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const attributed =
    agents.reduce((s, a) => s + a.bytes, 0) + projects.reduce((s, p) => s + p.bytes, 0)
  const usedBytes = Math.max(0, memory.totalBytes - memory.availableBytes)
  send({
    type: 'memoryBreakdownResult', requestId, hostname: hostname(),
    sampledAt: new Date().toISOString(), supported, memory, agents, projects,
    otherBytes: Math.max(0, usedBytes - attributed),
  })
}
```

Add `type MemoryAttribution` to the existing `./memory-breakdown` import. Update the handler call site (`daemon.ts:1257`) to `void memoryBreakdown(msg.requestId, msg.roots)` (it is now async, fire-and-forget — it already was).

- [ ] **Step 3: Write the loop-isolation integration test** (runs the REAL worker under Bun)

```ts
// apps/daemon/src/worker-isolation.test.ts
import { describe, it, expect } from 'vitest'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DiscoveryWorkerClient } from './worker-client.js'

// The headline regression test: a heavy worker job must NOT block the main loop.
describe('worker isolation', () => {
  it('keeps the main event loop responsive while a heavy /proc walk runs', async () => {
    const c = new DiscoveryWorkerClient()
    const h = monitorEventLoopDelay({ resolution: 5 }); h.enable()
    // Real /proc walk on this host (~hundreds of ms of work) — on the worker.
    const job = c.runJob('memoryBreakdown', { sessions: [], roots: [], selfPid: process.pid })
    // Meanwhile the main loop keeps ticking; record its max lag until the job lands.
    await job
    const maxMs = h.max / 1e6
    h.disable(); c.stop()
    expect(maxMs).toBeLessThan(100) // main loop never blocked >100ms
  }, 20_000)
})
```

- [ ] **Step 4: Run the tests**

Run: `bun run vitest run apps/daemon/src/worker-isolation.test.ts apps/daemon/src/worker-client.test.ts`
Expected: PASS. (If the test runner cannot spawn a `.ts` worker, run this file with Bun's runner: `bun test apps/daemon/src/worker-isolation.test.ts` — note in the test file which runner is required.)

- [ ] **Step 5: Typecheck + full daemon tests**

Run: `bun run --filter @podium/daemon typecheck && bun run vitest run apps/daemon`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/daemon.ts apps/daemon/src/worker-isolation.test.ts
git commit -m "feat(daemon): run /proc memory walk on the worker (off the interactive loop)"
```

---

## Phase 3 — Incremental discovery on the worker

### Task 7: `scanAgentConversationsCached` returns a delta

**Files:**
- Modify: `packages/agent-bridge/src/discovery/scanner.ts` (`scanAgentConversationsCached`, ~`scanner.ts:80-178`).
- Test: `packages/agent-bridge/src/discovery/scanner.test.ts` (add a case; create if absent).

**Interfaces:**
- Produces: `scanAgentConversationsCached` result gains `changed: AgentConversationSummary[]` (files re-summarized this pass) and `removed: string[]` (conversation ids pruned). Existing `conversations`/`diagnostics` unchanged for back-compat.

- [ ] **Step 1: Read `deleteMissing`'s return type**

Run: `grep -nE "deleteMissing|DeleteMissingResult" packages/agent-bridge/src/discovery/cache.ts`
Confirm the field that lists removed conversation ids (e.g. `removedIds`). Use that exact name below.

- [ ] **Step 2: Write the failing test**

```ts
// packages/agent-bridge/src/discovery/scanner.test.ts (add)
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationDiscoveryCache } from './cache.js'
import { scanAgentConversationsCached } from './scanner.js'

describe('scanAgentConversationsCached deltas', () => {
  it('reports only changed files on the second pass', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    const proj = join(home, '.claude', 'projects', 'p')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'a.jsonl'), '{"type":"summary","summary":"A"}\n')
    const cache = new ConversationDiscoveryCache(':memory:')
    const first = await scanAgentConversationsCached({ cache, homeDir: home })
    expect(first.changed.length).toBeGreaterThan(0)
    const second = await scanAgentConversationsCached({ cache, homeDir: home })
    expect(second.changed.length).toBe(0) // unchanged → empty delta
  })
})
```

- [ ] **Step 3: Implement the delta**

In `scanAgentConversationsCached` (`scanner.ts`), the function already collects `cacheWrites` (files that missed the cache and were re-summarized) and calls `options.cache.deleteMissing(seenPaths, selectedAgentKinds)`. Capture both and add to the return:

```ts
  const deleted = options.cache.deleteMissing(seenPaths, selectedAgentKinds)
  return {
    conversations: dedupeConversations(conversations).sort(compareConversationSummaries),
    diagnostics,
    changed: cacheWrites.map((w) => w.summary),
    removed: deleted.removedIds ?? [], // exact field confirmed in Step 1
  }
```

Extend the function's return type accordingly (add `changed: AgentConversationSummary[]; removed: string[]` to `ScanAgentConversationsResult` or a new `ScanAgentConversationsCachedResult`).

- [ ] **Step 4: Run the test**

Run: `bun run vitest run packages/agent-bridge/src/discovery/scanner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/discovery/scanner.ts packages/agent-bridge/src/discovery/scanner.test.ts
git commit -m "feat(discovery): scanAgentConversationsCached returns changed+removed delta"
```

### Task 8: `runIndexRefreshJob` (worker job) + protocol delta message

**Files:**
- Modify: `apps/daemon/src/discovery-jobs.ts` (add `runIndexRefreshJob`), `apps/daemon/src/discovery-worker.ts` (handle `indexRefresh`), `packages/protocol/src/messages.ts` (add `removed` to `ScanResultMessage` / add `conversationsDelta`).
- Test: `apps/daemon/src/discovery-jobs.test.ts` (add a case).

**Interfaces:**
- Produces:
  - `interface IndexRefreshJobInput { homeDir?: string; cachePath?: string; paths?: string[] }`
  - `function runIndexRefreshJob(input): Promise<{ changed: ConversationSummaryWire[]; removed: string[]; diagnostics: ConversationDiagnosticWire[] }>` — opens its own `ConversationDiscoveryCache(cachePath)` (worker owns the cache), runs `scanAgentConversationsCached`, maps via `summaryToWire`. (When `paths` is set, restrict to those files — Task 11 uses this; for now `paths` may be ignored and a full incremental pass run.)
  - Protocol: `ScanResultMessage` and the periodic `conversationsChanged` gain optional `removed: string[]`.

- [ ] **Step 1: Move `summaryToWire`/`diagnosticToWire` so the worker can reuse them**

These are currently local to `daemon.ts:248,267`. Export them from a shared spot the worker imports — create `apps/daemon/src/conversation-wire.ts` with both functions (copy verbatim from `daemon.ts:248-275`) and re-import them in `daemon.ts`. Commit this refactor first:

```bash
git add apps/daemon/src/conversation-wire.ts apps/daemon/src/daemon.ts
git commit -m "refactor(daemon): extract summaryToWire/diagnosticToWire to conversation-wire.ts"
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/daemon/src/discovery-jobs.test.ts (add)
import { runIndexRefreshJob } from './discovery-jobs.js'
it('runIndexRefreshJob returns wire-shaped changed conversations', async () => {
  const { changed } = await runIndexRefreshJob({ homeDir: process.env.HOME, cachePath: ':memory:' })
  expect(Array.isArray(changed)).toBe(true)
  if (changed[0]) expect(typeof changed[0].id).toBe('string')
})
```

- [ ] **Step 3: Implement `runIndexRefreshJob`**

```ts
// apps/daemon/src/discovery-jobs.ts (add)
import { ConversationDiscoveryCache, scanAgentConversationsCached } from '@podium/agent-bridge'
import type { ConversationDiagnosticWire, ConversationSummaryWire } from '@podium/protocol'
import { diagnosticToWire, summaryToWire } from './conversation-wire'

export interface IndexRefreshJobInput { homeDir?: string; cachePath?: string; paths?: string[] }

export async function runIndexRefreshJob(input: IndexRefreshJobInput): Promise<{
  changed: ConversationSummaryWire[]; removed: string[]; diagnostics: ConversationDiagnosticWire[]
}> {
  const cache = new ConversationDiscoveryCache(input.cachePath)
  const r = await scanAgentConversationsCached({
    cache, ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  })
  return {
    changed: r.changed.map(summaryToWire),
    removed: r.removed,
    diagnostics: r.diagnostics.map(diagnosticToWire),
  }
}
```

- [ ] **Step 4: Handle `indexRefresh` in the worker**

In `apps/daemon/src/discovery-worker.ts`, import `runIndexRefreshJob` + `IndexRefreshJobInput`, widen `WorkerJob` to include `{ id; kind: 'indexRefresh'; input: IndexRefreshJobInput }`, and in the message handler add `else if (job.kind === 'indexRefresh') value = await runIndexRefreshJob(job.input)`. Make the handler `async`.

- [ ] **Step 5: Add `removed` to the protocol**

In `packages/protocol/src/messages.ts`, add `removed: z.array(z.string()).optional()` to `ScanResultMessage` (`messages.ts:837`) and to the `conversationsChanged` message (`messages.ts:410`).

- [ ] **Step 6: Run tests + typecheck**

Run: `bun run vitest run apps/daemon/src/discovery-jobs.test.ts && bun run --filter @podium/protocol typecheck && bun run --filter @podium/daemon typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/discovery-jobs.ts apps/daemon/src/discovery-worker.ts packages/protocol/src/messages.ts apps/daemon/src/discovery-jobs.test.ts
git commit -m "feat(daemon): runIndexRefreshJob on worker + removed[] in protocol"
```

### Task 9: Server applies conversation deltas (upsert changed + delete removed)

**Files:**
- Modify: `apps/server/src/store.ts` (add `deleteConversations`), `apps/server/src/relay.ts` (`indexConversations` handles `removed`; `scanResult`/`conversationsChanged` cases pass `msg.removed`).
- Test: `apps/server/src/store.test.ts` (add a case).

**Interfaces:**
- Produces: `Store.deleteConversations(ids: string[]): void`; `indexConversations(conversations, removed?: string[])`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/store.test.ts (add)
it('deleteConversations removes rows', () => {
  const store = makeTestStore() // reuse the file's existing store factory
  store.upsertConversations([{ id: 'x', agentKind: 'claude-code', providerId: 'anthropic' }])
  store.deleteConversations(['x'])
  expect(store.searchConversations?.('').find?.((c: any) => c.id === 'x')).toBeFalsy()
})
```

(Adapt to the test file's existing store setup + search helper; if a search accessor isn't exposed, assert via a direct count query the file already uses.)

- [ ] **Step 2: Implement `deleteConversations`**

```ts
// apps/server/src/store.ts (add, near upsertConversations:451)
deleteConversations(ids: string[]): void {
  if (ids.length === 0) return
  const stmt = this.db.prepare('DELETE FROM conversations WHERE id = ?')
  this.db.exec('BEGIN IMMEDIATE')
  try { for (const id of ids) stmt.run(id); this.db.exec('COMMIT') }
  catch (e) { this.db.exec('ROLLBACK'); throw e }
}
```

- [ ] **Step 3: Thread `removed` through `indexConversations`**

In `apps/server/src/relay.ts:1429`, change the signature to `private indexConversations(conversations: ConversationSummaryWire[], removed: string[] = []): void`, keep the existing `upsertConversations(...)` call, and append `if (removed.length) this.store.deleteConversations(removed)`. In the `scanResult` case (`relay.ts:1254`) and the `conversationsChanged` case, pass `msg.removed ?? []` as the second arg.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run vitest run apps/server/src/store.test.ts && bun run --filter @podium/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/relay.ts apps/server/src/store.test.ts
git commit -m "feat(server): apply conversation index deltas (upsert changed + delete removed)"
```

### Task 10: Daemon periodic scan runs on the worker and emits deltas

**Files:**
- Modify: `apps/daemon/src/daemon.ts` (`runDiscoveryScan`/`refreshAndPublishConversations`/`publishConversations`/`scan`, `daemon.ts:839-884,1031`).

**Interfaces:**
- Consumes: `workerClient.runJob('indexRefresh', { homeDir?, cachePath })`.

- [ ] **Step 1: Route the scan through the worker and publish deltas**

Replace `runDiscoveryScan` (`daemon.ts:846`) so it calls the worker instead of `scanAgentConversationsCached` inline, returning the delta. Pass `opts.discovery?.cachePath` so the worker opens the same `discovery.db`. Note: the daemon-main `discoveryCache` instance is no longer used for scanning (the worker owns the cache file); remove the now-unused `const discoveryCache = …` (`daemon.ts:671`) once nothing references it.

```ts
const runDiscoveryDelta = async (): Promise<{ changed: ConversationSummaryWire[]; removed: string[]; diagnostics: ConversationDiagnosticWire[] }> => {
  try {
    return (await workerClient.runJob('indexRefresh', {
      ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
      ...(opts.discovery?.cachePath ? { cachePath: opts.discovery.cachePath } : {}),
    })) as { changed: ConversationSummaryWire[]; removed: string[]; diagnostics: ConversationDiagnosticWire[] }
  } catch (err) {
    return { changed: [], removed: [], diagnostics: [{ severity: 'error', message: err instanceof Error ? err.message : String(err) }] }
  }
}
```

Change `publishConversations` to send a delta (skip the send entirely when `changed`/`removed`/`diagnostics` are all empty — most ticks):

```ts
const publishConversations = (delta: { changed: ConversationSummaryWire[]; removed: string[]; diagnostics: ConversationDiagnosticWire[] }): void => {
  if (delta.changed.length === 0 && delta.removed.length === 0 && delta.diagnostics.length === 0) return
  send({ type: 'conversationsChanged', conversations: delta.changed, removed: delta.removed, diagnostics: delta.diagnostics })
}
```

Update `refreshAndPublishConversations`, `scheduleDiscoveryScan`, and the on-demand `scan` (`daemon.ts:1031`) to use `runDiscoveryDelta` + the delta-shaped publish (the on-demand `scanResult` carries `requestId` + the delta fields).

- [ ] **Step 2: Run the daemon test suite**

Run: `bun run --filter @podium/daemon typecheck && bun run vitest run apps/daemon`
Expected: PASS (fix any daemon.test.ts expectations that asserted the old full-list `conversationsChanged` shape — they should now assert deltas; update them in this task).

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/daemon.ts apps/daemon/src/daemon.test.ts
git commit -m "feat(daemon): periodic discovery runs on worker, emits deltas (no more 15s loop block)"
```

### Task 11: Event-driven active refresh from the transcript tail

**Files:**
- Modify: `apps/daemon/src/daemon.ts` (the `ensureTranscriptTail` onItems callback, `daemon.ts:339-347`; add a coalescing dirty-set + flush).
- Modify: `apps/daemon/src/discovery-jobs.ts` + `discovery-worker.ts` to honor `IndexRefreshJobInput.paths` (re-summarize only the given files).

**Interfaces:**
- Consumes: `workerClient.runJob('indexRefresh', { paths })`.

- [ ] **Step 1: Honor `paths` in the index refresh job**

In `runIndexRefreshJob`, when `input.paths` is set, restrict the scan to those files. Implement by passing the paths to a narrow scan: stat each path, `cache.getFresh` / `summarizeFile` only those, and return their summaries as `changed` (no `deleteMissing` in paths-mode). Add the supporting helper next to `scanAgentConversationsCached` if needed (a `summarizePaths(paths, cache)` export). Add a unit test in `discovery-jobs.test.ts` that a known fixture file passed via `paths` comes back in `changed`.

- [ ] **Step 2: Mark dirty + coalesced flush in the tail hook**

In `apps/daemon/src/daemon.ts`, near the tail wiring (`daemon.ts:320`), add:

```ts
const dirtyTranscriptPaths = new Set<string>()
let dirtyFlushTimer: ReturnType<typeof setTimeout> | undefined
const flushDirtyConversations = (): void => {
  dirtyFlushTimer = undefined
  if (dirtyTranscriptPaths.size === 0) return
  const paths = [...dirtyTranscriptPaths]; dirtyTranscriptPaths.clear()
  void workerClient.runJob('indexRefresh', { paths }).then((d) => {
    const delta = d as { changed: ConversationSummaryWire[]; removed: string[]; diagnostics: ConversationDiagnosticWire[] }
    if (delta.changed.length || delta.removed.length) send({ type: 'conversationsChanged', conversations: delta.changed, removed: delta.removed, diagnostics: [] })
  }).catch((err) => console.warn(`[podium:daemon] active index refresh failed: ${err instanceof Error ? err.message : String(err)}`))
}
const markConversationDirty = (path: string): void => {
  dirtyTranscriptPaths.add(path)
  if (!dirtyFlushTimer) { dirtyFlushTimer = setTimeout(flushDirtyConversations, 1_000); dirtyFlushTimer.unref?.() }
}
```

In the `ensureTranscriptTail` onItems callback (`daemon.ts:339`), after the existing `send({ type: 'transcriptDelta', … })`, add `markConversationDirty(path)`.

- [ ] **Step 3: Test the coalescing**

Add a test (fake timers) asserting that multiple `markConversationDirty` calls within the window produce **one** `indexRefresh` job for the union of paths. Place it in a new `apps/daemon/src/active-refresh.test.ts` that exercises the dirty-set/flush helpers (extract them to a tiny module if needed for testability).

- [ ] **Step 4: Run + commit**

Run: `bun run --filter @podium/daemon typecheck && bun run vitest run apps/daemon`
Expected: PASS.

```bash
git add apps/daemon/src/daemon.ts apps/daemon/src/discovery-jobs.ts apps/daemon/src/discovery-worker.ts apps/daemon/src/active-refresh.test.ts
git commit -m "feat(daemon): event-driven conversation index refresh from transcript tail"
```

---

## Phase 4 — Verify on the live host

### Task 12: End-to-end verification with the prober

**Files:** none (verification only).

- [ ] **Step 1: Build/typecheck the whole repo**

Run: `bun run --filter '*' typecheck && bun run vitest run`
Expected: PASS.

- [ ] **Step 2: Integrate to live (only when the user says)**

Per `docs/superpowers/specs/2026-06-24-podium-loop-isolation-design.md` rollout: rebase + `git merge --ff-only` onto main, then the redeploy.path restarts the backend.

- [ ] **Step 3: Re-run the prober against the live daemon**

Run: `bun scripts/loop-probe.mjs 300 /tmp/loop-after.csv`
Expected: `daemon_http_rtt` p99 < 50ms and **no** ~16s periodic stall (was ~700-950ms every 15s). Compare against the baseline in the findings report.

- [ ] **Step 4: Confirm the feature still works**

Open Cmd+K search and the resume picker; confirm recently-active and historical conversations appear and are current. Open the Host Memory view; confirm it still populates (now via the worker) without a typing stall.

---

## Self-Review

**1. Spec coverage:**
- Worker (second loop) → Tasks 3,4,5,6. ✓
- Kill periodic full scan; active event-driven + inactive incremental → Tasks 7,8,10,11. ✓
- Memory walk → worker (Phase 2) → Task 6; Phase 2 "cheaper" deferred (spec). ✓
- Loop instrumentation + promote prober → Tasks 1,2. ✓
- Quick cleanups: orphan (done pre-plan); optional stop-broadcast — intentionally omitted (the web already ignores the broadcast and deltas make it cheap; no separate task needed). ✓
- Deferred: focused-session priority — not in plan, by design. ✓
- Headline regression test (loop stays responsive during a heavy job) → Task 6 Step 3. ✓
- End-to-end prober verification → Task 12. ✓

**2. Placeholder scan:** Two spots require reading an exact existing name before coding — Task 7 Step 1 (`deleteMissing` removed-ids field) and Task 9 Step 1 (store test factory). These are explicit read-first steps with the implementation code shown, not deferred work. Task 2 Step 3 copies the prober verbatim from the committed findings tooling. No "TODO/handle edge cases" placeholders.

**3. Type consistency:** `WorkerJob`/`WorkerResult` defined in Task 4, consumed in Task 5; `MemoryBreakdownJobInput`/`IndexRefreshJobInput` defined in Tasks 3/8, consumed in worker/client; `runJob(kind, input)` signature consistent across Tasks 5,6,10,11; `summaryToWire`/`diagnosticToWire` extracted in Task 8 Step 1 before reuse; `removed: string[]` added to protocol (Task 8) before the server reads it (Task 9) and the daemon sends it (Task 10).

**Risks flagged for the implementer:**
- Worker `.ts` loading differs by runtime; the isolation test (Task 6) notes the Bun runner requirement. Confirm the live Bun daemon spawns the worker before relying on it.
- `paths`-mode index refresh (Task 11) needs a narrow summarize path; if the provider API makes single-file summarize awkward, fall back to a full incremental `indexRefresh` on dirty (still on the worker, still correct, slightly more work).
