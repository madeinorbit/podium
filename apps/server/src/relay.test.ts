import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

function sink() {
  const sent: ServerMessage[] = []
  return { send: (m: ServerMessage) => sent.push(m), sent }
}
const G = { cols: 80, rows: 24 }
const bind = (sessionId: string) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/',
    agentKind: 'claude-code',
    geometry: G,
  }) as const

describe('SessionRegistry', () => {
  it('create spawns via the daemon and lists the session as starting', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/proj' }),
    )
    expect(reg.listSessions()).toMatchObject([
      {
        sessionId,
        status: 'starting',
        agentKind: 'claude-code',
        cwd: '/proj',
        origin: { kind: 'spawn' },
      },
    ])
  })

  it('buffers control messages produced before a daemon attaches, then flushes them', () => {
    const reg = new SessionRegistry()
    // Boot race: a starter session is created before the daemon ws has connected.
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/proj' }),
    )
  })

  it('create can spawn a shell session', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'shell', cwd: '/proj' })
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'shell', cwd: '/proj' }),
    )
    expect(reg.listSessions()).toMatchObject([{ sessionId, agentKind: 'shell', cwd: '/proj' }])
  })

  it('resume spawns with the resume ref + resume origin', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
      title: 'old',
    })
    expect(daemon).toContainEqual(
      expect.objectContaining({
        type: 'spawn',
        sessionId,
        resume: { kind: 'codex-thread', value: 't9' },
      }),
    )
    expect(reg.listSessions().at(0)).toMatchObject({
      origin: { kind: 'resume', conversationId: 'c9' },
      title: 'old',
    })
  })

  it('routes frames only to clients attached to that session (ISOLATION)', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    const s2 = reg.createSession({ agentKind: 'claude-code', cwd: '/b' }).sessionId
    reg.onDaemonMessage(bind(s1))
    reg.onDaemonMessage(bind(s2))
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.onDaemonMessage({ type: 'agentFrame', sessionId: s1, seq: 0, data: 'QQ==' })
    reg.onDaemonMessage({ type: 'agentFrame', sessionId: s2, seq: 0, data: 'Qg==' })
    const frames = c.sent.filter((m) => m.type === 'outputFrame')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ sessionId: s1, data: 'QQ==' })
  })

  it('replays buffered output to a client that attaches after frames were produced', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.onDaemonMessage(bind(s1))
    // Frames arrive before any client attaches (e.g. a boot session, or a re-mount).
    reg.onDaemonMessage({ type: 'agentFrame', sessionId: s1, seq: 0, data: 'QQ==' })
    reg.onDaemonMessage({ type: 'agentFrame', sessionId: s1, seq: 1, data: 'Qg==' })
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'attach', sessionId: s1 })
    const frames = c.sent.filter((m) => m.type === 'outputFrame')
    expect(frames.map((f) => (f as { data: string }).data)).toEqual(['QQ==', 'Qg=='])
  })

  it('resets the replay buffer on a screen clear so replay starts from the clear', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.onDaemonMessage(bind(s1))
    reg.onDaemonMessage({
      type: 'agentFrame',
      sessionId: s1,
      seq: 0,
      data: Buffer.from('stale', 'latin1').toString('base64'),
    })
    const clearFrame = Buffer.from('\x1b[2Jfresh', 'latin1').toString('base64')
    reg.onDaemonMessage({ type: 'agentFrame', sessionId: s1, seq: 1, data: clearFrame })
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'attach', sessionId: s1 })
    const frames = c.sent.filter((m) => m.type === 'outputFrame')
    expect(frames.map((f) => (f as { data: string }).data)).toEqual([clearFrame])
  })

  it('routes controller input to the daemon tagged with the right sessionId', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.onDaemonMessage(bind(s1))
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.onClientMessage(id, { type: 'input', sessionId: s1, data: 'eA==' })
    expect(daemon).toContainEqual({ type: 'input', sessionId: s1, data: 'eA==' })
  })

  it('takeover on one session leaves another session epoch untouched', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    const s2 = reg.createSession({ agentKind: 'claude-code', cwd: '/b' }).sessionId
    reg.onDaemonMessage(bind(s1))
    reg.onDaemonMessage(bind(s2))
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.onClientMessage(id, { type: 'requestControl', sessionId: s1 })
    expect(reg.listSessions().find((m) => m.sessionId === s2)?.epoch).toBe(0)
  })

  it('kill removes the session and tells the daemon', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.killSession({ sessionId: s1 })
    expect(daemon).toContainEqual({ type: 'kill', sessionId: s1 })
    expect(reg.listSessions()).toHaveLength(0)
  })

  it('agentExit marks the session exited but keeps it listed', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.onDaemonMessage({ type: 'agentExit', sessionId: s1, code: 0 })
    expect(reg.listSessions().find((m) => m.sessionId === s1)).toMatchObject({
      status: 'exited',
      exitCode: 0,
    })
  })

  it('attachClient sends welcome plus session and conversation snapshots', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    reg.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg.onDaemonMessage({
      type: 'conversationsChanged',
      conversations: [{ id: 'conv-1', agentKind: 'codex', providerId: 'codex-jsonl' }],
      diagnostics: [],
    })
    const c = sink()
    const id = reg.attachClient(c.send)
    expect(c.sent).toContainEqual({ type: 'welcome', clientId: id })
    expect(c.sent.some((m) => m.type === 'sessionsChanged')).toBe(true)
    expect(c.sent).toContainEqual({
      type: 'conversationsChanged',
      conversations: [{ id: 'conv-1', agentKind: 'codex', providerId: 'codex-jsonl' }],
      diagnostics: [],
    })
  })

  it('broadcasts daemon conversation changes to current clients', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const c = sink()
    reg.attachClient(c.send)
    c.sent.length = 0

    reg.onDaemonMessage({
      type: 'conversationsChanged',
      conversations: [{ id: 'conv-2', agentKind: 'claude-code', providerId: 'claude-code-jsonl' }],
      diagnostics: [],
    })

    expect(c.sent).toEqual([
      {
        type: 'conversationsChanged',
        conversations: [
          { id: 'conv-2', agentKind: 'claude-code', providerId: 'claude-code-jsonl' },
        ],
        diagnostics: [],
      },
    ])
  })

  it('scanResult updates the latest conversation snapshot and broadcasts it', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const c = sink()
    reg.attachClient(c.send)
    c.sent.length = 0
    const p = reg.scan()
    const req = daemon.find((m) => m.type === 'scanRequest') as { requestId: string } | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('scanRequest not sent')

    reg.onDaemonMessage({
      type: 'scanResult',
      requestId: req.requestId,
      conversations: [{ id: 'conv-3', agentKind: 'codex', providerId: 'codex-jsonl' }],
      diagnostics: [],
    })

    await expect(p).resolves.toMatchObject({ conversations: [{ id: 'conv-3' }] })
    expect(c.sent).toContainEqual({
      type: 'conversationsChanged',
      conversations: [{ id: 'conv-3', agentKind: 'codex', providerId: 'codex-jsonl' }],
      diagnostics: [],
    })
  })

  it('scan correlates the daemon scanResult back to the caller', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const p = reg.scan()
    const req = daemon.find((m) => m.type === 'scanRequest') as { requestId: string } | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('scanRequest not sent')
    reg.onDaemonMessage({
      type: 'scanResult',
      requestId: req.requestId,
      conversations: [{ id: 'x', agentKind: 'claude-code', providerId: 'p' }],
      diagnostics: [],
    })
    await expect(p).resolves.toMatchObject({ conversations: [{ id: 'x' }], diagnostics: [] })
  })

  it('scanRepos correlates the daemon scanReposResult back to the caller', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const p = reg.scanRepos(['/home/u/src'])
    const req = daemon.find((m) => m.type === 'scanReposRequest') as
      | { requestId: string; roots: string[] }
      | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('scanReposRequest not sent')
    expect(req.roots).toEqual(['/home/u/src'])
    reg.onDaemonMessage({
      type: 'scanReposResult',
      requestId: req.requestId,
      repositories: [{ path: '/r', kind: 'repository', worktrees: [] }],
      diagnostics: [],
    })
    await expect(p).resolves.toMatchObject({ repositories: [{ path: '/r' }], diagnostics: [] })
  })

  it('a daemon title updates the session and pushes sessionTitleChanged to clients', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    const c = sink()
    reg.attachClient(c.send)
    c.sent.length = 0 // drop the welcome + initial sessionsChanged

    reg.onDaemonMessage({ type: 'title', sessionId, title: '✳ rename functionality' })

    expect(c.sent).toContainEqual({
      type: 'sessionTitleChanged',
      sessionId,
      title: '✳ rename functionality',
    })
    // Not a full list rebroadcast.
    expect(c.sent.some((m) => m.type === 'sessionsChanged')).toBe(false)
    // Late joiners see it via listSessions().
    expect(reg.listSessions().at(0)).toMatchObject({ sessionId, title: '✳ rename functionality' })
  })

  it('ignores a title for an unknown session', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const c = sink()
    reg.attachClient(c.send)
    c.sent.length = 0
    reg.onDaemonMessage({ type: 'title', sessionId: 'nope', title: 'x' })
    expect(c.sent).toEqual([])
  })

  it('write-through: a spawned session is persisted, live/exit/title update the row', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/a', title: 't' })
    expect(store.loadSessions()).toMatchObject([{ id: sessionId, status: 'starting', title: 't' }])
    reg.onDaemonMessage(bind(sessionId))
    expect(store.loadSessions().at(0)).toMatchObject({ status: 'live' })
    reg.onDaemonMessage({ type: 'title', sessionId, title: '✳ working' })
    expect(store.loadSessions().at(0)).toMatchObject({ title: '✳ working' })
    reg.onDaemonMessage({ type: 'agentExit', sessionId, code: 0 })
    expect(store.loadSessions().at(0)).toMatchObject({ status: 'exited', exitCode: 0 })
    reg.killSession({ sessionId })
    expect(store.loadSessions()).toEqual([])
  })

  it('mints opaque durable session ids (uuid), not the s0 counter', () => {
    const reg = new SessionRegistry(new SessionStore(':memory:'))
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/a' })
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('boot reconcile: persisted live sessions reload as reconnecting and trigger reattach', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.attachDaemon(() => {})
    const { sessionId } = reg1.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
      title: 'old',
    })
    reg1.onDaemonMessage(bind(sessionId))
    store1.close()

    // Restart: fresh registry over the same db.
    const store2 = new SessionStore(file)
    const reg2 = new SessionRegistry(store2)
    expect(reg2.listSessions().find((m) => m.sessionId === sessionId)).toMatchObject({
      status: 'reconnecting',
      title: 'old',
      origin: { kind: 'resume', conversationId: 'c9' },
    })
    // Attaching the daemon fires a reattach for the reconnecting session.
    const control: import('@podium/protocol').ControlMessage[] = []
    reg2.attachDaemon((m) => control.push(m))
    expect(control).toContainEqual(
      expect.objectContaining({ type: 'reattach', sessionId, durableLabel: `podium-${sessionId}` }),
    )
    store2.close()
  })

  it('reattach success: bind on a reconnecting session makes it live', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.attachDaemon(() => {})
    const { sessionId } = reg1.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg1.onDaemonMessage(bind(sessionId))
    store1.close()
    const reg2 = new SessionRegistry(new SessionStore(file))
    reg2.attachDaemon(() => {})
    expect(reg2.listSessions().at(0)?.status).toBe('reconnecting')
    reg2.onDaemonMessage(bind(sessionId))
    expect(reg2.listSessions().at(0)?.status).toBe('live')
  })

  it('reattachFailed marks the session exited', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.attachDaemon(() => {})
    const { sessionId } = reg1.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg1.onDaemonMessage(bind(sessionId))
    store1.close()
    const reg2 = new SessionRegistry(new SessionStore(file))
    reg2.attachDaemon(() => {})
    expect(reg2.listSessions().at(0)?.status).toBe('reconnecting') // handler must drive the transition
    reg2.onDaemonMessage({ type: 'reattachFailed', sessionId, reason: 'no tmux session' })
    expect(reg2.listSessions().at(0)?.status).toBe('exited')
  })

  it('skips a persisted session with an invalid agentKind on load', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession({
      id: 'good',
      agentKind: 'claude-code',
      cwd: '/a',
      title: 'good',
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'live',
      exitCode: null,
      durableLabel: 'podium-good',
      createdAt: '2026-06-09T00:00:00.000Z',
      lastActiveAt: '2026-06-09T00:00:00.000Z',
    })
    store.upsertSession({
      id: 'bad',
      agentKind: 'bogus-agent',
      cwd: '/b',
      title: 'bad',
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'live',
      exitCode: null,
      durableLabel: 'podium-bad',
      createdAt: '2026-06-09T00:00:00.000Z',
      lastActiveAt: '2026-06-09T00:00:00.000Z',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = new SessionRegistry(store)
    const ids = reg.listSessions().map((m) => m.sessionId)
    expect(ids).toContain('good')
    expect(ids).not.toContain('bad')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('host metrics relay', () => {
  const sample = (hostname: string, availableBytes = 16) => ({
    type: 'hostMetrics' as const,
    hostname,
    sampledAt: '2026-06-11T00:00:00.000Z',
    memory: { totalBytes: 32, availableBytes, swapTotalBytes: 8, swapFreeBytes: 8 },
  })
  const metricsMsgs = (sent: ServerMessage[]) =>
    sent.filter((m): m is Extract<ServerMessage, { type: 'hostMetricsChanged' }> => {
      return m.type === 'hostMetricsChanged'
    })

  it('broadcasts the latest sample per host to all clients', () => {
    const reg = new SessionRegistry()
    const a = sink()
    const b = sink()
    reg.attachClient(a.send)
    reg.attachClient(b.send)
    reg.onDaemonMessage(sample('podium-host'))
    reg.onDaemonMessage(sample('podium-host', 8)) // newer sample replaces, not appends
    const last = metricsMsgs(a.sent).at(-1)
    expect(last?.hosts).toEqual([expect.objectContaining({ hostname: 'podium-host' })])
    expect(last?.hosts[0]?.memory.availableBytes).toBe(8)
    expect(metricsMsgs(b.sent).at(-1)).toEqual(last)
  })

  it('keeps hosts side by side when several hostnames report', () => {
    const reg = new SessionRegistry()
    const a = sink()
    reg.attachClient(a.send)
    reg.onDaemonMessage(sample('alpha'))
    reg.onDaemonMessage(sample('beta'))
    const hosts = metricsMsgs(a.sent)
      .at(-1)
      ?.hosts.map((h) => h.hostname)
    expect(hosts?.sort()).toEqual(['alpha', 'beta'])
  })

  it('snapshots current metrics to a late-joining client', () => {
    const reg = new SessionRegistry()
    reg.onDaemonMessage(sample('podium-host'))
    const late = sink()
    reg.attachClient(late.send)
    expect(metricsMsgs(late.sent).at(-1)?.hosts).toEqual([
      expect.objectContaining({ hostname: 'podium-host' }),
    ])
  })

  it('clears and re-broadcasts when the daemon detaches (stale numbers never linger)', () => {
    const reg = new SessionRegistry()
    const a = sink()
    reg.attachClient(a.send)
    reg.attachDaemon(() => {})
    reg.onDaemonMessage(sample('podium-host'))
    reg.detachDaemon()
    expect(metricsMsgs(a.sent).at(-1)?.hosts).toEqual([])
  })
})

describe('memory breakdown relay', () => {
  const memory = { totalBytes: 32, availableBytes: 16, swapTotalBytes: 0, swapFreeBytes: 0 }

  it('forwards the request to the daemon and resolves with its answer', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const pending = reg.memoryBreakdown(['/src/app'])
    const req = daemon.find(
      (m): m is Extract<ControlMessage, { type: 'memoryBreakdownRequest' }> =>
        m.type === 'memoryBreakdownRequest',
    )
    expect(req?.roots).toEqual(['/src/app'])
    reg.onDaemonMessage({
      type: 'memoryBreakdownResult',
      requestId: req?.requestId ?? '',
      hostname: 'podium-host',
      sampledAt: '2026-06-11T00:00:00.000Z',
      supported: true,
      memory,
      agents: [{ sessionId: 's1', bytes: 4, processCount: 2 }],
      projects: [],
      otherBytes: 12,
    })
    const result = await pending
    expect(result?.hostname).toBe('podium-host')
    expect(result?.agents[0]?.sessionId).toBe('s1')
    expect(result).not.toHaveProperty('requestId')
  })

  it('resolves undefined when no daemon answers in time', async () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      reg.attachDaemon(() => {})
      const pending = reg.memoryBreakdown([])
      vi.advanceTimersByTime(10_500)
      await expect(pending).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
