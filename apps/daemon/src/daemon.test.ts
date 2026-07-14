import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  abducoHasSession,
  claudeProjectSlug,
  isAbducoAvailable,
  isTmuxAvailable,
  killAbducoSession,
  killTmuxServer,
  tmuxHasSession,
} from '@podium/agent-bridge'
import type {
  ConversationDiagnosticWire,
  ConversationSummaryWire,
  DaemonHandshakeReply,
} from '@podium/protocol'
import { type DaemonMessage, encode, parseDaemonMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import {
  controlFrameByteLength,
  createLimiter,
  type DaemonHandle,
  normalizeAgentKind,
  noDurableBackendWarning,
  resolveDurableBackend,
  startDaemon,
} from './daemon'
import { type MemoryBreakdownJobInput, runMemoryBreakdownJob } from './discovery-jobs'
import { DiscoveryWorkerClient, type WorkerLike } from './worker-client'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

/**
 * A DiscoveryWorkerClient whose "worker" runs the real /proc job inline. Node-based
 * vitest cannot spawn the daemon's `.ts` worker (its bare imports have no TS loader
 * inside the Worker), so this exercises the same daemon→worker-client→job path
 * without a real thread; the live daemon (Bun) uses a real spawned worker, and the
 * real-worker spawn itself is proven by apps/daemon/test/worker-isolation.bun.test.ts.
 */
function inlineWorkerClient(): DiscoveryWorkerClient {
  return new DiscoveryWorkerClient({
    spawn: (): WorkerLike => {
      const handlers: Array<(m: unknown) => void> = []
      return {
        postMessage(m: unknown) {
          const job = m as { id: string; kind: string; input: MemoryBreakdownJobInput }
          const value = runMemoryBreakdownJob(job.input)
          // Reply on a turn of the loop, like a real worker thread would.
          queueMicrotask(() => {
            for (const h of handlers) h({ id: job.id, ok: true, value })
          })
        },
        on(ev, cb) {
          if (ev === 'message') handlers.push(cb)
        },
        terminate() {},
      }
    },
  })
}

type ConversationDelta = {
  changed: ConversationSummaryWire[]
  removed: string[]
  diagnostics: ConversationDiagnosticWire[]
}

/**
 * A DiscoveryWorkerClient whose `indexRefresh` job returns a fixed delta (and runs
 * the /proc memoryBreakdown job inline). Node-based vitest can't spawn the daemon's
 * real `.ts` worker (now the owner of discovery.db), so the periodic + on-demand
 * delta paths are exercised through this injected fake; the real worker spawn +
 * cache ownership are proven by apps/daemon/test/worker-isolation.bun.test.ts.
 */
function fakeDeltaWorkerClient(delta: ConversationDelta): DiscoveryWorkerClient {
  return new DiscoveryWorkerClient({
    spawn: (): WorkerLike => {
      const handlers: Array<(m: unknown) => void> = []
      return {
        postMessage(m: unknown) {
          const job = m as { id: string; kind: string; input: MemoryBreakdownJobInput }
          const value = job.kind === 'indexRefresh' ? delta : runMemoryBreakdownJob(job.input)
          queueMicrotask(() => {
            for (const h of handlers) h({ id: job.id, ok: true, value })
          })
        },
        on(ev, cb) {
          if (ev === 'message') handlers.push(cb)
        },
        terminate() {},
      }
    },
  })
}

/**
 * Like fakeDeltaWorkerClient but RECORDS the `full` flag of every `indexRefresh`
 * input, so a test can assert the connect-time + on-demand scans request a full
 * snapshot (`full: true`) while the periodic loop forwards only the delta (`full`
 * falsy). Returns the recorder array alongside the client.
 */
function recordingDeltaWorkerClient(delta: ConversationDelta): {
  client: DiscoveryWorkerClient
  fullFlags: Array<boolean | undefined>
} {
  const fullFlags: Array<boolean | undefined> = []
  const client = new DiscoveryWorkerClient({
    spawn: (): WorkerLike => {
      const handlers: Array<(m: unknown) => void> = []
      return {
        postMessage(m: unknown) {
          const job = m as {
            id: string
            kind: string
            input: MemoryBreakdownJobInput & { full?: boolean }
          }
          if (job.kind === 'indexRefresh') fullFlags.push(job.input.full)
          const value = job.kind === 'indexRefresh' ? delta : runMemoryBreakdownJob(job.input)
          queueMicrotask(() => {
            for (const h of handlers) h({ id: job.id, ok: true, value })
          })
        },
        on(ev, cb) {
          if (ev === 'message') handlers.push(cb)
        },
        terminate() {},
      }
    },
  })
  return { client, fullFlags }
}
const G = { cols: 80, rows: 24 }
const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8')
// The daemon now relays PTY output as coalesced `agentFrameBatch` messages
// (one batch per session per flush) rather than one `agentFrame` per frame.
// Flatten each batch back into per-frame {sessionId, data} so the existing
// frame-content assertions below keep reading individual frames.
type AgentFrameBatch = Extract<DaemonMessage, { type: 'agentFrameBatch' }>
type FlatFrame = { sessionId: string; data: string }

// The daemon now authenticates before doing anything: its FIRST frame is a `hello`
// handshake (driven by bootstrapToken: 'test' below) and it waits for `helloOk` before
// starting background work / accepting control messages. Every fake server here must
// therefore answer the handshake. This helper replies `helloOk` to the first frame (the
// hello), then records every subsequent DaemonMessage — exactly what the old bare
// `on('message')` did, minus the (now non-DaemonMessage) handshake frame.
function handshakeAndCollect(ws: WS, received: DaemonMessage[]): void {
  let authed = false
  ws.on('message', (raw) => {
    if (!authed) {
      authed = true
      const ok: DaemonHandshakeReply = { type: 'helloOk', name: 'test' }
      ws.send(encode(ok))
      return
    }
    received.push(parseDaemonMessage(raw.toString()))
  })
}

describe('daemon multi-bridge', () => {
  let wss: WebSocketServer
  let serverSocket: WS
  let received: DaemonMessage[]
  let daemon: DaemonHandle

  beforeEach(async () => {
    received = []
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        handshakeAndCollect(ws, received)
        r()
      })
    })
    daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      // direct node-pty path keeps these fixtures/assertions deterministic (no tmux dependency)
      tmux: false,
      discovery: { background: false, cachePath: ':memory:' },
      // inject the deterministic fixture instead of real claude/codex
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected
  })

  afterEach(async () => {
    await daemon.close()
    await new Promise<void>((r) => wss.close(() => r()))
  })

  const send = (msg: unknown): void => serverSocket.send(encode(msg as never))
  const frames = (): FlatFrame[] =>
    received
      .filter((m): m is AgentFrameBatch => m.type === 'agentFrameBatch')
      .flatMap((b) => b.frames.map((data) => ({ sessionId: b.sessionId, data })))
  const fixtureFrame = (sid: string): FlatFrame | undefined =>
    frames().find((f) => f.sessionId === sid && decode(f.data).includes('PODIUM-FIXTURE'))
  async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeout) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('spawns independent bridges and tags bind + frames by sessionId', async () => {
    send({ type: 'spawn', sessionId: 's1', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    send({ type: 'spawn', sessionId: 's2', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 's1'))
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 's2'))
    await waitFor(() => fixtureFrame('s1') !== undefined)
    await waitFor(() => fixtureFrame('s2') !== undefined)
    const sids = new Set(frames().map((f) => f.sessionId))
    expect([...sids].sort()).toEqual(['s1', 's2'])
  })

  it('forwards a changed cwd from the hook payload as sessionCwd (de-duped)', async () => {
    send({ type: 'spawn', sessionId: 's1', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 's1'))

    // Every Claude hook carries cwd; it follows EnterWorktree / cd. Simulate the
    // agent moving into a worktree by POSTing a hook with the new cwd.
    const post = (cwd: string): Promise<unknown> =>
      fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/s1`, {
        method: 'POST',
        body: JSON.stringify({ hook_event_name: 'PostToolUse', cwd }),
      })
    await post('/repo/.worktrees/feat')
    await waitFor(() =>
      received.some(
        (m) => m.type === 'sessionCwd' && m.sessionId === 's1' && m.cwd === '/repo/.worktrees/feat',
      ),
    )

    // A second hook with the SAME cwd forwards nothing further (daemon de-dup).
    const count = (): number => received.filter((m) => m.type === 'sessionCwd').length
    const before = count()
    await post('/repo/.worktrees/feat')
    await new Promise((r) => setTimeout(r, 100))
    expect(count()).toBe(before)
  })

  it('resolves a hook cwd inside a git checkout to the worktree root before forwarding', async () => {
    // A cd into a SUBDIRECTORY of the same checkout must not regroup the session:
    // the daemon resolves the hook cwd to its git toplevel and forwards that.
    const repo = join(mkdtempSync(join(tmpdir(), 'podium-cwd-git-')), 'repo')
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true })
    execFileSync('git', ['-C', repo, 'init', '-q'])

    send({ type: 'spawn', sessionId: 'sGit', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sGit'))
    await fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/sGit`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PostToolUse', cwd: join(repo, 'packages', 'web') }),
    })
    await waitFor(() =>
      received.some((m) => m.type === 'sessionCwd' && m.sessionId === 'sGit' && m.cwd === repo),
    )
    // The raw subdirectory path never went over the wire.
    expect(
      received.some((m) => m.type === 'sessionCwd' && m.cwd === join(repo, 'packages', 'web')),
    ).toBe(false)
  })

  it('session.setWorktree on the loopback relay restamps the session worktree locally', async () => {
    // The agent-initiated channel: `podium worktree <path>` POSTs to the issue-relay
    // loopback; the daemon handles session.setWorktree itself (never forwarded to
    // the server's tracker relay) — validate, resolve to git toplevel, sessionCwd.
    const repo = join(mkdtempSync(join(tmpdir(), 'podium-setwt-')), 'repo')
    mkdirSync(join(repo, 'sub'), { recursive: true })
    execFileSync('git', ['-C', repo, 'init', '-q'])

    send({ type: 'spawn', sessionId: 'sWt', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sWt'))
    const post = (input: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${daemon.issueRelayPort}/issue/sWt`, {
        method: 'POST',
        body: JSON.stringify({ router: 'session', proc: 'setWorktree', input }),
      })

    const ok = (await (await post({ path: join(repo, 'sub') })).json()) as {
      ok: boolean
      result?: { worktree: string }
    }
    expect(ok).toEqual({ ok: true, result: { worktree: repo } })
    await waitFor(() =>
      received.some((m) => m.type === 'sessionCwd' && m.sessionId === 'sWt' && m.cwd === repo),
    )

    // Relative and nonexistent paths are rejected without a sessionCwd send.
    const rel = (await (await post({ path: 'sub' })).json()) as { ok: boolean }
    expect(rel.ok).toBe(false)
    const gone = (await (await post({ path: join(repo, 'nope') })).json()) as { ok: boolean }
    expect(gone.ok).toBe(false)
  })

  it('routes resize to the right bridge; kill stops only the targeted one', async () => {
    send({ type: 'spawn', sessionId: 's1', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    send({ type: 'spawn', sessionId: 's2', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => fixtureFrame('s1') !== undefined)
    await waitFor(() => fixtureFrame('s2') !== undefined)

    send({ type: 'kill', sessionId: 's1' })
    send({ type: 'resize', sessionId: 's2', cols: 90, rows: 30 })
    // s2 repaints at the new width...
    await waitFor(() =>
      frames().some((f) => f.sessionId === 's2' && decode(f.data).includes('cols=90')),
    )
    await new Promise((r) => setTimeout(r, 100))
    // ...and the killed s1 never reports the new size (resize was routed only to s2).
    expect(frames().some((f) => f.sessionId === 's1' && decode(f.data).includes('cols=90'))).toBe(
      false,
    )
  })

  it('re-pushes agentState on reattach when it already holds the bridge (server restart)', async () => {
    // A server-only restart (the daemon survives) makes the server re-send `reattach`
    // for every live session. handleReattach's already-held-bridge branch re-seeds the
    // transcript but must ALSO re-push the surviving tracker's phase — otherwise the
    // freshly-restarted server holds no agentState for the session and the home board's
    // `live → working` fallback shows an idle survivor as WORKING.
    const sessionId = 'srv-restart-repush'
    send({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
    const idleStates = () =>
      received.filter(
        (m): m is Extract<DaemonMessage, { type: 'agentState' }> =>
          m.type === 'agentState' && m.sessionId === sessionId && m.state.phase === 'idle',
      )
    // The spawn boot-seed pushes idle exactly once (no hooks fire in this fixture).
    await waitFor(() => idleStates().length >= 1)
    const before = idleStates().length
    // Server reconnects and re-sends reattach for the live session; the daemon still
    // holds the bridge, so this hits the already-held branch.
    send({
      type: 'reattach',
      sessionId,
      durableLabel: `podium-${sessionId}`,
      agentKind: 'claude-code',
      cwd: '/tmp',
      geometry: G,
    })
    // The fix: the already-held branch re-pushes the surviving idle phase.
    await waitFor(() => idleStates().length > before)
    expect(idleStates().length).toBeGreaterThan(before)
  }, 15000)

  it('scanRequest forwards the worker delta as a wire-valid scanResult', async () => {
    // The scan now runs on the worker and returns a delta; the on-demand scanResult
    // carries the same delta fields (changed → `conversations`, plus `removed`),
    // tagged with the requestId. Node-based vitest can't spawn the real `.ts` worker,
    // so a fake worker client (injected via the daemon's workerClient seam) returns a
    // known delta. parseDaemonMessage (beforeEach) schema-validates every received
    // message, so a malformed wire summary would fail at parse.
    const changed: ConversationSummaryWire[] = [
      {
        id: 'sess-9',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        resume: { kind: 'claude-session', value: 'sess-9' },
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ]
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const received: DaemonMessage[] = []
    let serverWs: WS | undefined
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverWs = ws
        handshakeAndCollect(ws, received)
        r()
      })
    })
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      discovery: { background: false, cachePath: ':memory:' },
      metrics: { background: false },
      workerClient: fakeDeltaWorkerClient({ changed, removed: ['gone-1'], diagnostics: [] }),
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected
    try {
      serverWs?.send(encode({ type: 'scanRequest', requestId: 'req-1' } as never))
      const start = Date.now()
      while (!received.some((m) => m.type === 'scanResult')) {
        if (Date.now() - start > 5000) throw new Error('scanResult timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
    } finally {
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }
    const result = received.find(
      (m): m is Extract<DaemonMessage, { type: 'scanResult' }> => m.type === 'scanResult',
    )
    expect(result?.requestId).toBe('req-1')
    expect(result?.removed).toEqual(['gone-1'])
    const conv = result?.conversations.find((c) => c.id === 'sess-9')
    expect(conv).toMatchObject({
      agentKind: 'claude-code',
      providerId: 'claude-code-jsonl',
      resume: { kind: 'claude-session', value: 'sess-9' },
    })
    expect(typeof conv?.createdAt).toBe('string')
  })

  it('scanReposRequest returns a wire-valid repository for a seeded repo root', async () => {
    // Hand-build a minimal git repo (mirrors packages/agent-bridge git scanner fixtures).
    const root = await mkdtemp(join(tmpdir(), 'podium-repos-'))
    const repo = join(root, 'app')
    const gitDir = join(repo, '.git')
    await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true })
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`)

    send({ type: 'scanReposRequest', requestId: 'rr-1', roots: [root], includeHome: false })
    await waitFor(() => received.some((m) => m.type === 'scanReposResult'))

    const result = received.find(
      (m): m is Extract<DaemonMessage, { type: 'scanReposResult' }> => m.type === 'scanReposResult',
    )
    expect(result?.requestId).toBe('rr-1')
    expect(result?.repositories.map((r) => r.path)).toContain(repo)
    const found = result?.repositories.find((r) => r.path === repo)
    expect(found?.branch).toBe('main')
    expect(Array.isArray(found?.worktrees)).toBe(true)
  }, 10_000)

  it('processes control frames sent immediately after helloOk', async () => {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const root = await mkdtemp(join(tmpdir(), 'podium-immediate-control-'))
    await writeFile(join(root, 'file.txt'), 'ok\n')
    const received: DaemonMessage[] = []
    const malformedControlWarnings: unknown[][] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      if (String(args[0]).includes('dropped malformed inbound control frame')) {
        malformedControlWarnings.push(args)
      }
    })
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        let authed = false
        ws.on('message', (raw) => {
          if (!authed) {
            authed = true
            const ok: DaemonHandshakeReply = { type: 'helloOk', name: 'test' }
            ws.send(encode(ok))
            ws.send(
              encode({
                type: 'dirListRequest',
                requestId: 'dl-immediate',
                root,
                path: root,
              }),
            )
            r()
            return
          }
          received.push(parseDaemonMessage(raw.toString()))
        })
      })
    })
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      discovery: { background: false, cachePath: ':memory:' },
      metrics: { background: false },
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected
    try {
      const start = Date.now()
      while (!received.some((m) => m.type === 'dirListResult')) {
        if (Date.now() - start > 1000) throw new Error('dirListResult timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
    } finally {
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
      warnSpy.mockRestore()
    }
    expect(malformedControlWarnings).toEqual([])
    const result = received.find(
      (m): m is Extract<DaemonMessage, { type: 'dirListResult' }> => m.type === 'dirListResult',
    )
    expect(result).toMatchObject({
      requestId: 'dl-immediate',
      ok: true,
      path: root,
    })
    expect(result?.entries.some((e) => e.name === 'file.txt')).toBe(true)
  })

  it('scanReposRequest with no roots discovers repositories under HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-home-repos-'))
    const repo = join(home, 'src', 'app')
    const gitDir = join(repo, '.git')
    await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true })
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${'2'.repeat(40)}\n`)

    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      send({ type: 'scanReposRequest', requestId: 'rr-home', roots: [] })
      await waitFor(() =>
        received.some((m) => m.type === 'scanReposResult' && m.requestId === 'rr-home'),
      )
    } finally {
      process.env.HOME = prevHome
    }

    const result = received.find(
      (m): m is Extract<DaemonMessage, { type: 'scanReposResult' }> =>
        m.type === 'scanReposResult' && m.requestId === 'rr-home',
    )
    expect(result?.repositories.map((r) => r.path)).toContain(repo)
  })

  it('scanReposRequest includes HOME discovery alongside explicit roots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-home-plus-roots-'))
    const homeRepo = join(home, 'src', 'home-app')
    const extraRoot = await mkdtemp(join(tmpdir(), 'podium-extra-root-'))
    const extraRepo = join(extraRoot, 'extra-app')
    for (const repo of [homeRepo, extraRepo]) {
      const gitDir = join(repo, '.git')
      await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true })
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
      await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${'3'.repeat(40)}\n`)
    }

    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      send({ type: 'scanReposRequest', requestId: 'rr-home-plus-root', roots: [extraRoot] })
      await waitFor(() =>
        received.some((m) => m.type === 'scanReposResult' && m.requestId === 'rr-home-plus-root'),
      )
    } finally {
      process.env.HOME = prevHome
    }

    const result = received.find(
      (m): m is Extract<DaemonMessage, { type: 'scanReposResult' }> =>
        m.type === 'scanReposResult' && m.requestId === 'rr-home-plus-root',
    )
    expect(result?.repositories.map((r) => r.path).sort()).toEqual([extraRepo, homeRepo].sort())
  })

  it('scanReposRequest isolates a bad root: good repo returned, diagnostic for the bad one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-repos-ok-'))
    const repo = join(root, 'app')
    const gitDir = join(repo, '.git')
    await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true })
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`)
    const bad = join(root, 'does-not-exist')

    // includeHome:false keeps the scan scoped to these temp roots (this test is about
    // isolating a bad root, not about home inclusion) — fast and deterministic.
    send({ type: 'scanReposRequest', requestId: 'rr-2', roots: [bad, repo], includeHome: false })
    await waitFor(() =>
      received.some((m) => m.type === 'scanReposResult' && m.requestId === 'rr-2'),
    )

    const result = received.find(
      (m): m is Extract<DaemonMessage, { type: 'scanReposResult' }> =>
        m.type === 'scanReposResult' && m.requestId === 'rr-2',
    )
    expect(result?.repositories.map((r) => r.path)).toContain(repo)
    expect(result?.diagnostics.length ?? 0).toBeGreaterThan(0)
  })

  it('kill removes the per-session upload dir immediately', async () => {
    // Regression guard: kill already called removeSessionUploads. Ensure the dir
    // is gone after kill even when uploads were written to a custom HOME.
    const home = mkdtempSync(join(tmpdir(), 'podium-uploads-kill-'))
    const sessionId = 'upload-kill-s1'
    const uploadDir = join(home, '.podium', 'uploads', sessionId)
    mkdirSync(uploadDir, { recursive: true })
    writeFileSync(join(uploadDir, 'test.png'), 'data')

    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      send({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp', geometry: G })
      await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      expect(existsSync(uploadDir)).toBe(true)
      send({ type: 'kill', sessionId })
      await waitFor(() => !existsSync(uploadDir))
    } finally {
      process.env.HOME = prevHome
    }
  })

  it('natural agent exit (backend=none) removes the per-session upload dir', async () => {
    // Regression: removeSessionUploads was only called on `kill`, not on the natural
    // exit path inside wireBridge.onExit. A session that exits on its own left
    // ~/.podium/uploads/<sessionId>/ until the 24h hourly sweep.
    const home = mkdtempSync(join(tmpdir(), 'podium-uploads-exit-'))
    const sessionId = 'upload-exit-s1'
    const uploadDir = join(home, '.podium', 'uploads', sessionId)
    mkdirSync(uploadDir, { recursive: true })
    writeFileSync(join(uploadDir, 'test.png'), 'data')

    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      send({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp', geometry: G })
      await waitFor(() => fixtureFrame(sessionId) !== undefined)
      expect(existsSync(uploadDir)).toBe(true)
      // Send Ctrl-C to the fixture — it calls process.exit(0) on receiving \x03.
      send({ type: 'input', sessionId, data: btoa('\x03') })
      // With backend=none the master IS the process; when it exits the onExit fires
      // and (with the fix) removeSessionUploads is called before agentExit.
      await waitFor(() => received.some((m) => m.type === 'agentExit' && m.sessionId === sessionId))
      expect(existsSync(uploadDir)).toBe(false)
    } finally {
      process.env.HOME = prevHome
    }
  })
})

describe('durable backend resolution', () => {
  const both = { abduco: true, tmux: true }
  const neither = { abduco: false, tmux: false }

  it('prefers abduco, falls back to tmux, then none', () => {
    expect(resolveDurableBackend({}, both)).toBe('abduco')
    expect(resolveDurableBackend({}, { abduco: false, tmux: true })).toBe('tmux')
    expect(resolveDurableBackend({}, neither)).toBe('none')
  })

  it('an explicit backend wins (operator intent, even over availability probes)', () => {
    expect(resolveDurableBackend({ backend: 'tmux' }, both)).toBe('tmux')
    expect(resolveDurableBackend({ backend: 'none' }, both)).toBe('none')
    expect(resolveDurableBackend({ backend: 'abduco' }, neither)).toBe('abduco')
  })

  it('maps the legacy tmux boolean: true forces tmux, false forces none', () => {
    expect(resolveDurableBackend({ tmux: true }, both)).toBe('tmux')
    expect(resolveDurableBackend({ tmux: false }, both)).toBe('none')
  })

  it('explains a none-backend per platform: expected on Windows, missing tools elsewhere', () => {
    expect(noDurableBackendWarning('win32')).toContain('ConPTY')
    expect(noDurableBackendWarning('win32')).not.toContain('abduco')
    expect(noDurableBackendWarning('linux')).toContain('neither abduco nor tmux')
    // Both wordings must state the consequence the operator cares about.
    expect(noDurableBackendWarning('win32')).toContain('survive')
    expect(noDurableBackendWarning('linux')).toContain('survive')
  })
})

describe.skipIf(!isAbducoAvailable())('daemon abduco survival', () => {
  it('keeps the abduco session alive after the daemon closes, reattaches, and fails for a missing label', async () => {
    const sessionId = `ab-survive-${process.pid}`
    const label = `podium-${sessionId}`
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port

    const received: DaemonMessage[] = []
    let serverSocket!: WS
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        handshakeAndCollect(ws, received)
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      backend: 'abduco',
      discovery: { background: false, cachePath: ':memory:' },
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected

    const waitFor = async (fn: () => boolean, timeout = 5000): Promise<void> => {
      const startedAt = Date.now()
      while (!fn()) {
        if (Date.now() - startedAt > timeout) throw new Error('waitFor timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    const send = (msg: unknown): void => serverSocket.send(encode(msg as never))
    let daemonClosed = false

    try {
      send({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp', geometry: G })
      await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      expect(abducoHasSession(label)).toBe(true)

      // Simulate a backend restart re-binding: drop everything seen so far and re-attach.
      received.length = 0
      send({
        type: 'reattach',
        sessionId,
        durableLabel: label,
        agentKind: 'claude-code',
        cwd: '/tmp',
        geometry: G,
      })
      await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      // abduco does not replay history; the fixture repaints on the attach SIGWINCH,
      // so frames flow again from the re-attached client.
      await waitFor(() =>
        received.some(
          (m) =>
            m.type === 'agentFrameBatch' &&
            m.sessionId === sessionId &&
            m.frames.some((f) => decode(f).includes('PODIUM-FIXTURE')),
        ),
      )

      // A reattach for a label no backend knows → reattachFailed.
      const goneId = `ab-gone-${process.pid}`
      send({
        type: 'reattach',
        sessionId: goneId,
        durableLabel: `podium-${goneId}-missing`,
        agentKind: 'claude-code',
        cwd: '/tmp',
        geometry: G,
      })
      await waitFor(() =>
        received.some((m) => m.type === 'reattachFailed' && m.sessionId === goneId),
      )

      // Closing the daemon only kills the attach client — the session survives.
      daemonClosed = true
      await daemon.close()
      expect(abducoHasSession(label)).toBe(true)
    } finally {
      if (!daemonClosed) await daemon.close()
      killAbducoSession(label)
      await new Promise<void>((r) => wss.close(() => r()))
    }
  }, 20000)

  it('does NOT report agentExit when the attach client dies but the abduco master survives', async () => {
    // Regression: a backend restart (disposeAll), a user detach, or a client crash
    // all kill a session's abduco ATTACH CLIENT. The master + agent live on in
    // their own scope, so the daemon must stay silent — a stray agentExit makes
    // the relay persist a LIVE session as 'exited' and orphan the still-running
    // agent (boot never reattaches an 'exited' row). Only a vanished master is a
    // real exit. We reproduce the client death directly (SIGKILL the `abduco -a`
    // process) while the daemon's control channel stays open, so any wrongful
    // agentExit is observable.
    const sessionId = `ab-noexit-${process.pid}`
    const label = `podium-${sessionId}`
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port

    const received: DaemonMessage[] = []
    let serverSocket!: WS
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        handshakeAndCollect(ws, received)
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      backend: 'abduco',
      discovery: { background: false, cachePath: ':memory:' },
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected

    const send = (msg: unknown): void => serverSocket.send(encode(msg as never))
    const waitFor = async (fn: () => boolean, timeout = 5000): Promise<void> => {
      const startedAt = Date.now()
      while (!fn()) {
        if (Date.now() - startedAt > timeout) throw new Error('waitFor timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
    }

    try {
      send({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp', geometry: G })
      await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      expect(abducoHasSession(label)).toBe(true)
      received.length = 0

      // Kill ONLY the attach client, not the master (`abduco -n <label> …`). The
      // client is `abduco …-a <label>` once exec'd, or briefly `sh -c '…-a "$0"'
      // <label>` before that — so identify it as "matches the label but is not the
      // master." Its onExit fires while the daemon's control channel is open.
      const clientPids = execSync(`pgrep -af -- ${label} || true`)
        .toString()
        .trim()
        .split('\n')
        .filter(Boolean)
        // The client cmdline contains "abduco" (the `sh -c 'exec …abduco…'` form
        // before exec, the `abduco …-a <label>` form after). This excludes the
        // master (`abduco -n <label>`) and the ephemeral shell running pgrep,
        // whose argv carries the label but not "abduco".
        .filter((line) => line.includes('abduco') && !line.includes(`-n ${label}`))
        .map((line) => Number(line.split(/\s+/)[0]))
        .filter((p) => Number.isInteger(p) && p !== process.pid)
      expect(clientPids.length).toBeGreaterThan(0)
      for (const p of clientPids) {
        try {
          process.kill(p, 'SIGKILL')
        } catch {
          // already gone — fine
        }
      }

      // Give a generous window for a (wrongful) agentExit to arrive over the open
      // channel, then assert the master is still alive and the daemon stayed silent.
      await new Promise((r) => setTimeout(r, 1000))
      expect(abducoHasSession(label)).toBe(true)
      expect(received.some((m) => m.type === 'agentExit' && m.sessionId === sessionId)).toBe(false)
    } finally {
      killAbducoSession(label)
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  }, 20000)

  it('a fresh daemon seeds idle when it reattaches a survivor (not flagged working)', async () => {
    // Regression: after a daemon restart the server reattaches survivor sessions
    // into a FRESH daemon process. The reattach handler re-armed the tracker at
    // phase 'unknown' but never seeded state. An idle agent fires no hook, so the
    // phase stayed 'unknown', and the home board's fallback (unknown + live →
    // working) showed an idle session as active. Reattach must seed idle the same
    // way a fresh spawn does. Two daemons are essential: a single daemon's spawn
    // boot-probe would leak onto the re-armed tracker and mask the bug.
    const sessionId = `ab-restart-seed-${process.pid}`
    const label = `podium-${sessionId}`
    const settingsDir = mkdtempSync(join(tmpdir(), 'podium-hooks-'))
    const waitFor = async (fn: () => boolean, timeout = 5000): Promise<void> => {
      const startedAt = Date.now()
      while (!fn()) {
        if (Date.now() - startedAt > timeout) throw new Error('waitFor timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
    }

    // Each daemon connects to its own throwaway server; the abduco master survives
    // between them, exactly like a redeploy.
    const startServer = async (): Promise<{
      wss: WebSocketServer
      received: DaemonMessage[]
      send: (msg: unknown) => void
      ready: Promise<void>
    }> => {
      const wss = new WebSocketServer({ port: 0 })
      await new Promise<void>((r) => wss.once('listening', () => r()))
      const received: DaemonMessage[] = []
      let socket!: WS
      const ready = new Promise<void>((r) => {
        wss.once('connection', (ws) => {
          socket = ws
          handshakeAndCollect(ws, received)
          r()
        })
      })
      return { wss, received, ready, send: (msg) => socket.send(encode(msg as never)) }
    }
    const launch = (_kind: unknown, opts: { cwd: string }) => ({
      cmd: process.execPath,
      args: [FIXTURE],
      cwd: opts.cwd,
    })

    const a = await startServer()
    const daemonA = await startDaemon({
      serverUrl: `ws://localhost:${(a.wss.address() as { port: number }).port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir },
      backend: 'abduco',
      discovery: { background: false, cachePath: ':memory:' },
      launch,
    })
    await a.ready
    try {
      a.send({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp', geometry: G })
      await waitFor(() => a.received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      expect(abducoHasSession(label)).toBe(true)
    } finally {
      // Detach (do NOT reap) — the abduco master and its agent live on, idle.
      await daemonA.close()
      await new Promise<void>((r) => a.wss.close(() => r()))
    }
    expect(abducoHasSession(label)).toBe(true)

    // Fresh daemon process: no leftover spawn handler to seed the tracker.
    const b = await startServer()
    const daemonB = await startDaemon({
      serverUrl: `ws://localhost:${(b.wss.address() as { port: number }).port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir },
      backend: 'abduco',
      discovery: { background: false, cachePath: ':memory:' },
      launch,
    })
    await b.ready
    const idleStates = () =>
      b.received.filter(
        (m): m is Extract<DaemonMessage, { type: 'agentState' }> =>
          m.type === 'agentState' && m.sessionId === sessionId && m.state.phase === 'idle',
      )
    try {
      b.send({
        type: 'reattach',
        sessionId,
        durableLabel: label,
        agentKind: 'claude-code',
        cwd: '/tmp',
        geometry: G,
      })
      await waitFor(() => b.received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      // The fix: the reattaching daemon seeds a fresh idle state for the survivor.
      await waitFor(() => idleStates().length > 0)
      expect(idleStates().at(-1)?.state.idle).toBeUndefined() // bare idle — no verdict invented
    } finally {
      await daemonB.close()
      killAbducoSession(label)
      await new Promise<void>((r) => b.wss.close(() => r()))
    }
  }, 20000)

  it('a fresh daemon re-tails the resume transcript on reattach so chat history survives', async () => {
    // Regression: chat (structured transcript) showed empty for a survivor session
    // whose native PTY view was full of history. The reattach handler never
    // registered a transcript tail, and a fresh daemon's tails map is empty; an idle
    // agent fires no hook to lazily add one. Reattach must re-tail the live JSONL.
    const sessionId = `ab-retail-${process.pid}`
    const label = `podium-${sessionId}`
    const settingsDir = mkdtempSync(join(tmpdir(), 'podium-hooks-'))
    const resumeValue = 'conv-history-xyz'
    const cwd = '/tmp'
    // Seed the live transcript Claude would be writing, under a temp HOME.
    const home = await mkdtemp(join(tmpdir(), 'podium-home-'))
    const projDir = join(home, '.claude', 'projects', claudeProjectSlug(cwd))
    await mkdir(projDir, { recursive: true })
    await writeFile(
      join(projDir, `${resumeValue}.jsonl`),
      `${[
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-06-14T00:00:00.000Z',
          message: { role: 'user', content: 'fix mobile ui issues' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-06-14T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
        }),
      ].join('\n')}\n`,
    )
    const prevHome = process.env.HOME
    process.env.HOME = home

    const waitFor = async (fn: () => boolean, timeout = 5000): Promise<void> => {
      const startedAt = Date.now()
      while (!fn()) {
        if (Date.now() - startedAt > timeout) throw new Error('waitFor timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    const startServer = async (): Promise<{
      wss: WebSocketServer
      received: DaemonMessage[]
      send: (msg: unknown) => void
      ready: Promise<void>
    }> => {
      const wss = new WebSocketServer({ port: 0 })
      await new Promise<void>((r) => wss.once('listening', () => r()))
      const received: DaemonMessage[] = []
      let socket!: WS
      const ready = new Promise<void>((r) => {
        wss.once('connection', (ws) => {
          socket = ws
          handshakeAndCollect(ws, received)
          r()
        })
      })
      return { wss, received, ready, send: (msg) => socket.send(encode(msg as never)) }
    }
    const launch = (_kind: unknown, opts: { cwd: string }) => ({
      cmd: process.execPath,
      args: [FIXTURE],
      cwd: opts.cwd,
    })

    const a = await startServer()
    const daemonA = await startDaemon({
      serverUrl: `ws://localhost:${(a.wss.address() as { port: number }).port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir },
      backend: 'abduco',
      discovery: { background: false, cachePath: ':memory:' },
      launch,
    })
    await a.ready
    try {
      a.send({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd, geometry: G })
      await waitFor(() => a.received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      expect(abducoHasSession(label)).toBe(true)
    } finally {
      await daemonA.close()
      await new Promise<void>((r) => a.wss.close(() => r()))
    }

    const b = await startServer()
    const daemonB = await startDaemon({
      serverUrl: `ws://localhost:${(b.wss.address() as { port: number }).port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir },
      backend: 'abduco',
      discovery: { background: false, cachePath: ':memory:' },
      launch,
    })
    await b.ready
    const deltas = () =>
      b.received.filter(
        (m): m is Extract<DaemonMessage, { type: 'transcriptDelta' }> =>
          m.type === 'transcriptDelta' && m.sessionId === sessionId,
      )
    try {
      b.send({
        type: 'reattach',
        sessionId,
        durableLabel: label,
        agentKind: 'claude-code',
        cwd,
        geometry: G,
        resume: { kind: 'claude-session', value: resumeValue },
      })
      await waitFor(() => b.received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      // The fix: the reattaching daemon tails the seeded transcript and streams it
      // as a transcriptDelta (the unified cursor-based protocol).
      await waitFor(() => deltas().some((m) => m.items.length > 0))
      const items = deltas().flatMap((m) => m.items)
      expect(items.some((i) => i.role === 'user' && i.text.includes('fix mobile ui issues'))).toBe(
        true,
      )
      expect(items.some((i) => i.role === 'assistant')).toBe(true)
    } finally {
      await daemonB.close()
      killAbducoSession(label)
      await new Promise<void>((r) => b.wss.close(() => r()))
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
    }
  }, 20000)

  it('close({ reapSessions: true }) kills the durable sessions instead of detaching', async () => {
    const sessionId = `ab-reap-${process.pid}`
    const label = `podium-${sessionId}`
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port

    const received: DaemonMessage[] = []
    let serverSocket!: WS
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        handshakeAndCollect(ws, received)
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      backend: 'abduco',
      discovery: { background: false, cachePath: ':memory:' },
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected

    try {
      serverSocket.send(
        encode({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp', geometry: G }),
      )
      const start = Date.now()
      while (!received.some((m) => m.type === 'bind' && m.sessionId === sessionId)) {
        if (Date.now() - start > 5000) throw new Error('bind timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(abducoHasSession(label)).toBe(true)

      await daemon.close({ reapSessions: true })
      await new Promise((r) => setTimeout(r, 300))
      expect(abducoHasSession(label)).toBe(false)
    } finally {
      killAbducoSession(label)
      await new Promise<void>((r) => wss.close(() => r()))
    }
  }, 20000)
})

describe.skipIf(!isTmuxAvailable())('daemon tmux survival', () => {
  it('keeps the tmux session alive after the daemon closes', async () => {
    const sessionId = `survive-${process.pid}`
    const label = `podium-${sessionId}`
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port

    const received: DaemonMessage[] = []
    let serverSocket!: WS
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        handshakeAndCollect(ws, received)
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: true,
      discovery: { background: false, cachePath: ':memory:' },
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected

    try {
      serverSocket.send(
        encode({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp', geometry: G }),
      )
      // wait for the daemon to confirm it bound the session
      const start = Date.now()
      while (!received.some((m) => m.type === 'bind' && m.sessionId === sessionId)) {
        if (Date.now() - start > 5000) throw new Error('bind timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(tmuxHasSession(label)).toBe(true)

      // closing the daemon only detaches the tmux client — the agent server survives.
      await daemon.close()
      expect(tmuxHasSession(label)).toBe(true)
    } finally {
      killTmuxServer(label)
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })

  it('reattach re-binds to a live tmux session, and reports failure for a missing one', async () => {
    const sessionId = `reattach-${process.pid}`
    const label = `podium-${sessionId}`
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port

    const received: DaemonMessage[] = []
    let serverSocket!: WS
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        handshakeAndCollect(ws, received)
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: true,
      discovery: { background: false, cachePath: ':memory:' },
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected

    const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8')
    const waitFor = async (fn: () => boolean, timeout = 5000): Promise<void> => {
      const startedAt = Date.now()
      while (!fn()) {
        if (Date.now() - startedAt > timeout) throw new Error('waitFor timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    const send = (msg: unknown): void => serverSocket.send(encode(msg as never))

    try {
      // Spawn a session so a real podium-<id> tmux server exists.
      send({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp', geometry: G })
      await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      expect(tmuxHasSession(label)).toBe(true)

      // Simulate a backend restart re-binding: drop everything seen so far and re-attach.
      received.length = 0
      send({
        type: 'reattach',
        sessionId,
        durableLabel: label,
        agentKind: 'claude-code',
        cwd: '/tmp',
        geometry: G,
      })
      // The daemon re-binds: it replies with a fresh `bind` for this sessionId...
      await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === sessionId))
      // ...and frames flow again from the re-attached tmux client.
      await waitFor(() =>
        received.some(
          (m) =>
            m.type === 'agentFrameBatch' &&
            m.sessionId === sessionId &&
            m.frames.some((f) => decode(f).includes('PODIUM-FIXTURE')),
        ),
      )

      // A reattach for a label that has no live tmux session → reattachFailed.
      const goneId = `gone-${process.pid}`
      send({
        type: 'reattach',
        sessionId: goneId,
        durableLabel: `podium-${goneId}-missing`,
        agentKind: 'claude-code',
        cwd: '/tmp',
        geometry: G,
      })
      await waitFor(() =>
        received.some((m) => m.type === 'reattachFailed' && m.sessionId === goneId),
      )
    } finally {
      await daemon.close()
      killTmuxServer(label)
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })
})

describe('daemon conversation discovery', () => {
  it('background quick scan pushes the worker delta as conversationsChanged', async () => {
    // The periodic scan runs on the worker and emits a delta; conversationsChanged
    // now carries `conversations`=changed + `removed`. A fake worker client supplies
    // the delta (Node vitest can't spawn the real `.ts` worker that owns discovery.db).
    const changed: ConversationSummaryWire[] = [
      {
        id: 'sess-bg',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        title: 'Cached session',
      },
    ]
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const received: DaemonMessage[] = []
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        handshakeAndCollect(ws, received)
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
      workerClient: fakeDeltaWorkerClient({ changed, removed: ['sess-old'], diagnostics: [] }),
      discovery: { cachePath: ':memory:', scanIntervalMs: 20 },
    })
    await connected

    try {
      const start = Date.now()
      while (
        !received.some(
          (m) =>
            m.type === 'conversationsChanged' &&
            m.conversations.some((conversation) => conversation.id === 'sess-bg'),
        )
      ) {
        if (Date.now() - start > 5000) throw new Error('conversationsChanged timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
      const delta = received.find(
        (m): m is Extract<DaemonMessage, { type: 'conversationsChanged' }> =>
          m.type === 'conversationsChanged',
      )
      // The broadcast carries the delta — changed in `conversations`, pruned ids in `removed`.
      expect(delta?.removed).toEqual(['sess-old'])
    } finally {
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })

  it('an all-empty worker delta produces NO conversationsChanged broadcast', async () => {
    // The common case every 15s: nothing moved. An empty delta must not fan a
    // pointless conversationsChanged frame out to every client.
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const received: DaemonMessage[] = []
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        handshakeAndCollect(ws, received)
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
      metrics: { background: false },
      workerClient: fakeDeltaWorkerClient({ changed: [], removed: [], diagnostics: [] }),
      discovery: { cachePath: ':memory:', scanIntervalMs: 20 },
    })
    await connected

    try {
      // Let several scan ticks fire (interval 20ms); each returns an empty delta.
      await new Promise((r) => setTimeout(r, 200))
      expect(received.some((m) => m.type === 'conversationsChanged')).toBe(false)
    } finally {
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })

  it('connect-time kickoff requests a FULL snapshot; periodic ticks request a delta', async () => {
    // Regression guard for the cold-server-index bug: the connect-time scan MUST
    // request a full snapshot (full: true) so a fresh/reset server index gets
    // repopulated even off a warm discovery cache. The periodic loop must keep
    // requesting deltas (full falsy) so it doesn't re-broadcast the whole list every
    // tick. We record the `full` flag of each indexRefresh job to prove both.
    const changed: ConversationSummaryWire[] = [
      {
        id: 'sess-full',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        title: 'Snapshot session',
      },
    ]
    const { client, fullFlags } = recordingDeltaWorkerClient({
      changed,
      removed: [],
      diagnostics: [],
    })
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const received: DaemonMessage[] = []
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        handshakeAndCollect(ws, received)
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
      metrics: { background: false },
      workerClient: client,
      discovery: { cachePath: ':memory:', scanIntervalMs: 20 },
    })
    await connected

    try {
      // Wait for the connect-time scan to land its full-list conversationsChanged.
      const start = Date.now()
      while (
        !received.some(
          (m) =>
            m.type === 'conversationsChanged' && m.conversations.some((c) => c.id === 'sess-full'),
        )
      ) {
        if (Date.now() - start > 5000) throw new Error('connect-time snapshot timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
      // Let several periodic ticks fire after the connect-time kickoff.
      await new Promise((r) => setTimeout(r, 120))
    } finally {
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }

    // The very first indexRefresh (connect-time) requested a full snapshot.
    expect(fullFlags[0]).toBe(true)
    // Periodic ticks that followed requested deltas (full falsy), never another full.
    expect(fullFlags.length).toBeGreaterThan(1)
    expect(fullFlags.slice(1).every((f) => !f)).toBe(true)
  })

  it('on-demand scanRequest requests a FULL snapshot (cold-index recovery)', async () => {
    // A user-triggered rescan must be able to recover a cold/reset server index, so
    // the on-demand path also requests full: true (not just whatever moved).
    const changed: ConversationSummaryWire[] = [
      {
        id: 'sess-ondemand',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        title: 'On-demand session',
      },
    ]
    const { client, fullFlags } = recordingDeltaWorkerClient({
      changed,
      removed: [],
      diagnostics: [],
    })
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const received: DaemonMessage[] = []
    let serverWs: WS | undefined
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverWs = ws
        handshakeAndCollect(ws, received)
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
      metrics: { background: false },
      // No background loop, so the ONLY indexRefresh job is the on-demand scan.
      discovery: { background: false, cachePath: ':memory:' },
      workerClient: client,
    })
    await connected

    try {
      serverWs?.send(encode({ type: 'scanRequest', requestId: 'req-full' } as never))
      const start = Date.now()
      while (!received.some((m) => m.type === 'scanResult')) {
        if (Date.now() - start > 5000) throw new Error('scanResult timed out')
        await new Promise((r) => setTimeout(r, 20))
      }
    } finally {
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }

    expect(fullFlags).toEqual([true])
  })
})

describe('daemon host metrics', () => {
  it('pushes hostMetrics immediately on connect and again on the interval', async () => {
    const received: DaemonMessage[] = []
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    wss.on('connection', (ws) => {
      handshakeAndCollect(ws, received)
    })
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      discovery: { background: false, cachePath: ':memory:' },
      metrics: { intervalMs: 25 },
    })
    try {
      const metrics = () =>
        received.filter((m): m is Extract<DaemonMessage, { type: 'hostMetrics' }> => {
          return m.type === 'hostMetrics'
        })
      const start = Date.now()
      while (metrics().length < 2) {
        if (Date.now() - start > 5000) throw new Error('timed out waiting for hostMetrics')
        await new Promise((r) => setTimeout(r, 10))
      }
      const m = metrics()[0]
      expect(m?.hostname.length).toBeGreaterThan(0)
      expect(m?.memory.totalBytes).toBeGreaterThan(0)
      expect(m?.memory.availableBytes).toBeLessThanOrEqual(m?.memory.totalBytes ?? 0)
      expect(Number.isNaN(Date.parse(m?.sampledAt ?? ''))).toBe(false)
    } finally {
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })

  it('stays silent when metrics.background is false', async () => {
    const received: DaemonMessage[] = []
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    wss.on('connection', (ws) => {
      handshakeAndCollect(ws, received)
    })
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      discovery: { background: false, cachePath: ':memory:' },
      metrics: { background: false, intervalMs: 10 },
    })
    try {
      await new Promise((r) => setTimeout(r, 80))
      expect(received.filter((m) => m.type === 'hostMetrics')).toEqual([])
    } finally {
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })
})

describe('daemon memory breakdown', () => {
  it.runIf(process.platform === 'linux')(
    'attributes a live session by its process tree and answers the request',
    async () => {
      const received: DaemonMessage[] = []
      const wss = new WebSocketServer({ port: 0 })
      await new Promise<void>((r) => wss.once('listening', () => r()))
      const port = (wss.address() as { port: number }).port
      let serverWs: WS | undefined
      wss.on('connection', (ws) => {
        serverWs = ws
        handshakeAndCollect(ws, received)
      })
      const daemon = await startDaemon({
        serverUrl: `ws://localhost:${port}`,
        bootstrapToken: 'test',
        hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
        tmux: false,
        discovery: { background: false, cachePath: ':memory:' },
        metrics: { background: false },
        workerClient: inlineWorkerClient(),
        launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
      })
      try {
        const waitFor = async (fn: () => boolean): Promise<void> => {
          const start = Date.now()
          while (!fn()) {
            if (Date.now() - start > 5000) throw new Error('waitFor timed out')
            await new Promise((r) => setTimeout(r, 20))
          }
        }
        serverWs?.send(
          encode({
            type: 'spawn',
            sessionId: 'sb1',
            agentKind: 'claude-code',
            cwd: '/tmp',
            geometry: G,
          }),
        )
        await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sb1'))
        serverWs?.send(encode({ type: 'memoryBreakdownRequest', requestId: 'mb1', roots: [] }))
        await waitFor(() => received.some((m) => m.type === 'memoryBreakdownResult'))
        const result = received.find(
          (m): m is Extract<DaemonMessage, { type: 'memoryBreakdownResult' }> =>
            m.type === 'memoryBreakdownResult',
        )
        expect(result?.requestId).toBe('mb1')
        expect(result?.supported).toBe(true)
        const agent = result?.agents.find((a) => a.sessionId === 'sb1')
        expect(agent?.bytes).toBeGreaterThan(0)
        expect(agent?.processCount).toBeGreaterThan(0)
        expect(result?.otherBytes).toBeGreaterThan(0)
      } finally {
        await daemon.close()
        await new Promise<void>((r) => wss.close(() => r()))
      }
    },
  )
})

describe('agent state instrumentation', () => {
  let wss: WebSocketServer
  let serverSocket: WS
  let received: DaemonMessage[]
  let daemon: DaemonHandle
  let settingsDir: string

  beforeEach(async () => {
    received = []
    settingsDir = await mkdtemp(join(tmpdir(), 'podium-hooks-'))
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        handshakeAndCollect(ws, received)
        r()
      })
    })
    daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      bootstrapToken: 'test',
      tmux: false,
      discovery: { background: false, cachePath: ':memory:' },
      metrics: { background: false },
      hooks: { port: 0, settingsDir },
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected
  })

  afterEach(async () => {
    await daemon.close()
    await new Promise<void>((r) => wss.close(() => r()))
  })

  const send = (msg: unknown): void => serverSocket.send(encode(msg as never))
  async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeout) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const states = () =>
    received.filter(
      (m): m is Extract<DaemonMessage, { type: 'agentState' }> => m.type === 'agentState',
    )

  it('writes the hook settings file and appends --settings for claude-code spawns', async () => {
    send({ type: 'spawn', sessionId: 'sA', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sA'))
    const settingsPath = join(settingsDir, 'sA.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; url: string }[] }[]>
    }
    const url = settings.hooks.Stop?.[0]?.hooks[0]?.url ?? ''
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${daemon.hookPort}/hooks/sA$`))
  })

  it('seedCliTheme rides the spawn into the settings file: absent/true seed theme:auto, false leaves the user theme alone [spec:SP-a04d]', async () => {
    const themeOf = async (sessionId: string): Promise<string | undefined> => {
      const raw = await readFile(join(settingsDir, `${sessionId}.json`), 'utf8')
      return (JSON.parse(raw) as { theme?: string }).theme
    }
    send({ type: 'spawn', sessionId: 'sT1', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sT1'))
    expect(await themeOf('sT1')).toBe('auto') // absent = the default (on)
    send({
      type: 'spawn',
      sessionId: 'sT2',
      agentKind: 'claude-code',
      cwd: '/tmp',
      geometry: G,
      seedCliTheme: false,
    })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sT2'))
    expect(await themeOf('sT2')).toBeUndefined() // opt-out: no theme key at all
  })

  it('does not instrument shell sessions', async () => {
    send({ type: 'spawn', sessionId: 'sh1', agentKind: 'shell', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sh1'))
    await expect(readFile(join(settingsDir, 'sh1.json'), 'utf8')).rejects.toThrow()
  })

  it('hook POSTs flow through translate+reduce and out as agentState messages', async () => {
    send({ type: 'spawn', sessionId: 'sB', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sB'))
    const post = (payload: unknown) =>
      fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/sB`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await waitFor(() => states().some((s) => s.sessionId === 'sB' && s.state.phase === 'working'))
    await post({ hook_event_name: 'StopFailure', error_type: 'rate_limit' })
    await waitFor(() => states().some((s) => s.state.phase === 'errored'))
    const errored = states().find((s) => s.state.phase === 'errored')
    expect(errored?.state.error).toEqual({ class: 'rate_limit', retryable: true })
    // True no-ops are deduped by reducer reference identity: working → working
    // emits nothing. (Re-entries like a repeated StopFailure DO re-broadcast,
    // because they stamp a new `since` — that's intended.)
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }) // errored → working
    await waitFor(() => states().at(-1)?.state.phase === 'working')
    const count = states().length
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }) // working → working: no-op
    await new Promise((r) => setTimeout(r, 50))
    expect(states().length).toBe(count)
  })

  it('boot: a spawned claude-code session reports idle once frames flow, with no hook POST', async () => {
    send({ type: 'spawn', sessionId: 'sBoot', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => states().some((m) => m.sessionId === 'sBoot' && m.state.phase === 'idle'))
    const idle = states().find((m) => m.sessionId === 'sBoot')
    expect(idle?.state.idle).toBeUndefined() // bare boot idle — no verdict invented
  })

  it('boot events never override state already set by a real hook', async () => {
    send({ type: 'spawn', sessionId: 'sFast', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sFast'))
    // A real hook lands before the boot probe applies (fast typist / quick harness)
    await fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/sFast`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
    })
    await waitFor(() =>
      states().some((m) => m.sessionId === 'sFast' && m.state.phase === 'working'),
    )
    await new Promise((r) => setTimeout(r, 150)) // give the boot path time to (not) fire
    const last = states()
      .filter((m) => m.sessionId === 'sFast')
      .at(-1)
    expect(last?.state.phase).toBe('working')
  })

  it('hook POSTs for unknown sessions are ignored', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/nope`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(states().filter((s) => s.sessionId === 'nope')).toEqual([])
  })
})

describe('createLimiter (reattach spawn gate)', () => {
  it('never runs more than `max` tasks at once and still completes them all', async () => {
    const limit = createLimiter(3)
    let active = 0
    let peak = 0
    const done: number[] = []
    const task = (i: number) =>
      limit(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        done.push(i)
      })
    await Promise.all(Array.from({ length: 12 }, (_, i) => task(i)))
    expect(peak).toBeLessThanOrEqual(3)
    expect(done.length).toBe(12)
    expect(active).toBe(0)
  })

  it('propagates a thunk rejection without wedging the queue', async () => {
    const limit = createLimiter(2)
    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    // A failure must release its slot so later work still runs.
    await expect(limit(() => Promise.resolve('ok'))).resolves.toBe('ok')
  })
})

describe('controlFrameByteLength', () => {
  it('measures a Buffer frame', () => {
    expect(controlFrameByteLength(Buffer.from('hello'))).toBe(5)
  })

  it('sums a fragmented (Buffer[]) frame', () => {
    expect(controlFrameByteLength([Buffer.from('ab'), Buffer.from('cde')])).toBe(5)
  })

  it('measures an ArrayBuffer frame', () => {
    expect(controlFrameByteLength(new ArrayBuffer(7))).toBe(7)
  })
})

describe('normalizeAgentKind', () => {
  it('maps each resume.kind to its true harness', () => {
    expect(normalizeAgentKind('shell', 'opencode-session')).toBe('opencode')
    expect(normalizeAgentKind('shell', 'grok-session')).toBe('grok')
    expect(normalizeAgentKind('shell', 'codex-thread')).toBe('codex')
    expect(normalizeAgentKind('shell', 'cursor-chat')).toBe('cursor')
    // Registry-backed (#249): claude-session maps too — a mis-stamped
    // agentKind can no longer hide a claude conversation from reads.
    expect(normalizeAgentKind('shell', 'claude-session')).toBe('claude-code')
  })

  it('falls back to agentKind when the resume kind is absent or unknown', () => {
    expect(normalizeAgentKind('claude-code')).toBe('claude-code')
    expect(normalizeAgentKind('claude-code', 'claude-session')).toBe('claude-code')
    expect(normalizeAgentKind('codex', 'something-else')).toBe('codex')
  })
})

// ---------------------------------------------------------------------------
// Task D: unified cursor-based transcript reads + live deltas. A throwaway
// server + daemon with an isolated discovery.homeDir so the read source resolves
// seeded fixtures (no real ~/.claude / ~/.local opencode store).
// ---------------------------------------------------------------------------
describe('daemon transcript read + delta (cursor protocol)', () => {
  type TestServer = {
    wss: WebSocketServer
    received: DaemonMessage[]
    send: (msg: unknown) => void
    ready: Promise<void>
  }
  const servers: TestServer[] = []
  const daemons: DaemonHandle[] = []

  const startServer = async (): Promise<TestServer> => {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const received: DaemonMessage[] = []
    let socket!: WS
    const ready = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        socket = ws
        // The daemon authenticates first (hello → helloOk) before any control frames;
        // reply to the handshake, then collect every subsequent DaemonMessage.
        handshakeAndCollect(ws, received)
        r()
      })
    })
    const srv: TestServer = {
      wss,
      received,
      ready,
      send: (msg) => socket.send(encode(msg as never)),
    }
    servers.push(srv)
    return srv
  }

  const startTestDaemon = async (server: TestServer, homeDir: string): Promise<DaemonHandle> => {
    const d = await startDaemon({
      serverUrl: `ws://localhost:${(server.wss.address() as { port: number }).port}`,
      bootstrapToken: 'test',
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      discovery: { background: false, cachePath: ':memory:', homeDir },
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    daemons.push(d)
    return d
  }

  const waitFor = async (fn: () => boolean, timeout = 5000): Promise<void> => {
    const startedAt = Date.now()
    while (!fn()) {
      if (Date.now() - startedAt > timeout) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  // Seed a claude cwd-bucket transcript under `home` and return its resume value.
  const seedClaudeTranscript = async (
    home: string,
    cwd: string,
    resumeValue: string,
    texts: string[],
  ): Promise<void> => {
    const projDir = join(home, '.claude', 'projects', claudeProjectSlug(cwd))
    await mkdir(projDir, { recursive: true })
    const lines = texts.map((text, i) =>
      JSON.stringify({
        type: 'user',
        uuid: `u${i}`,
        timestamp: `2026-06-14T00:00:0${i}.000Z`,
        message: { role: 'user', content: text },
      }),
    )
    await writeFile(join(projDir, `${resumeValue}.jsonl`), `${lines.join('\n')}\n`)
  }

  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.close()
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.wss.close(() => r()))
  })

  it('serves a claude transcriptRead: newest window (no anchor), cursor-stamped, then pages older', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-trx-home-'))
    const cwd = '/work/repo'
    const resumeValue = 'conv-read-1'
    await seedClaudeTranscript(home, cwd, resumeValue, ['m0', 'm1', 'm2', 'm3', 'm4'])

    const srv = await startServer()
    await startTestDaemon(srv, home)
    await srv.ready

    const results = () =>
      srv.received.filter(
        (m): m is Extract<DaemonMessage, { type: 'transcriptReadResult' }> =>
          m.type === 'transcriptReadResult',
      )

    // No anchor + before → newest window of 3.
    srv.send({
      type: 'transcriptRead',
      requestId: 'r-newest',
      sessionId: 's-read',
      agentKind: 'claude-code',
      cwd,
      resume: { kind: 'claude-session', value: resumeValue },
      direction: 'before',
      limit: 3,
    })
    await waitFor(() => results().some((m) => m.requestId === 'r-newest'))
    const newest = results().find((m) => m.requestId === 'r-newest')
    expect(newest?.items.map((i) => i.text)).toEqual(['m2', 'm3', 'm4'])
    expect(newest?.hasMore).toBe(true)
    // Every served item carries a cursor (interoperates with live deltas).
    expect(newest?.items.every((i) => typeof i.cursor === 'string' && i.cursor.length > 0)).toBe(
      true,
    )
    expect(newest?.head).toBe(newest?.items[0]?.cursor)
    expect(newest?.tail).toBe(newest?.items.at(-1)?.cursor)

    // Page older: anchor on the head of the newest window, before → m0,m1 (head reached).
    srv.send({
      type: 'transcriptRead',
      requestId: 'r-older',
      sessionId: 's-read',
      agentKind: 'claude-code',
      cwd,
      resume: { kind: 'claude-session', value: resumeValue },
      anchor: newest?.head,
      direction: 'before',
      limit: 3,
    })
    await waitFor(() => results().some((m) => m.requestId === 'r-older'))
    const older = results().find((m) => m.requestId === 'r-older')
    expect(older?.items.map((i) => i.text)).toEqual(['m0', 'm1'])
    expect(older?.hasMore).toBe(false)
  })

  it('serves an opencode transcriptRead from the DB store', async () => {
    let DatabaseSync: (new (path: string) => OpencodeTestDb) | undefined
    try {
      DatabaseSync = (await import('node:sqlite')).DatabaseSync as unknown as new (
        path: string,
      ) => OpencodeTestDb
    } catch {
      return // node:sqlite unavailable in this runtime — skip
    }
    const home = await mkdtemp(join(tmpdir(), 'podium-trx-oc-home-'))
    const sid = 'oc-ses-read'
    seedOpencodeDb(DatabaseSync, home, sid, ['o0', 'o1', 'o2'])

    const srv = await startServer()
    await startTestDaemon(srv, home)
    await srv.ready

    srv.send({
      type: 'transcriptRead',
      requestId: 'r-oc',
      sessionId: 's-oc',
      agentKind: 'opencode',
      cwd: '/repo/oc',
      resume: { kind: 'opencode-session', value: sid },
      direction: 'before',
      limit: 10,
    })
    await waitFor(() =>
      srv.received.some((m) => m.type === 'transcriptReadResult' && m.requestId === 'r-oc'),
    )
    const res = srv.received.find(
      (m): m is Extract<DaemonMessage, { type: 'transcriptReadResult' }> =>
        m.type === 'transcriptReadResult' && m.requestId === 'r-oc',
    )
    expect(res?.items.map((i) => i.text)).toEqual(['o0', 'o1', 'o2'])
    expect(res?.items.every((i) => i.cursor?.startsWith('') ?? false)).toBe(true)
  })

  it('a live claude file tail emits transcriptDelta (with a tail cursor), not transcriptAppend', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-trx-tail-home-'))
    const cwd = home // real cwd so the spawn stays alive while the tail polls
    const resumeValue = 'conv-tail-1'
    await seedClaudeTranscript(home, cwd, resumeValue, ['hello tail'])

    const srv = await startServer()
    await startTestDaemon(srv, home)
    await srv.ready

    const deltas = () =>
      srv.received.filter(
        (m): m is Extract<DaemonMessage, { type: 'transcriptDelta' }> =>
          m.type === 'transcriptDelta' && m.sessionId === 's-tail',
      )

    srv.send({
      type: 'spawn',
      sessionId: 's-tail',
      agentKind: 'claude-code',
      cwd,
      resume: { kind: 'claude-session', value: resumeValue },
      geometry: G,
    })
    await waitFor(() => deltas().some((m) => m.items.length > 0))
    const d = deltas().find((m) => m.items.length > 0)
    expect(d?.items.some((i) => i.text.includes('hello tail'))).toBe(true)
    // The first emission is a reset seed, and it carries the tail cursor.
    expect(deltas().some((m) => m.reset === true)).toBe(true)
    expect(d?.tail).toBe(d?.items.at(-1)?.cursor)
    // No retired transcriptAppend is ever emitted.
    expect(srv.received.some((m) => (m as { type: string }).type === 'transcriptAppend')).toBe(
      false,
    )
  })

  it('re-seeds the transcript on an already-held-bridge reattach (transcriptDelta reset)', async () => {
    // A reattach for a session whose bridge the daemon already holds (server
    // restarted, daemon survived). The early branch must re-seed chat from disk so
    // the freshly-restarted server's empty buffer repopulates.
    const home = await mkdtemp(join(tmpdir(), 'podium-trx-reseed-home-'))
    // A REAL cwd so the spawned bridge actually starts and stays held in memory.
    const cwd = home
    const resumeValue = 'conv-reseed-1'
    const sessionId = 's-reseed'

    const srv = await startServer()
    await startTestDaemon(srv, home)
    await srv.ready

    // Spawn WITHOUT a resume so the live claude tail does a one-shot bucket scan
    // (empty now) and starts NO polling tail — the only path that can re-seed the
    // file we add next is the already-held-bridge reattach branch under test.
    srv.send({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd, geometry: G })
    await waitFor(() => srv.received.some((m) => m.type === 'bind' && m.sessionId === sessionId))

    // Now the transcript exists on disk; a reattach must re-seed it.
    await seedClaudeTranscript(home, cwd, resumeValue, ['re-seeded line a', 're-seeded line b'])

    srv.send({
      type: 'reattach',
      sessionId,
      durableLabel: `podium-${sessionId}`,
      agentKind: 'claude-code',
      cwd,
      geometry: G,
      resume: { kind: 'claude-session', value: resumeValue },
    })

    const resetDeltas = () =>
      srv.received.filter(
        (m): m is Extract<DaemonMessage, { type: 'transcriptDelta' }> =>
          m.type === 'transcriptDelta' &&
          m.sessionId === sessionId &&
          m.reset === true &&
          m.items.some((i) => i.text.includes('re-seeded line')),
      )
    await waitFor(() => resetDeltas().length > 0)
    const seed = resetDeltas().at(-1)
    expect(seed?.items.map((i) => i.text)).toEqual(['re-seeded line a', 're-seeded line b'])
    expect(seed?.tail).toBe(seed?.items.at(-1)?.cursor)
  })

  it('does NOT tail a sibling bucket file for a claude spawn with no resume (waits for the hook)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-trx-noresume-home-'))
    const cwd = home // real cwd so the spawn stays alive
    // A DIFFERENT conversation exists in the same cwd bucket. A no-resume spawn must
    // NOT pick it up — guessing the newest sibling file merged unrelated conversations
    // (the regression). The tail must wait for the hook's authoritative transcript_path.
    await seedClaudeTranscript(home, cwd, 'sibling-conv', ['a DIFFERENT conversation'])

    const srv = await startServer()
    await startTestDaemon(srv, home)
    await srv.ready

    const deltas = () =>
      srv.received.filter(
        (m): m is Extract<DaemonMessage, { type: 'transcriptDelta' }> =>
          m.type === 'transcriptDelta' && m.sessionId === 's-noresume',
      )

    srv.send({
      type: 'spawn',
      sessionId: 's-noresume',
      agentKind: 'claude-code',
      cwd,
      geometry: G,
    })
    // Wait well past the tail poll interval so a (wrong) sibling tail would have fired.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(
      deltas()
        .flatMap((m) => m.items)
        .some((i) => i.text.includes('a DIFFERENT conversation')),
    ).toBe(false)
  })
})

// Minimal node:sqlite shape for seeding an opencode store in tests.
type OpencodeTestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): unknown }
  close(): void
}

/** Seed a temp opencode store under `home` with one session + N text parts. */
function seedOpencodeDb(
  DatabaseSync: new (path: string) => OpencodeTestDb,
  home: string,
  sessionId: string,
  texts: string[],
): void {
  const root = join(home, '.local', 'share', 'opencode')
  mkdirSync(root, { recursive: true })
  const db = new DatabaseSync(join(root, 'opencode.db'))
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'proj',
      parent_id TEXT, slug TEXT NOT NULL DEFAULT 'slug', directory TEXT NOT NULL,
      title TEXT NOT NULL, version TEXT NOT NULL DEFAULT '1', share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, revert TEXT, permission TEXT, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER,
      workspace_id TEXT, path TEXT, agent TEXT, model TEXT, cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0, metadata TEXT)`,
  )
  db.exec(
    `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`,
  )
  db.exec(
    `CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`,
  )
  db.prepare(
    `INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, '/repo/oc', 't', 1, 2)
  const insMsg = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  )
  const insPart = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  texts.forEach((text, i) => {
    const t = 100 + i
    insMsg.run(`msg-${i}`, sessionId, t, t, JSON.stringify({ role: 'user' }))
    insPart.run(`prt-${i}`, `msg-${i}`, sessionId, t, t, JSON.stringify({ type: 'text', text }))
  })
  db.close()
}
