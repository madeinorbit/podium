# Interim SQLite Persistence — Layer 2 (tmux-backed session survival) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Run each agent inside its own per-session tmux server so the agent process outlives the daemon; the daemon attaches a node-pty tmux *client* that streams the pane. After Layer 2, a live agent survives a daemon restart, `tmux -L podium-<id> attach` works from any shell, and the OSC-title + input paths stay byte-faithful through tmux.

**Architecture:** New `@podium/agent-bridge` module `tmux.ts` provides `spawnTmuxAgent`/`attachTmuxAgent` (returning the existing `AgentSession` interface), `tmuxHasSession`, `killTmuxServer`, `isTmuxAvailable`. The per-PTY machinery (frames, OSC-title scan, redraw nudge, dispose) is extracted from `session.ts` into a shared `wrapPty(proc)` so both the direct-spawn and tmux-attach paths reuse it — crucially, `dispose()` is just `proc.kill()`, which *terminates the agent* for a direct child but *detaches the client* (agent survives) for a tmux-attach child. The daemon detects tmux at startup and spawns via tmux when available, falling back to the current direct node-pty spawn otherwise.

**Tech stack:** TypeScript ESM (no semicolons, single quotes — Biome), `node-pty`, real `tmux` (3.x), Vitest. Server/daemon run under Node via `tsx`.

**Scope:** Layer 2 of `docs/superpowers/specs/2026-06-09-interim-sqlite-persistence-design.md`. Layer 1 (SQLite store + durable ids + write-through + boot-load) is already on `main`. **Layer 2 does NOT change the protocol or wire the boot-reattach flow** — that's Layer 3 (`reattach`/`reattachFailed` messages + daemon reconcile + the manual input-fidelity dogfood). Layer 2 provides the agent-bridge primitives (`spawnTmuxAgent`/`attachTmuxAgent`/`tmuxHasSession`/`killTmuxServer`) that Layer 3 wires up, plus the daemon spawning under tmux.

## Spike results (already validated — these commands/config are proven)
A spike confirmed every load-bearing assumption against real tmux 3.4 + node-pty:
- Byte-transparency: agent stdout reaches the node-pty client. ✅
- **OSC title re-emit:** with `set -g set-titles on` + `set -g set-titles-string '#{pane_title}'`, tmux re-emits the agent's OSC title on the client stream, so the existing `createTitleScanner` catches it. ✅
- **Input fidelity:** with `set -g prefix None` + `set -sg escape-time 0`, bytes written to the client reach the agent stdin unmodified. ✅
- Survival: killing the client node-pty leaves the tmux session alive. ✅
- Reattach: a fresh `tmux attach` client gets a full repaint. ✅

Validated invocations (label = `podium-<sessionId>`, session name = `main`):
```
tmux -L <label> new-session -d -s main -x <cols> -y <rows> [-c <cwd>] <innerCmd>
tmux -L <label> set -g prefix None
tmux -L <label> set -sg escape-time 0
tmux -L <label> set -g status off
tmux -L <label> set -g set-titles on
tmux -L <label> set -g set-titles-string '#{pane_title}'
tmux -L <label> set -g extended-keys on
tmux -L <label> set -g allow-passthrough on
tmux -L <label> set -g default-terminal tmux-256color
tmux -L <label> set -ga terminal-overrides ',xterm-256color:RGB'
# client (the daemon's node-pty):
tmux -L <label> attach -t main
tmux -L <label> has-session -t main
tmux -L <label> kill-server
```

---

## Working directory & conventions
- Worktree: `/home/user/src/other/podium/.claude/worktrees/persistence-l2-tmux` (branched off `main`, has Layer 1 + polish). Run all commands from here; pass FULL worktree-prefixed absolute paths to Write/Edit.
- Run `bun install` once if `node_modules` is missing.
- Style: no semicolons, single quotes, 2-space indent. `node_modules/.bin/biome check --write <files>` before each commit.
- Tests: `node_modules/.bin/vitest run <file>`. tmux integration tests must `describe.skipIf(!hasTmux)` so CI without tmux still passes.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure
| File | Responsibility |
|------|----------------|
| `packages/agent-bridge/src/session.ts` (modify) | Extract `export function wrapPty(proc: IPty): AgentSession` (the frame/title/redraw/dispose machinery). `spawnAgent` becomes `wrapPty(spawn(...))`. No behavior change. |
| `packages/agent-bridge/src/tmux.ts` (create) | `isTmuxAvailable`, `tmuxHasSession`, `killTmuxServer`, `spawnTmuxAgent`, `attachTmuxAgent`, internal `configureTmux`/`shellQuote`/arg builders. |
| `packages/agent-bridge/src/tmux.test.ts` (create) | Unit (builders + `isTmuxAvailable`) + integration (`skipIf(!hasTmux)`): frames/title/input/survival/reattach/kill + the byte-parity gate. |
| `packages/agent-bridge/src/index.ts` (modify) | `export * from './tmux.js'`. |
| `apps/daemon/src/daemon.ts` (modify) | Detect tmux at startup; spawn via `spawnTmuxAgent` (label `podium-<sessionId>`) when available, else `spawnAgent`; `kill` → `killTmuxServer` + dispose; `close` → dispose only (agents survive). |
| `apps/daemon/src/daemon.test.ts` (modify) | Keep existing fallback behavior green; add a tmux-survival integration test (`skipIf`). |

---

## Task 1: Extract `wrapPty` from `session.ts` (no behavior change)

**Files:** Modify `packages/agent-bridge/src/session.ts`

- [ ] **Step 1: Verify the existing session tests are the safety net**

Run: `node_modules/.bin/vitest run packages/agent-bridge`
Expected: PASS (the existing `session.test.ts` etc.). This is the regression guard for the refactor.

- [ ] **Step 2: Refactor — extract `wrapPty`**

In `session.ts`, the current `spawnAgent(opts)` creates `const proc: IPty = spawn(opts.cmd, ...)` then builds the returned object. Split it: keep the `proc` creation in `spawnAgent`, and move everything that uses `proc` to build the `AgentSession` into a new exported function `wrapPty`.

```ts
/** Wrap an existing PTY in the AgentSession frame/title/redraw/dispose machinery.
 *  dispose() calls proc.kill(): for a direct agent child this terminates the agent;
 *  for a `tmux attach` client it merely detaches (the tmux server/agent survives). */
export function wrapPty(proc: IPty): AgentSession {
  let cols = proc.cols
  let rows = proc.rows
  let seq = 0
  let disposed = false
  let cancelNudge: (() => void) | undefined
  const frameCbs = new Set<(f: AgentFrame) => void>()
  const exitCbs = new Set<(code: number) => void>()
  const titleCbs = new Set<(t: string) => void>()
  const titleScanner = createTitleScanner()
  let lastTitle: string | undefined

  proc.onData((data: string) => {
    const frame: AgentFrame = { seq, data: Buffer.from(data, 'utf8').toString('base64') }
    seq += 1
    for (const cb of [...frameCbs]) cb(frame)
    for (const raw of titleScanner.push(data)) {
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
    onFrame(cb) {
      frameCbs.add(cb)
      return () => frameCbs.delete(cb)
    },
    onTitle(cb) {
      titleCbs.add(cb)
      return () => titleCbs.delete(cb)
    },
    onExit(cb) {
      exitCbs.add(cb)
      return () => exitCbs.delete(cb)
    },
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
    redraw() {
      if (disposed) return
      if (rows <= 1) {
        proc.write('\x0c')
        return
      }
      cancelNudge?.()
      proc.resize(cols, rows - 1)
      const restore = () => {
        frameCbs.delete(restore)
        cancelNudge = undefined
        if (!disposed) proc.resize(cols, rows)
      }
      cancelNudge = () => {
        frameCbs.delete(restore)
        cancelNudge = undefined
      }
      frameCbs.add(restore)
    },
    geometry() {
      return { cols, rows }
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelNudge?.()
      frameCbs.clear()
      titleCbs.clear()
      exitCbs.clear()
      try {
        proc.kill()
      } catch {}
    },
  }
}
```

Note: `redraw`'s restore callback was registered into `frameCbs` as a frame callback in the original; preserve that exact behavior (the original adds `restore` to `frameCbs` so it fires on the next frame). Keep it identical.

Then `spawnAgent` becomes:

```ts
export function spawnAgent(opts: SpawnOptions): AgentSession {
  const proc: IPty = spawn(opts.cmd, opts.args ?? [], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })
  return wrapPty(proc)
}
```

(The `restore` closure in the original references `frameCbs`/`cancelNudge` — they're all inside `wrapPty` now, so it works. Double-check the original `redraw` used a `restore` that deletes itself from `frameCbs`; the version above matches.)

- [ ] **Step 3: Run the session tests to verify no behavior change**

Run: `node_modules/.bin/biome check --write packages/agent-bridge/src/session.ts && node_modules/.bin/vitest run packages/agent-bridge`
Expected: PASS — identical results to Step 1.

- [ ] **Step 4: Commit**
```bash
git add packages/agent-bridge/src/session.ts
git commit -m "refactor(agent-bridge): extract wrapPty from spawnAgent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `tmux.ts` — primitives + spawn/attach

**Files:** Create `packages/agent-bridge/src/tmux.ts`; Test `packages/agent-bridge/src/tmux.test.ts`

- [ ] **Step 1: Write the failing unit test (builders + availability)**

Create `packages/agent-bridge/src/tmux.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isTmuxAvailable, newSessionArgs, shellQuote, tmuxConfigCommands } from './tmux'

describe('tmux command builders', () => {
  it('shell-quotes args safely', () => {
    expect(shellQuote(`a b`)).toBe(`'a b'`)
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('builds a new-session arg vector with geometry + cwd + inner command', () => {
    expect(newSessionArgs('podium-x', 80, 24, '/p', 'claude --resume t9')).toEqual([
      '-L', 'podium-x', 'new-session', '-d', '-s', 'main',
      '-x', '80', '-y', '24', '-c', '/p', 'claude --resume t9',
    ])
  })

  it('config commands include the input-fidelity + title settings', () => {
    const cmds = tmuxConfigCommands('podium-x')
    const flat = cmds.map((c) => c.join(' '))
    expect(flat).toContain('-L podium-x set -g prefix None')
    expect(flat).toContain('-L podium-x set -sg escape-time 0')
    expect(flat).toContain(`-L podium-x set -g set-titles-string #{pane_title}`)
    expect(flat).toContain('-L podium-x set -g extended-keys on')
  })

  it('isTmuxAvailable returns a boolean', () => {
    expect(typeof isTmuxAvailable()).toBe('boolean')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node_modules/.bin/vitest run packages/agent-bridge/src/tmux.test.ts`
Expected: FAIL — `./tmux` not found.

- [ ] **Step 3: Implement `tmux.ts`**

Create `packages/agent-bridge/src/tmux.ts`:
```ts
import { execFileSync, spawnSync } from 'node:child_process'
import { spawn as ptySpawn } from 'node-pty'
import { type AgentSession, wrapPty } from './session.js'

const SESSION = 'main'

/** POSIX single-quote a string for `sh -c` (tmux runs new-session's command via the shell). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function newSessionArgs(
  label: string,
  cols: number,
  rows: number,
  cwd: string | undefined,
  inner: string,
): string[] {
  return [
    '-L', label, 'new-session', '-d', '-s', SESSION,
    '-x', String(cols), '-y', String(rows),
    ...(cwd ? ['-c', cwd] : []),
    inner,
  ]
}

/** Config applied right after new-session, before the client attaches (spike-validated). */
export function tmuxConfigCommands(label: string): string[][] {
  const set = (...a: string[]): string[] => ['-L', label, 'set', ...a]
  return [
    set('-g', 'prefix', 'None'),
    set('-sg', 'escape-time', '0'),
    set('-g', 'status', 'off'),
    set('-g', 'set-titles', 'on'),
    set('-g', 'set-titles-string', '#{pane_title}'),
    set('-g', 'extended-keys', 'on'),
    set('-g', 'allow-passthrough', 'on'),
    set('-g', 'default-terminal', 'tmux-256color'),
    set('-ga', 'terminal-overrides', ',xterm-256color:RGB'),
  ]
}

export function isTmuxAvailable(): boolean {
  try {
    return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

export function tmuxHasSession(label: string): boolean {
  return (
    spawnSync('tmux', ['-L', label, 'has-session', '-t', SESSION], { stdio: 'ignore' }).status === 0
  )
}

export function killTmuxServer(label: string): void {
  try {
    execFileSync('tmux', ['-L', label, 'kill-server'], { stdio: 'ignore' })
  } catch {
    // already gone
  }
}

export interface TmuxSpawnOptions {
  label: string
  cmd: string
  args?: string[]
  cwd?: string
  cols: number
  rows: number
  env?: Record<string, string>
}

/** Create a detached per-session tmux server running the agent, apply config, attach a client. */
export function spawnTmuxAgent(opts: TmuxSpawnOptions): AgentSession {
  const inner = [opts.cmd, ...(opts.args ?? [])].map(shellQuote).join(' ')
  const env = { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>
  execFileSync('tmux', newSessionArgs(opts.label, opts.cols, opts.rows, opts.cwd, inner), {
    stdio: 'ignore',
    env,
  })
  for (const args of tmuxConfigCommands(opts.label)) {
    execFileSync('tmux', args, { stdio: 'ignore' })
  }
  return attachTmuxAgent({ label: opts.label, cols: opts.cols, rows: opts.rows, env: opts.env })
}

/** Attach a node-pty tmux client to an existing session. dispose() detaches (agent survives). */
export function attachTmuxAgent(opts: {
  label: string
  cols: number
  rows: number
  env?: Record<string, string>
}): AgentSession {
  const proc = ptySpawn('tmux', ['-L', opts.label, 'attach', '-t', SESSION], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    env: { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })
  return wrapPty(proc)
}
```

- [ ] **Step 4: Format + run to verify pass**

Run: `node_modules/.bin/biome check --write packages/agent-bridge/src/tmux.ts packages/agent-bridge/src/tmux.test.ts && node_modules/.bin/vitest run packages/agent-bridge/src/tmux.test.ts`
Expected: PASS (4 builder/availability tests).

- [ ] **Step 5: Commit**
```bash
git add packages/agent-bridge/src/tmux.ts packages/agent-bridge/src/tmux.test.ts
git commit -m "feat(agent-bridge): tmux-backed agent sessions (spawn/attach/has-session/kill)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: tmux integration tests (the spike, formalized)

**Files:** Test `packages/agent-bridge/src/tmux.test.ts` (add a `skipIf` integration block); fixture `packages/agent-bridge/test/fixtures/echo-title.mjs`

- [ ] **Step 1: Create the inner fixture**

Create `packages/agent-bridge/test/fixtures/echo-title.mjs`:
```js
// Integration fixture: marker, OSC title, hex-echo of stdin, stays alive.
process.stdout.write('READY\n')
process.stdout.write('\x1b]2;FIXTURE-TITLE\x07')
process.stdin.on('data', (d) => process.stdout.write('ECHO[' + d.toString('hex') + ']'))
setInterval(() => {}, 1000)
```

- [ ] **Step 2: Write the integration tests**

Append to `packages/agent-bridge/src/tmux.test.ts`:
```ts
import { fileURLToPath } from 'node:url'
import {
  attachTmuxAgent,
  killTmuxServer,
  spawnTmuxAgent,
  tmuxHasSession,
} from './tmux'

const hasTmux = isTmuxAvailable()
const FIXTURE = fileURLToPath(new URL('../test/fixtures/echo-title.mjs', import.meta.url))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hasTmux)('tmux integration', () => {
  it('streams frames, surfaces the OSC title, round-trips input, survives detach, reattaches, kills', async () => {
    const label = `podium-itest-${process.pid}`
    killTmuxServer(label)
    const session = spawnTmuxAgent({
      label,
      cmd: 'node',
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })
    let out = ''
    let title = ''
    session.onFrame((f) => {
      out += Buffer.from(f.data, 'base64').toString('utf8')
    })
    session.onTitle((t) => {
      title = t
    })
    await wait(700)
    expect(out).toContain('READY') // byte-transparency
    expect(title).toContain('FIXTURE-TITLE') // OSC title re-emit via set-titles

    session.write(Buffer.from('hi\r', 'utf8').toString('base64'))
    await wait(500)
    expect(out).toContain('6869') // input reached the agent (hex of 'hi')

    // dispose() detaches the client; the agent (tmux server) survives.
    session.dispose()
    await wait(300)
    expect(tmuxHasSession(label)).toBe(true)

    // reattach gets a repaint.
    const re = attachTmuxAgent({ label, cols: 80, rows: 24 })
    let out2 = ''
    re.onFrame((f) => {
      out2 += Buffer.from(f.data, 'base64').toString('utf8')
    })
    await wait(500)
    expect(out2.length).toBeGreaterThan(0)
    re.dispose()

    // explicit kill terminates the agent.
    killTmuxServer(label)
    await wait(200)
    expect(tmuxHasSession(label)).toBe(false)
  }, 15000)
})
```

- [ ] **Step 3: Run**

Run: `node_modules/.bin/vitest run packages/agent-bridge/src/tmux.test.ts`
Expected: PASS (unit + the integration test). If tmux is absent the integration block is skipped (still green). If `title` is empty, the `set-titles` re-emit failed — do NOT weaken the test; investigate (`tmux show -g set-titles`), but the spike proved it works on 3.4.

- [ ] **Step 4: Commit**
```bash
git add packages/agent-bridge/src/tmux.test.ts packages/agent-bridge/test/fixtures/echo-title.mjs
git commit -m "test(agent-bridge): tmux integration — frames/title/input/survival/reattach

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Input-fidelity byte-parity gate (front-loaded from spec §10.1)

**Files:** Test `packages/agent-bridge/src/tmux.test.ts` (add); fixture `packages/agent-bridge/test/fixtures/stdin-hex.mjs`

- [ ] **Step 1: Create a stdin-capture fixture**

Create `packages/agent-bridge/test/fixtures/stdin-hex.mjs`:
```js
// Emits the exact hex of every stdin chunk, framed, so a test can assert byte-fidelity.
process.stdin.on('data', (d) => process.stdout.write('<' + d.toString('hex') + '>'))
setInterval(() => {}, 1000)
```

- [ ] **Step 2: Write the parity test**

Append to `packages/agent-bridge/src/tmux.test.ts`:
```ts
import { spawnAgent } from './session'

describe.skipIf(!hasTmux)('tmux input-fidelity parity', () => {
  // The exact byte sequences that matter for agent control: Ctrl-C, Alt/Meta (ESC+char),
  // arrow keys (CSI), bracketed paste markers, and multi-byte UTF-8.
  const SAMPLES: Record<string, string> = {
    ctrlC: '03',
    altX: '1b78', // ESC + 'x'  (Meta-x)
    upArrow: '1b5b41', // ESC [ A
    utf8: 'c3a9', // 'é'
  }
  const HEX_FIXTURE = fileURLToPath(new URL('../test/fixtures/stdin-hex.mjs', import.meta.url))
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  async function received(via: 'tmux' | 'direct', hex: string): Promise<string> {
    const bytes = Buffer.from(hex, 'hex')
    let out = ''
    let session: import('./session').AgentSession
    let label = ''
    if (via === 'tmux') {
      label = `podium-fid-${process.pid}-${hex}`
      killTmuxServer(label)
      session = spawnTmuxAgent({ label, cmd: 'node', args: [HEX_FIXTURE], cols: 80, rows: 24 })
    } else {
      session = spawnAgent({ cmd: 'node', args: [HEX_FIXTURE], cols: 80, rows: 24 })
    }
    session.onFrame((f) => {
      out += Buffer.from(f.data, 'base64').toString('utf8')
    })
    await wait(500)
    session.write(bytes.toString('base64'))
    await wait(500)
    session.dispose()
    if (via === 'tmux') killTmuxServer(label)
    const m = out.match(/<([0-9a-f]*)>/g)
    return (m ?? []).join('')
  }

  for (const [name, hex] of Object.entries(SAMPLES)) {
    it(`delivers ${name} (${hex}) through tmux identically to direct node-pty`, async () => {
      const direct = await received('direct', hex)
      const tmux = await received('tmux', hex)
      expect(direct).toContain(hex) // sanity: direct path delivers the bytes
      expect(tmux).toContain(hex) // PARITY: tmux delivers the same bytes
    }, 15000)
  }
})
```

- [ ] **Step 3: Run**

Run: `node_modules/.bin/vitest run packages/agent-bridge/src/tmux.test.ts`
Expected: PASS — every sample arrives byte-identical via tmux and direct. A failure here is the spec's "reconsider tmux" trigger; do NOT weaken — investigate the tmux config (`extended-keys`, `escape-time`).

- [ ] **Step 4: Commit**
```bash
git add packages/agent-bridge/src/tmux.test.ts packages/agent-bridge/test/fixtures/stdin-hex.mjs
git commit -m "test(agent-bridge): input-fidelity byte-parity gate (tmux vs direct node-pty)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Export tmux from the package entry

**Files:** Modify `packages/agent-bridge/src/index.ts`

- [ ] **Step 1: Add the export**

Add to `packages/agent-bridge/src/index.ts` (with the other `export *` lines):
```ts
export * from './tmux.js'
```

- [ ] **Step 2: Verify the package typechecks + tests pass**

Run: `node_modules/.bin/biome check --write packages/agent-bridge/src/index.ts && bun run --filter @podium/agent-bridge typecheck && node_modules/.bin/vitest run packages/agent-bridge`
Expected: typecheck exit 0; all agent-bridge tests pass.

- [ ] **Step 3: Commit**
```bash
git add packages/agent-bridge/src/index.ts
git commit -m "feat(agent-bridge): export tmux session helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Daemon spawns under tmux (with survival on close + no-tmux fallback)

**Files:** Modify `apps/daemon/src/daemon.ts`; Test `apps/daemon/src/daemon.test.ts`

- [ ] **Step 1: Write a failing daemon survival test**

Read `apps/daemon/src/daemon.test.ts` for its harness (it starts a daemon against a fake/real server and injects `launch`). Add a `skipIf(!isTmuxAvailable())` test: spawn a session through the daemon with tmux available, then call `daemon.close()`, and assert the tmux session is STILL alive (`tmuxHasSession('podium-<id>')` true) — i.e. agents survive daemon shutdown. Then `killTmuxServer` to clean up. (Mirror the existing daemon test's spawn flow; assert survival rather than death.)

- [ ] **Step 2: Run to verify it fails**

Run: `node_modules/.bin/vitest run apps/daemon`
Expected: FAIL — today `close()`/`disposeAll()` kills the agent, so the tmux session would not survive (or tmux isn't used at all yet).

- [ ] **Step 3: Implement tmux mode in the daemon**

In `apps/daemon/src/daemon.ts`:
- Import: `import { isTmuxAvailable, killTmuxServer, spawnTmuxAgent } from '@podium/agent-bridge'` (alongside the existing `spawnAgent` import).
- At the top of `startDaemon`, after resolving `launch`: `const tmuxMode = isTmuxAvailable()` and `if (!tmuxMode) console.warn('[podium] tmux not found — sessions will not survive a daemon restart')`.
- In `spawn(msg)`, after building `cmd` via `launch(...)`, branch:
  ```ts
  const label = `podium-${msg.sessionId}`
  const session = tmuxMode
    ? spawnTmuxAgent({ label, cmd: cmd.cmd, args: cmd.args, cwd: cmd.cwd, cols: msg.geometry.cols, rows: msg.geometry.rows })
    : spawnAgent({ cmd: cmd.cmd, args: cmd.args, cwd: cmd.cwd, cols: msg.geometry.cols, rows: msg.geometry.rows })
  ```
  The rest of the wiring (`onFrame`→agentFrame, `onTitle`→title, `onExit`→agentExit, `bind`) is unchanged.
- In the `kill` case: after `session.dispose()` and `bridges.delete(msg.sessionId)`, add `if (tmuxMode) killTmuxServer(\`podium-${msg.sessionId}\`)` — explicit terminate (dispose only detached the client).
- In `disposeAll()` (called by `close()`): keep `for (const session of bridges.values()) session.dispose()` — for tmux this only detaches the clients, so the agents SURVIVE the daemon going down. Do NOT kill tmux servers here. (Add a one-line comment saying so.)

- [ ] **Step 4: Format + run**

Run: `node_modules/.bin/biome check --write apps/daemon/src/daemon.ts apps/daemon/src/daemon.test.ts && node_modules/.bin/vitest run apps/daemon`
Expected: PASS — the survival test passes under tmux; existing daemon tests still pass (fallback path unchanged when tmux absent, and the injected-`launch` tests still work because the spawn flow is the same shape). If an existing test breaks because it now goes through tmux, gate it or make the daemon honor an explicit `tmux: false` option for that test (add `tmux?: boolean` to `DaemonOptions`, default `isTmuxAvailable()`); prefer the option so tests are deterministic.

- [ ] **Step 5: Commit**
```bash
git add apps/daemon/src/daemon.ts apps/daemon/src/daemon.test.ts
git commit -m "feat(daemon): spawn agents under tmux so they survive daemon restart (fallback when absent)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification

**Files:** none

- [ ] **Step 1: Typecheck the touched packages**

Run: `bun run --filter @podium/agent-bridge typecheck && bun run --filter @podium/daemon typecheck`
Expected: exit 0 each.

- [ ] **Step 2: Lint**

Run: `node_modules/.bin/biome check packages/agent-bridge apps/daemon`
Expected: clean.

- [ ] **Step 3: Full suite**

Run: `node_modules/.bin/vitest run`
Expected: all green (the tmux integration + parity tests run since tmux is present; the pre-existing `apps/daemon` git-scan test may need `--testTimeout=30000` in this sandbox — note it, it is unrelated).

- [ ] **Step 4: Manual smoke (tmux survival end-to-end)**

```bash
DIR=$(mktemp -d)
# (requires built dist for @podium/* under tsx; run `bun run build` first if needed)
# Spawn via the daemon path, then prove the tmux server outlives the process.
tmux ls 2>/dev/null | grep podium- || echo "(no leftover podium servers)"
```
Confirm that after spawning a session and stopping the daemon, `tmux -L podium-<id> has-session -t main` still succeeds and `tmux -L podium-<id> attach` shows the live agent. (Exact harness optional — the integration tests already prove survival programmatically.)

---

## Done criteria (Layer 2)
- `spawnTmuxAgent`/`attachTmuxAgent`/`tmuxHasSession`/`killTmuxServer`/`isTmuxAvailable` exported from `@podium/agent-bridge`.
- Agents spawn inside per-session tmux servers; OSC title surfaces via the existing scanner; input is byte-identical to direct node-pty (parity gate green).
- `daemon.close()` leaves agents alive (survival); `kill` terminates them; no-tmux falls back gracefully.
- All package typechecks + the full vitest suite green.

## Next (Layer 3 — separate plan)
`reattach`/`reattachFailed` protocol messages + `hibernated`/`reconnecting` status; server boot loads `live` rows as `reconnecting`; daemon `has-session`-checks and re-binds survivors so clients see live terminals after a backend restart; the manual Alt/Option dogfood from spec §10.1. `loadFromStore` (Layer 1) must stop collapsing non-`exited` rows to `exited` and instead drive the reattach path.
