# Realtime Output Scheduling + Redeploy-Race Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop background-session PTY output relay from hitching the focused session's keystroke echo, by coalescing frames and prioritizing per-session relay by who's watching; plus close a redeploy race that can boot stale source.

**Architecture:** Client sends a per-session `viewState` (visible/focused); the server unions it across clients into a per-session priority (P0 focused › P1 visible › P2 attached › P3 unwatched) and pushes it to the daemon; the daemon runs a per-session output scheduler that relays P0/P1 per-tick (≈immediate, one batched message) and coalesces P2/P3 on a timer/size threshold — all via a new `agentFrameBatch` wire message.

**Tech Stack:** TypeScript, Bun, zod (`@podium/protocol`), vitest, `ws`. Daemon/server run from source under Bun.

## Global Constraints

- Daemon + server are single-threaded; **no new unbounded synchronous work on either loop.** The scheduler's job is to *reduce* per-frame `encode`+`send` count.
- Errors never silent (match `warnDroppedControlFrame` / `console.warn('[podium…]')`).
- New protocol fields/messages are **additive**; existing `agentFrame` handling stays (back-compat / safety).
- The server **ignores the daemon's frame `seq`** and assigns its own monotonic seq in `Session.onFrame(data)` — so the batch wire carries **only `data` strings**, never seq.
- Default an unknown session's priority to **P1** (relay immediately) — never starve a session we don't yet have priority for.
- Daemon scheduler must be deterministically testable: timer + immediate-flush hooks are injectable.
- Coalesce constants are named: `COALESCE_MS = 75`, `COALESCE_MAX_BYTES = 64 * 1024`.
- Live daemon runs under Bun with `--conditions=@podium/source`; bun-only tests run as `*.bun.test.ts` (vitest excludes them; run with `bun --conditions=@podium/source test <file>`).

---

## File Structure

**Create:**
- `scripts/redeploy-wait.sh` — waits for git quiescence before redeploy restarts.
- `scripts/redeploy-wait.test.ts` — test for the wait gate.
- `apps/daemon/src/output-scheduler.ts` — per-session frame queue + priority + flush.
- `apps/daemon/src/output-scheduler.test.ts`
- `apps/daemon/src/output-scheduler-isolation.bun.test.ts` — background flood doesn't hitch focused.
- `apps/server/src/session-priority.ts` — pure `computePriorities(clients)`.
- `apps/server/src/session-priority.test.ts`

**Modify:**
- `packages/protocol/src/messages.ts` — `ViewStateMessage`, `SessionPriorityMessage`, `AgentFrameBatchMessage` + unions.
- `apps/daemon/src/daemon.ts` — route `onFrame` through the scheduler; `sessionPriority` case; lifecycle hooks.
- `apps/server/src/session.ts` — `ClientConn` gains `viewVisible: Set<string>` + `focused: string | null`.
- `apps/server/src/relay.ts` — `viewState` case; priority recompute + push; `agentFrameBatch` unpack; send full map on daemon connect.
- `packages/terminal-client/src/connection.ts` — `setViewState()` + reconnect re-assert.
- `apps/web/src/store.tsx` — `focusedPane` state; derive + send `viewState`.
- `scripts/systemd/podium-redeploy.service` — `ExecStartPre`.

---

## Phase 0 — Redeploy race fix (independent; ship first)

### Task 1: redeploy waits for git quiescence

**Files:**
- Create: `scripts/redeploy-wait.sh`, `scripts/redeploy-wait.test.ts`
- Modify: `scripts/systemd/podium-redeploy.service`

**Interfaces:**
- Produces: `scripts/redeploy-wait.sh <repo-root>` — exits 0 once `<repo-root>/.git/index.lock` is absent for a short settle, or after a timeout.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/redeploy-wait.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

describe('redeploy-wait.sh', () => {
  it('returns only after .git/index.lock clears', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rw-'))
    mkdirSync(join(repo, '.git'), { recursive: true })
    const lock = join(repo, '.git', 'index.lock')
    writeFileSync(lock, '')
    // clear the lock after 600ms in the background
    const clearer = spawn('bash', ['-c', `sleep 0.6; rm -f "${lock}"`])
    const t = Date.now()
    execFileSync('bash', [join(__dirname, 'redeploy-wait.sh'), repo], { timeout: 10_000 })
    const waited = Date.now() - t
    clearer.kill()
    rmSync(repo, { recursive: true, force: true })
    expect(waited).toBeGreaterThan(500) // it waited for the lock
    expect(waited).toBeLessThan(8000)   // and returned promptly after
  })

  it('times out cleanly if the lock never clears (exit 0, bounded)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rw2-'))
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'index.lock'), '')
    const t = Date.now()
    execFileSync('bash', [join(__dirname, 'redeploy-wait.sh'), repo], {
      timeout: 10_000,
      env: { ...process.env, REDEPLOY_WAIT_TIMEOUT: '2' },
    })
    const waited = Date.now() - t
    rmSync(repo, { recursive: true, force: true })
    expect(waited).toBeGreaterThanOrEqual(2000)
    expect(waited).toBeLessThan(4000)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run vitest run scripts/redeploy-wait.test.ts`
Expected: FAIL (script missing → execFileSync throws ENOENT).

- [ ] **Step 3: Implement the script**

```bash
#!/usr/bin/env bash
# Wait for git to be quiescent before the redeploy restart picks up source.
# A fast-forward merge writes .git/logs/HEAD (which triggers podium-redeploy.path)
# while it still holds .git/index.lock for the working-tree checkout; under load the
# restart can beat the checkout and boot STALE source. Block until the lock clears.
set -u
repo="${1:?usage: redeploy-wait.sh <repo-root>}"
lock="$repo/.git/index.lock"
timeout="${REDEPLOY_WAIT_TIMEOUT:-30}"   # seconds; cap so a stuck lock can't wedge redeploy
settle="${REDEPLOY_WAIT_SETTLE:-0.5}"     # filesystem-flush grace once the lock is gone
deadline=$(( $(date +%s) + timeout ))
while [ -e "$lock" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[redeploy-wait] index.lock still present after ${timeout}s — proceeding anyway" >&2
    break
  fi
  sleep 0.1
done
sleep "$settle"
exit 0
```

Make it executable: `chmod +x scripts/redeploy-wait.sh`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `chmod +x scripts/redeploy-wait.sh && bun run vitest run scripts/redeploy-wait.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into the redeploy service**

In `scripts/systemd/podium-redeploy.service`, under `[Service]` before `ExecStart`, add:

```ini
# Close the redeploy/checkout race: a HEAD reflog write (our trigger) can land before
# git finishes the working-tree checkout, so wait for git to release .git/index.lock
# (the working tree is fully written then) before restarting. Bounded so a stuck lock
# can't wedge the redeploy.
ExecStartPre=/usr/bin/env bash /home/user/src/other/podium/scripts/redeploy-wait.sh /home/user/src/other/podium
```

Note in the report: installing requires `cp scripts/systemd/podium-redeploy.service ~/.config/systemd/user/ && systemctl --user daemon-reload` (units are copies; done at integration time).

- [ ] **Step 6: Commit**

```bash
git add scripts/redeploy-wait.sh scripts/redeploy-wait.test.ts scripts/systemd/podium-redeploy.service
git commit -m "fix(redeploy): wait for git index.lock release so a merge can't boot stale source"
```

---

## Phase 1 — Protocol

### Task 2: new messages (`agentFrameBatch`, `viewState`, `sessionPriority`)

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts` (add cases; create if absent)

**Interfaces (Produces — later tasks depend on these EXACT shapes):**
- `AgentFrameBatchMessage = { type:'agentFrameBatch'; sessionId: string; frames: string[] }` → in `DaemonMessage` (daemon→server).
- `ViewStateMessage = { type:'viewState'; visible: string[]; focused: string | null }` → in `ClientMessage` (client→server).
- `SessionPriorityMessage = { type:'sessionPriority'; sessionId: string; priority: number }` → in `ControlMessage` (server→daemon).

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/src/messages.test.ts (add)
import { describe, it, expect } from 'vitest'
import { encode, parseClientMessage, parseControlMessage, parseDaemonMessage } from './index.js'

describe('output-scheduling protocol', () => {
  it('round-trips agentFrameBatch (daemon→server)', () => {
    const m = { type: 'agentFrameBatch', sessionId: 's1', frames: ['YQ==', 'Yg=='] } as const
    expect(parseDaemonMessage(encode(m))).toEqual(m)
  })
  it('round-trips viewState (client→server), focused nullable', () => {
    const m = { type: 'viewState', visible: ['s1', 's2'], focused: 's1' } as const
    expect(parseClientMessage(encode(m))).toEqual(m)
    const m2 = { type: 'viewState', visible: [], focused: null } as const
    expect(parseClientMessage(encode(m2))).toEqual(m2)
  })
  it('round-trips sessionPriority (server→daemon)', () => {
    const m = { type: 'sessionPriority', sessionId: 's1', priority: 0 } as const
    expect(parseControlMessage(encode(m))).toEqual(m)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run vitest run packages/protocol/src/messages.test.ts`
Expected: FAIL (zod rejects the unknown `type`s).

- [ ] **Step 3: Add the schemas + union members**

In `packages/protocol/src/messages.ts`, after `AgentFrameMessage` (≈line 819) add:

```ts
export const AgentFrameBatchMessage = z.object({
  type: z.literal('agentFrameBatch'),
  sessionId: z.string(),
  // Coalesced PTY frames (base64 data only — the server assigns its own seq).
  frames: z.array(z.string()),
})
```
…and add `AgentFrameBatchMessage,` to the `DaemonMessage` discriminated union (after `AgentFrameMessage`, ≈line 983).

After `PresenceMessage` (≈line 337) add:

```ts
// Per-session view state: which sessions this client renders (`visible`) and which
// single one has input focus (`focused`). The server unions these across clients to
// prioritize PTY output relay (focused/visible relayed live; the rest coalesced).
export const ViewStateMessage = z.object({
  type: z.literal('viewState'),
  visible: z.array(z.string()),
  focused: z.string().nullable(),
})
```
…and add `ViewStateMessage,` to the `ClientMessage` union (after `PresenceMessage`, ≈line 367).

After `KillMessage` (≈line 583) add:

```ts
// Server→daemon: relay priority for one session (0=focused,1=visible,2=attached,
// 3=unwatched). Drives the daemon's output scheduler.
export const SessionPriorityMessage = z.object({
  type: z.literal('sessionPriority'),
  sessionId: z.string(),
  priority: z.number().int().min(0).max(3),
})
```
…and add `SessionPriorityMessage,` to the `ControlMessage` union (after `KillMessage`, ≈line 791).

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run vitest run packages/protocol/src/messages.test.ts && bun run --filter @podium/protocol typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): agentFrameBatch + viewState + sessionPriority messages"
```

---

## Phase 2 — Daemon output scheduler

### Task 3: `OutputScheduler`

**Files:**
- Create: `apps/daemon/src/output-scheduler.ts`, `apps/daemon/src/output-scheduler.test.ts`

**Interfaces (Produces):**
- `type Tier = 0 | 1 | 2 | 3`
- `interface OutputSchedulerDeps { flush: (sessionId: string, frames: string[]) => void; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void; scheduleImmediate?: (fn: () => void) => void; coalesceMs?: number; coalesceMaxBytes?: number }`
- `class OutputScheduler { constructor(deps: OutputSchedulerDeps); enqueue(sessionId: string, data: string): void; setPriority(sessionId: string, tier: Tier): void; remove(sessionId: string): void; stop(): void }`
- Behavior: default tier P1. P0/P1 → flush via `scheduleImmediate` (one batch per tick). P2/P3 → flush on `coalesceMs` timer OR when pending bytes ≥ `coalesceMaxBytes`. A priority change flushes pending immediately. `remove`/`stop` flush then drop state.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/output-scheduler.test.ts
import { describe, it, expect, vi } from 'vitest'
import { OutputScheduler } from './output-scheduler.js'

function harness() {
  const flushed: Array<{ sid: string; frames: string[] }> = []
  let immediate: (() => void) | null = null
  const timers = new Map<number, () => void>()
  let timerId = 0
  const s = new OutputScheduler({
    flush: (sid, frames) => flushed.push({ sid, frames }),
    scheduleImmediate: (fn) => { immediate = fn },
    setTimer: (fn, _ms) => { const id = ++timerId; timers.set(id, fn); return id },
    clearTimer: (h) => { timers.delete(h as number) },
    coalesceMs: 75,
    coalesceMaxBytes: 10,
  })
  return { s, flushed, runImmediate: () => { const f = immediate; immediate = null; f?.() }, fireTimer: (id = timerId) => timers.get(id)?.() }
}

describe('OutputScheduler', () => {
  it('P0/P1: frames within a tick flush as ONE batch on the immediate', () => {
    const h = harness()
    h.s.setPriority('s', 0)
    h.s.enqueue('s', 'a'); h.s.enqueue('s', 'b'); h.s.enqueue('s', 'c')
    expect(h.flushed).toEqual([])      // nothing sent synchronously
    h.runImmediate()
    expect(h.flushed).toEqual([{ sid: 's', frames: ['a', 'b', 'c'] }])
  })

  it('P3: frames coalesce until the timer fires', () => {
    const h = harness()
    h.s.setPriority('s', 3)
    h.s.enqueue('s', 'a'); h.s.enqueue('s', 'b')
    expect(h.flushed).toEqual([])
    h.fireTimer()
    expect(h.flushed).toEqual([{ sid: 's', frames: ['a', 'b'] }])
  })

  it('P3: a size-cap burst flushes immediately', () => {
    const h = harness()           // coalesceMaxBytes=10
    h.s.setPriority('s', 3)
    h.s.enqueue('s', '12345'); h.s.enqueue('s', '67890') // 10 bytes → cap hit
    expect(h.flushed).toEqual([{ sid: 's', frames: ['12345', '67890'] }])
  })

  it('promoting priority flushes pending right away', () => {
    const h = harness()
    h.s.setPriority('s', 3)
    h.s.enqueue('s', 'a')
    h.s.setPriority('s', 0)       // promote
    expect(h.flushed).toEqual([{ sid: 's', frames: ['a'] }])
  })

  it('remove flushes then drops state', () => {
    const h = harness()
    h.s.setPriority('s', 3)
    h.s.enqueue('s', 'a')
    h.s.remove('s')
    expect(h.flushed).toEqual([{ sid: 's', frames: ['a'] }])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run vitest run apps/daemon/src/output-scheduler.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `output-scheduler.ts`**

```ts
// apps/daemon/src/output-scheduler.ts
export type Tier = 0 | 1 | 2 | 3

export interface OutputSchedulerDeps {
  /** Send one coalesced batch for a session (caller wraps it as agentFrameBatch). */
  flush: (sessionId: string, frames: string[]) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  scheduleImmediate?: (fn: () => void) => void
  coalesceMs?: number
  coalesceMaxBytes?: number
}

interface Pending { frames: string[]; bytes: number; tier: Tier; timer: unknown; immediate: boolean }

/**
 * Per-session PTY-frame relay scheduler. Collapses many per-frame sends into one
 * batched send: P0/P1 (focused/visible) flush on the next tick (≈immediate, kills
 * the per-frame encode+send overhead with ~0 added latency); P2/P3 (attached/
 * unwatched) coalesce on a timer or a byte cap so a background flood never hitches
 * the loop carrying the focused session's echo.
 */
export class OutputScheduler {
  private readonly pending = new Map<string, Pending>()
  private readonly setTimer: NonNullable<OutputSchedulerDeps['setTimer']>
  private readonly clearTimer: NonNullable<OutputSchedulerDeps['clearTimer']>
  private readonly scheduleImmediate: NonNullable<OutputSchedulerDeps['scheduleImmediate']>
  private readonly coalesceMs: number
  private readonly coalesceMaxBytes: number

  constructor(private readonly deps: OutputSchedulerDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.scheduleImmediate = deps.scheduleImmediate ?? ((fn) => queueMicrotask(fn))
    this.coalesceMs = deps.coalesceMs ?? 75
    this.coalesceMaxBytes = deps.coalesceMaxBytes ?? 64 * 1024
  }

  private state(sessionId: string): Pending {
    let p = this.pending.get(sessionId)
    if (!p) {
      p = { frames: [], bytes: 0, tier: 1, timer: undefined, immediate: false }
      this.pending.set(sessionId, p)
    }
    return p
  }

  enqueue(sessionId: string, data: string): void {
    const p = this.state(sessionId)
    p.frames.push(data)
    p.bytes += data.length
    if (p.tier <= 1) {
      if (!p.immediate) {
        p.immediate = true
        this.scheduleImmediate(() => this.flush(sessionId))
      }
      return
    }
    if (p.bytes >= this.coalesceMaxBytes) {
      this.flush(sessionId)
      return
    }
    if (p.timer === undefined) p.timer = this.setTimer(() => this.flush(sessionId), this.coalesceMs)
  }

  setPriority(sessionId: string, tier: Tier): void {
    const p = this.state(sessionId)
    if (p.tier === tier) return
    p.tier = tier
    if (p.frames.length > 0) this.flush(sessionId) // don't strand buffered output across a tier change
  }

  private flush(sessionId: string): void {
    const p = this.pending.get(sessionId)
    if (!p) return
    if (p.timer !== undefined) { this.clearTimer(p.timer); p.timer = undefined }
    p.immediate = false
    if (p.frames.length === 0) return
    const frames = p.frames
    p.frames = []
    p.bytes = 0
    this.deps.flush(sessionId, frames)
  }

  remove(sessionId: string): void {
    this.flush(sessionId)
    const p = this.pending.get(sessionId)
    if (p?.timer !== undefined) this.clearTimer(p.timer)
    this.pending.delete(sessionId)
  }

  stop(): void {
    for (const sid of [...this.pending.keys()]) this.remove(sid)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run vitest run apps/daemon/src/output-scheduler.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/output-scheduler.ts apps/daemon/src/output-scheduler.test.ts
git commit -m "feat(daemon): per-session OutputScheduler (P0/P1 per-tick, P2/P3 coalesced)"
```

### Task 4: wire the scheduler into the daemon

**Files:**
- Modify: `apps/daemon/src/daemon.ts` (`wireBridge` ≈977, `send` ≈743, `handleControlMessage` switch ≈1270, `onExit`/`kill`/`disposeAll`).
- Create: `apps/daemon/src/output-scheduler-isolation.bun.test.ts`

**Interfaces:**
- Consumes: `OutputScheduler` from `./output-scheduler`; `agentFrameBatch` wire.

- [ ] **Step 1: Construct the scheduler near the daemon's `send`**

In `apps/daemon/src/daemon.ts`, add `import { OutputScheduler, type Tier } from './output-scheduler'` at the top, and after the `send` function (≈line 754) add:

```ts
// Coalesce + prioritize PTY frame relay (the per-frame stringify+send was the
// dominant residual loop hitch). flush() sends one agentFrameBatch per session.
const outputScheduler = new OutputScheduler({
  flush: (sessionId, frames) => send({ type: 'agentFrameBatch', sessionId, frames }),
})
```

- [ ] **Step 2: Route `onFrame` through the scheduler**

Replace the `session.onFrame` body in `wireBridge` (≈977-982):

```ts
    session.onFrame((frame) => {
      countFrame(frame.data.length)
      outputScheduler.enqueue(sessionId, frame.data)
    })
```

- [ ] **Step 3: Handle `sessionPriority` + lifecycle**

In `handleControlMessage`'s switch, after `case 'redraw':` add:

```ts
      case 'sessionPriority':
        outputScheduler.setPriority(msg.sessionId, msg.priority as Tier)
        break
```

In `wireBridge`'s `session.onExit` handler (after `bridges.delete(sessionId)`) add `outputScheduler.remove(sessionId)`. In `handleControlMessage`'s `case 'kill'` (after `bridges.delete(msg.sessionId)`) add `outputScheduler.remove(msg.sessionId)`. In `disposeAll` (after `workerClient.stop()`) add `outputScheduler.stop()`.

- [ ] **Step 4: Write the isolation test (real timers, bun)**

```ts
// apps/daemon/src/output-scheduler-isolation.bun.test.ts
// Run: bun --conditions=@podium/source test apps/daemon/src/output-scheduler-isolation.bun.test.ts
import { test, expect } from 'bun:test'
import { OutputScheduler } from './output-scheduler'

test('a P3 flood does not delay a P0 session and stays batched', async () => {
  const sent: Array<{ sid: string; n: number }> = []
  const s = new OutputScheduler({
    flush: (sid, frames) => sent.push({ sid, n: frames.length }),
    coalesceMs: 50,
    coalesceMaxBytes: 1_000_000, // disable size-cap so we test the timer path
  })
  s.setPriority('bg', 3)
  s.setPriority('fg', 0)
  // background floods 500 frames; foreground sends 1
  for (let i = 0; i < 500; i++) s.enqueue('bg', 'x')
  s.enqueue('fg', 'k')
  await new Promise((r) => setTimeout(r, 0))        // foreground per-tick flush
  const fgImmediate = sent.filter((x) => x.sid === 'fg')
  expect(fgImmediate).toEqual([{ sid: 'fg', n: 1 }]) // fg flushed on the tick, batched once
  expect(sent.some((x) => x.sid === 'bg')).toBe(false) // bg NOT flushed yet (still coalescing)
  await new Promise((r) => setTimeout(r, 80))
  const bg = sent.filter((x) => x.sid === 'bg')
  expect(bg.length).toBe(1)                          // 500 frames → ONE batched send
  expect(bg[0]!.n).toBe(500)
})
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run --filter @podium/daemon typecheck && bun run vitest run apps/daemon && bun --conditions=@podium/source test apps/daemon/src/output-scheduler-isolation.bun.test.ts`
Expected: PASS (daemon suite green; isolation test green). Fix any daemon.test.ts case that asserted a per-frame `agentFrame` send — it now receives `agentFrameBatch` (update the expectation; the scheduler defaults P1 → flushes on the next tick).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/daemon.ts apps/daemon/src/output-scheduler-isolation.bun.test.ts apps/daemon/src/daemon.test.ts
git commit -m "feat(daemon): relay PTY frames through the OutputScheduler (coalesced agentFrameBatch)"
```

---

## Phase 3 — Server priority

### Task 5: `computePriorities` (pure, union across clients)

**Files:**
- Create: `apps/server/src/session-priority.ts`, `apps/server/src/session-priority.test.ts`

**Interfaces (Produces):**
- `interface PriorityClient { attached: ReadonlySet<string>; viewVisible: ReadonlySet<string>; focused: string | null }`
- `function computePriorities(clients: Iterable<PriorityClient>, sessionIds: Iterable<string>): Map<string, 0|1|2|3>` — per session, the strongest tier any client assigns it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/session-priority.test.ts
import { describe, it, expect } from 'vitest'
import { computePriorities } from './session-priority.js'

const C = (attached: string[], viewVisible: string[], focused: string | null) =>
  ({ attached: new Set(attached), viewVisible: new Set(viewVisible), focused })

describe('computePriorities', () => {
  it('focused=0, visible=1, attached=2, unwatched=3', () => {
    const p = computePriorities([C(['a', 'b', 'c'], ['a', 'b'], 'a')], ['a', 'b', 'c', 'd'])
    expect(p.get('a')).toBe(0) // focused
    expect(p.get('b')).toBe(1) // visible, not focused
    expect(p.get('c')).toBe(2) // attached, not visible
    expect(p.get('d')).toBe(3) // nobody
  })
  it('unions across clients: mobile focuses A, desktop focuses B → both P0', () => {
    const p = computePriorities([C(['a'], ['a'], 'a'), C(['b'], ['b'], 'b')], ['a', 'b'])
    expect(p.get('a')).toBe(0)
    expect(p.get('b')).toBe(0)
  })
  it('a hidden client (visible=[]) drops its sessions to attached', () => {
    const p = computePriorities([C(['a'], [], null)], ['a'])
    expect(p.get('a')).toBe(2)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run vitest run apps/server/src/session-priority.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/server/src/session-priority.ts
export interface PriorityClient {
  attached: ReadonlySet<string>
  viewVisible: ReadonlySet<string>
  focused: string | null
}

/** Per session, the strongest tier ANY client assigns it (lower = higher priority):
 *  0 focused, 1 visible, 2 attached, 3 unwatched. */
export function computePriorities(
  clients: Iterable<PriorityClient>,
  sessionIds: Iterable<string>,
): Map<string, 0 | 1 | 2 | 3> {
  const out = new Map<string, 0 | 1 | 2 | 3>()
  for (const sid of sessionIds) {
    let best: 0 | 1 | 2 | 3 = 3
    for (const c of clients) {
      if (c.focused === sid) { best = 0; break }
      if (c.viewVisible.has(sid)) best = best < 1 ? best : 1
      else if (c.attached.has(sid)) best = best < 2 ? best : 2
    }
    out.set(sid, best)
  }
  return out
}
```

- [ ] **Step 4: Run + commit**

Run: `bun run vitest run apps/server/src/session-priority.test.ts && bun run --filter @podium/server typecheck`
Expected: PASS.

```bash
git add apps/server/src/session-priority.ts apps/server/src/session-priority.test.ts
git commit -m "feat(server): computePriorities (per-session union across clients)"
```

### Task 6: server tracks view-state, pushes priority, unpacks batch

**Files:**
- Modify: `apps/server/src/session.ts` (`ClientConn` ≈18-29), `apps/server/src/relay.ts` (`onClientMessage` ≈1088, `attachClient` ≈1028, `detachClient` ≈1057, `onDaemonMessage` ≈1149, the daemon-attach path).

**Interfaces:**
- Consumes: `computePriorities` from `./session-priority`; `toDaemon` (≈relay.ts:319).

- [ ] **Step 1: Extend `ClientConn`**

In `apps/server/src/session.ts` `ClientConn`, add after `visible: boolean`:

```ts
  /** Sessions this client currently RENDERS on screen (from viewState). */
  viewVisible: Set<string>
  /** The one session that has input focus on this client, or null. */
  focused: string | null
```

Initialize them in `attachClient` (relay.ts ≈1030, in the `this.clients.set(id, {...})` literal): `viewVisible: new Set(), focused: null,`.

- [ ] **Step 2: Add a recompute+push helper + a `lastPriority` cache**

In `relay.ts`, near the other private fields, add `private readonly lastPriority = new Map<string, number>()`. Add a method:

```ts
  /** Recompute per-session priority across all clients and push deltas to the daemon. */
  private pushPriorities(): void {
    const priorities = computePriorities(this.clients.values(), this.sessions.keys())
    for (const [sessionId, priority] of priorities) {
      if (this.lastPriority.get(sessionId) === priority) continue
      this.lastPriority.set(sessionId, priority)
      this.toDaemon({ type: 'sessionPriority', sessionId, priority })
    }
  }
```

Import `computePriorities` at the top of relay.ts.

- [ ] **Step 3: Handle `viewState` + call pushPriorities on the priority-affecting events**

In `onClientMessage`'s switch, after `case 'presence':` add:

```ts
      case 'viewState':
        client.viewVisible = new Set(msg.visible)
        client.focused = msg.focused
        this.pushPriorities()
        break
```

Add `this.pushPriorities()` at the end of `case 'attach'`, `case 'detach'`, and in `detachClient` (after `this.clients.delete(id)`).

- [ ] **Step 4: Unpack `agentFrameBatch`**

In `onDaemonMessage`'s switch, after `case 'agentFrame':` add:

```ts
      case 'agentFrameBatch': {
        const session = this.sessions.get(msg.sessionId)
        if (session) for (const data of msg.frames) session.onFrame(data)
        break
      }
```

- [ ] **Step 5: Send the full priority map when the daemon (re)connects**

Find `attachDaemon` in relay.ts (where `this.daemonSend` is set + `pendingToDaemon` flushed). After the daemon send is wired, call `this.lastPriority.clear(); this.pushPriorities()` so a freshly-(re)connected daemon gets the current priority of every live session. (Read the surrounding code to place it after `daemonSend` is assigned.)

- [ ] **Step 6: Run the server suite + typecheck**

Run: `bun run --filter @podium/server typecheck && bun run vitest run apps/server`
Expected: PASS. Add a relay test: a client sending `viewState{visible:[s],focused:s}` results in a `sessionPriority{sessionId:s,priority:0}` to the daemon (use the existing relay.test.ts harness + a fake daemon send sink); and `agentFrameBatch{frames:[d1,d2]}` produces two `outputFrame` broadcasts.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/session.ts apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(server): track per-client viewState, push session priorities, unpack agentFrameBatch"
```

---

## Phase 4 — Client

### Task 7: `setViewState` in terminal-client

**Files:**
- Modify: `packages/terminal-client/src/connection.ts` (`setVisible` ≈477; reconnect re-assert ≈234)

**Interfaces (Produces):** `SocketHub.setViewState(visible: string[], focused: string | null): void`

- [ ] **Step 1: Write the failing test**

```ts
// packages/terminal-client/src/connection.test.ts (add — mirror the existing setVisible test harness)
// Asserts setViewState sends { type:'viewState', visible, focused } when connected,
// stores it, and re-sends on reconnect. Use the file's existing fake-socket harness.
```
(Match the existing test style in this file; if there's a `setVisible` test, clone it for `setViewState`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run vitest run packages/terminal-client/src/connection.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `connection.ts`, add a field `private lastViewState: { visible: string[]; focused: string | null } = { visible: [], focused: null }` and a method mirroring `setVisible` (≈477):

```ts
  setViewState(visible: string[], focused: string | null): void {
    this.lastViewState = { visible, focused }
    if (this.connectedFlag) this.sendRaw({ type: 'viewState', visible, focused })
  }
```

In the reconnect `socket.onopen` handler (≈234, right after the `presence` re-assert) add:

```ts
      this.sendRaw({ type: 'viewState', ...this.lastViewState })
```

- [ ] **Step 4: Run + commit**

Run: `bun run vitest run packages/terminal-client/src/connection.test.ts && bun run --filter @podium/terminal-client typecheck`

```bash
git add packages/terminal-client/src/connection.ts packages/terminal-client/src/connection.test.ts
git commit -m "feat(terminal-client): setViewState (visible/focused) + reconnect re-assert"
```

### Task 8: web reports view-state

**Files:**
- Modify: `apps/web/src/store.tsx` (pane state ≈68-70, ≈236-238; visibility report ≈542; `setPane` ≈606)

**Interfaces:** Consumes `hub.setViewState`.

- [ ] **Step 1: Add `focusedPane` state**

In `store.tsx`, alongside `paneA`/`paneB`/`split`, add `const [focusedPane, setFocusedPane] = useState<'A' | 'B'>('A')`. Expose `setFocusedPane` on the store context and call it where a pane's terminal receives focus / is clicked (the AgentPanel/terminal `onFocus`); default 'A'.

- [ ] **Step 2: Derive + send viewState (debounced) on change**

Add an effect that recomputes and sends view-state whenever `paneA`, `paneB`, `split`, `focusedPane`, or tab visibility changes:

```ts
useEffect(() => {
  const tabVisible = document.visibilityState === 'visible'
  const visible = tabVisible
    ? [paneA, split ? paneB : null].filter((x): x is string => x != null)
    : []
  const focusedId = tabVisible ? (focusedPane === 'A' ? paneA : paneB) : null
  hub.setViewState(visible, focusedId)
}, [hub, paneA, paneB, split, focusedPane])
```

Also call this from the existing `visibilitychange` listener (≈542) so hiding the tab clears view-state. (Hoist the body into a `reportViewState` callback and call it from both.)

- [ ] **Step 3: Verify**

Run: `bun run --filter @podium/web typecheck && bun run --filter @podium/web test`
Expected: PASS (web tests run under happy-dom via the package's own config). Add/adjust a store test if the file has store-level tests; otherwise typecheck + manual is acceptable for this wiring (note it in the report).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/store.tsx
git commit -m "feat(web): report per-session viewState (visible panels + focused pane)"
```

---

## Phase 5 — Verify

### Task 9: end-to-end + live

- [ ] **Step 1: Whole-repo verification**

Run: `bun run --filter '*' typecheck && bun run --filter '*' test` (per-package; the root `vitest run` mis-handles the web happy-dom env). Then the bun-only tests: `bun --conditions=@podium/source test apps/daemon/src/output-scheduler-isolation.bun.test.ts`.
Expected: all green (the keyecho PTY test is load-flaky — re-run in isolation if it fails).

- [ ] **Step 2: Integrate (only when the user says)**

Ensure Task 1's redeploy fix is on main first (so this deploy can't boot stale). Rebase + `git merge --ff-only` to live main; redeploy.

- [ ] **Step 3: Live-verify with the profiler**

With `PODIUM_LOOP_PROFILE` on, capture a window (`bun scripts/loop-probe.mjs 240 /tmp/after.csv` + the journal). Expect the `frames=NNN` attributed stalls to drop sharply; flood a background session while typing in a focused one and confirm the focused echo no longer hitches.

---

## Self-Review

**Spec coverage:** redeploy fix → Task 1 ✓; protocol (viewState/sessionPriority/agentFrameBatch) → Task 2 ✓; daemon scheduler (P0/P1 per-tick, P2/P3 coalesce) → Tasks 3-4 ✓; server union priority → Tasks 5-6 ✓; client viewState (attached existing + visible + focused) → Tasks 7-8 ✓; multi-client union → Task 5 test ✓; loop-isolation regression → Task 4 ✓; live profiler verify → Task 9 ✓.

**Placeholder scan:** Task 7 Step 1 and Task 8 Step 3 defer to "the file's existing test harness / store tests" rather than pasting full client test code — because the terminal-client/web test setup (fake socket, happy-dom store render) is file-specific; the implementer mirrors the adjacent `setVisible`/store test. The behavior + assertions are specified. No "TODO/handle edge cases".

**Type consistency:** `agentFrameBatch.frames: string[]` (data only) consistent across protocol (Task 2), daemon flush (Task 4), server unpack (Task 6). `priority: 0|1|2|3` consistent (protocol min/max, `Tier`, computePriorities). `viewState{visible:string[],focused:string|null}` consistent across protocol, terminal-client, web, server. `OutputScheduler.{enqueue,setPriority,remove,stop}` used consistently in Task 4.

**Risk flagged:** the web "focused pane" concept is new (Task 8) — the implementer must find where a pane/terminal gains focus to call `setFocusedPane`; if the panel deck doesn't expose an onFocus seam, default focusedPane to the last-selected pane (`setPane`) as a fallback and note it.
