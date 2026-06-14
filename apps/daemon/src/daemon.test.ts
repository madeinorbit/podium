import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
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
import { type DaemonMessage, encode, parseDaemonMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import { type DaemonHandle, resolveDurableBackend, startDaemon } from './daemon'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)
const G = { cols: 80, rows: 24 }
const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8')
type AgentFrame = Extract<DaemonMessage, { type: 'agentFrame' }>

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
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })
    daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
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
  const frames = (): AgentFrame[] =>
    received.filter((m): m is AgentFrame => m.type === 'agentFrame')
  const fixtureFrame = (sid: string): AgentFrame | undefined =>
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

  it('scanRequest maps a discovered conversation to a wire-valid scanResult', async () => {
    // Isolate HOME to a temp dir seeded with one minimal claude conversation: fast +
    // deterministic (vs the dev's real ~/.claude, which can be thousands of files), and it
    // actually exercises summaryToWire. parseDaemonMessage (beforeEach) schema-validates
    // every received message, so a Date leak or a dropped providerId would fail at parse.
    const home = await mkdtemp(join(tmpdir(), 'podium-scan-'))
    const projDir = join(home, '.claude', 'projects', 'proj')
    await mkdir(projDir, { recursive: true })
    await writeFile(
      join(projDir, 'sess.jsonl'),
      `${[
        JSON.stringify({
          sessionId: 'sess-9',
          cwd: '/home/proj',
          timestamp: '2026-06-01T00:00:00.000Z',
          message: { role: 'user', content: 'hi' },
        }),
        JSON.stringify({
          timestamp: '2026-06-01T00:01:00.000Z',
          message: { role: 'assistant', content: 'yo' },
        }),
      ].join('\n')}\n`,
    )
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      send({ type: 'scanRequest', requestId: 'req-1' })
      await waitFor(() => received.some((m) => m.type === 'scanResult'))
    } finally {
      process.env.HOME = prevHome
    }
    const result = received.find(
      (m): m is Extract<DaemonMessage, { type: 'scanResult' }> => m.type === 'scanResult',
    )
    expect(result?.requestId).toBe('req-1')
    const conv = result?.conversations.find((c) => c.id === 'sess-9')
    expect(conv).toMatchObject({
      agentKind: 'claude-code',
      providerId: 'claude-code-jsonl',
      resume: { kind: 'claude-session', value: 'sess-9' },
    })
    expect(typeof conv?.createdAt).toBe('string') // Date → ISO string (mapper exercised)
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
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
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
            m.type === 'agentFrame' &&
            m.sessionId === sessionId &&
            decode(m.data).includes('PODIUM-FIXTURE'),
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
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
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
          ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
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
          ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
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
      hooks: { port: 0, settingsDir },
      backend: 'abduco',
      discovery: { background: false, cachePath: ':memory:' },
      launch,
    })
    await b.ready
    const appends = () =>
      b.received.filter(
        (m): m is Extract<DaemonMessage, { type: 'transcriptAppend' }> =>
          m.type === 'transcriptAppend' && m.sessionId === sessionId,
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
      // The fix: the reattaching daemon tails the seeded transcript and streams it.
      await waitFor(() => appends().some((m) => m.items.length > 0))
      const items = appends().flatMap((m) => m.items)
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
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
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
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
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
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
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
            m.type === 'agentFrame' &&
            m.sessionId === sessionId &&
            decode(m.data).includes('PODIUM-FIXTURE'),
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
  it('background quick scan pushes conversationsChanged', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-discovery-home-'))
    const projDir = join(home, '.claude', 'projects', 'proj')
    await mkdir(projDir, { recursive: true })
    await writeFile(
      join(projDir, 'sess.jsonl'),
      `${[
        JSON.stringify({ type: 'summary', customTitle: 'Cached session', sessionId: 'sess-bg' }),
        JSON.stringify({
          sessionId: 'sess-bg',
          cwd: '/home/proj',
          timestamp: '2026-06-01T00:00:00.000Z',
          message: { role: 'user', content: 'hi' },
        }),
      ].join('\n')}\n`,
    )

    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const received: DaemonMessage[] = []
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
      tmux: false,
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
      discovery: {
        cachePath: join(home, 'discovery.db'),
        homeDir: home,
        scanIntervalMs: 20,
      },
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
    } finally {
      await daemon.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })
})

describe('daemon host metrics', () => {
  it('pushes hostMetrics immediately on connect and again on the interval', async () => {
    const received: DaemonMessage[] = []
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
    })
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
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
      ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
    })
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
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
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
      })
      const daemon = await startDaemon({
        serverUrl: `ws://localhost:${port}`,
        hooks: { port: 0, settingsDir: mkdtempSync(join(tmpdir(), 'podium-hooks-')) },
        tmux: false,
        discovery: { background: false, cachePath: ':memory:' },
        metrics: { background: false },
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
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })
    daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
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
