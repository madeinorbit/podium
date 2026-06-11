import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  abducoHasSession,
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
