import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentPhase, ControlMessage, ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { type SessionRow, SessionStore } from './store'

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

  it('answers a client ping with pong (browser-level keepalive)', () => {
    const reg = new SessionRegistry()
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'ping' })
    expect(c.sent).toContainEqual({ type: 'pong' })
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

  // A row can be persisted 'exited' yet still be alive: its abduco attach client
  // died on a daemon restart while the master + agent survived in their scope. On
  // boot the durable host — not the stale row — is the source of truth, so the
  // registry probes exited rows and reattaches the ones still running.
  const exitedRow = (id: string, over: Partial<SessionRow> = {}): SessionRow => ({
    id,
    agentKind: 'claude-code',
    cwd: '/proj',
    title: 'agent',
    name: null,
    originKind: 'resume',
    conversationId: 'conv-1',
    resumeKind: 'claude-session',
    resumeValue: 'resume-1',
    status: 'exited',
    exitCode: 0,
    durableLabel: `podium-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    workState: null,
    ...over,
  })

  it('probes an exited session on boot and reattaches it when the master is alive', () => {
    const store = new SessionStore(':memory:')
    const id = 'orphan-1'
    store.upsertSession(exitedRow(id))
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    // Boot probes the exited row against the durable host.
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'reattach', sessionId: id, durableLabel: `podium-${id}` }),
    )
    // The daemon found the master alive → bind → the session comes back live and
    // the stale exit is cleared. Without the fix it would stay 'exited' forever.
    reg.onDaemonMessage(bind(id))
    const healed = reg.listSessions().find((m) => m.sessionId === id)
    expect(healed).toMatchObject({ status: 'live' })
    expect(healed?.exitCode).toBeUndefined()
  })

  it('leaves a dead exited session exited and untouched when its master is gone', () => {
    const store = new SessionStore(':memory:')
    const id = 'dead-1'
    store.upsertSession(exitedRow(id))
    const reg = new SessionRegistry(store)
    reg.attachDaemon(() => {})
    // The durable host has no such session → reattachFailed. An already-exited row
    // must stay put: no status change, no exitCode churn (0 → -1), no re-broadcast.
    reg.onDaemonMessage({ type: 'reattachFailed', sessionId: id, reason: 'session not found' })
    expect(reg.listSessions().find((m) => m.sessionId === id)).toMatchObject({
      status: 'exited',
      exitCode: 0,
    })
  })

  it('does not probe an archived exited session', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(exitedRow('arch-1', { archived: true }))
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    expect(daemon.some((m) => m.type === 'reattach' && m.sessionId === 'arch-1')).toBe(false)
  })

  it('reattaches most-recently-used sessions first', () => {
    const store = new SessionStore(':memory:')
    // Insert out of recency order to prove the order is by lastActiveAt, not insertion.
    store.upsertSession(exitedRow('mid', { lastActiveAt: '2026-03-02T00:00:00.000Z' }))
    store.upsertSession(exitedRow('newest', { lastActiveAt: '2026-03-09T00:00:00.000Z' }))
    store.upsertSession(exitedRow('oldest', { lastActiveAt: '2026-01-01T00:00:00.000Z' }))
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const order = daemon.filter((m) => m.type === 'reattach').map((m) => m.sessionId)
    expect(order).toEqual(['newest', 'mid', 'oldest'])
  })

  it('daemon disconnect drops live sessions to reconnecting so the next daemon re-binds them', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    reg.onDaemonMessage(bind(sessionId)) // → live
    expect(reg.listSessions().at(0)?.status).toBe('live')
    // Daemon-only restart: its WS closes while the server keeps running.
    reg.detachDaemon()
    expect(reg.listSessions().at(0)?.status).toBe('reconnecting')
    // A fresh daemon attaches with no bridges → it must be asked to reattach.
    const daemon2: ControlMessage[] = []
    reg.attachDaemon((m) => daemon2.push(m))
    expect(daemon2.some((m) => m.type === 'reattach' && m.sessionId === sessionId)).toBe(true)
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

  it('broadcasts updated metas when a session gains a resume ref (resumable → hibernate)', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'codex', cwd: '/proj' })
    const c = sink()
    reg.attachClient(c.send)
    c.sent.length = 0

    reg.onDaemonMessage({
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-1' },
    })

    const pushed = c.sent.filter(
      (m): m is Extract<ServerMessage, { type: 'sessionsChanged' }> => m.type === 'sessionsChanged',
    )
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.at(-1)?.sessions.find((s) => s.sessionId === sessionId)?.resumable).toBe(true)
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
      name: null,
      archived: false,
      workState: null,
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
      name: null,
      archived: false,
      workState: null,
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

describe('agent state', () => {
  const STATE = {
    phase: 'errored' as const,
    since: '2026-06-12T10:00:00.000Z',
    openTaskCount: 0,
    error: { class: 'rate_limit', retryable: true },
  }

  it('agentState from the daemon pushes a per-session message and lands on SessionMeta', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    const client = sink()
    reg.attachClient(client.send)
    client.sent.length = 0
    reg.onDaemonMessage({ type: 'agentState', sessionId, state: STATE })
    const update = client.sent.find((m) => m.type === 'sessionAgentStateChanged')
    expect(update).toEqual({ type: 'sessionAgentStateChanged', sessionId, state: STATE })
    // Hook events fire often — this must NOT re-broadcast the whole session list.
    expect(client.sent.some((m) => m.type === 'sessionsChanged')).toBe(false)
    // Late joiners still see the state via listSessions().
    expect(reg.listSessions().find((s) => s.sessionId === sessionId)?.agentState).toEqual(STATE)
  })

  it('agentState for an unknown session is ignored', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    expect(() =>
      reg.onDaemonMessage({ type: 'agentState', sessionId: 'ghost', state: STATE }),
    ).not.toThrow()
  })

  it('continueSession writes "continue\\r" to the PTY only while errored', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    // not errored yet → refused
    expect(reg.continueSession({ sessionId })).toEqual({ ok: false })
    reg.onDaemonMessage({ type: 'agentState', sessionId, state: STATE })
    expect(reg.continueSession({ sessionId })).toEqual({ ok: true })
    const input = daemon.find((m) => m.type === 'input' && m.sessionId === sessionId)
    expect(input).toBeDefined()
    expect(
      Buffer.from((input as Extract<ControlMessage, { type: 'input' }>).data, 'base64').toString(
        'utf8',
      ),
    ).toBe('continue\r')
    expect(reg.continueSession({ sessionId: 'ghost' })).toEqual({ ok: false })
  })

  it('sends every configured external push target only when no client is visible', () => {
    const store = new SessionStore(':memory:')
    const settings = store.getSettings()
    store.setSettings({
      ...settings,
      notifications: {
        ...settings.notifications,
        web: true,
        ntfyTopic: 'podium-topic',
        telegramBotToken: '123456:secret',
        telegramChatId: '-100123',
      },
    })
    const ntfy = vi.fn()
    const telegram = vi.fn()

    try {
      const reg = new SessionRegistry(store, { ntfy, telegram })
      reg.attachDaemon(() => {})
      const { sessionId } = reg.createSession({
        agentKind: 'claude-code',
        cwd: '/proj',
        title: 'keyboard',
      })
      const hidden = sink()
      const hiddenId = reg.attachClient(hidden.send)
      reg.onClientMessage(hiddenId, { type: 'presence', visible: false })
      hidden.sent.length = 0

      reg.onDaemonMessage({
        type: 'agentState',
        sessionId,
        state: {
          phase: 'needs_user',
          since: '2026-06-12T10:00:00.000Z',
          openTaskCount: 0,
          need: { kind: 'question', summary: 'SQLite or Postgres?' },
        },
      })

      expect(hidden.sent).toContainEqual({
        type: 'attentionEvent',
        sessionId,
        title: 'keyboard needs you',
        body: 'SQLite or Postgres?',
      })
      expect(ntfy).toHaveBeenCalledWith('podium-topic', {
        title: 'keyboard needs you',
        body: 'SQLite or Postgres?',
      })
      expect(telegram).toHaveBeenCalledWith(
        { botToken: '123456:secret', chatId: '-100123' },
        { title: 'keyboard needs you', body: 'SQLite or Postgres?' },
      )

      ntfy.mockClear()
      telegram.mockClear()
      const visible = sink()
      const visibleId = reg.attachClient(visible.send)
      reg.onClientMessage(visibleId, { type: 'presence', visible: true })
      reg.onDaemonMessage({
        type: 'agentState',
        sessionId,
        state: {
          phase: 'errored',
          since: '2026-06-12T10:01:00.000Z',
          openTaskCount: 0,
          error: { class: 'rate_limit', retryable: true },
        },
      })

      expect(ntfy).not.toHaveBeenCalled()
      expect(telegram).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })
})

describe('structured transcript channel', () => {
  it('snapshot on subscribe, appends after, snapshot again on reset', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const client = sink()
    const clientId = reg.attachClient(client.send)
    reg.onClientMessage(clientId, { type: 'transcriptSubscribe', sessionId })
    expect(client.sent).toContainEqual({ type: 'transcriptSnapshot', sessionId, items: [] })

    const item = { id: 'u1', role: 'user' as const, text: 'hi' }
    reg.onDaemonMessage({ type: 'transcriptAppend', sessionId, items: [item] })
    expect(client.sent).toContainEqual({ type: 'transcriptAppend', sessionId, items: [item] })

    const item2 = { id: 'u2', role: 'user' as const, text: 'again' }
    reg.onDaemonMessage({ type: 'transcriptAppend', sessionId, items: [item2], reset: true })
    expect(client.sent.at(-1)).toEqual({ type: 'transcriptSnapshot', sessionId, items: [item2] })
  })

  it('a subscriber needs no PTY attachment, and unsubscribe stops the stream', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const client = sink()
    const clientId = reg.attachClient(client.send)
    reg.onClientMessage(clientId, { type: 'transcriptSubscribe', sessionId })
    reg.onClientMessage(clientId, { type: 'transcriptUnsubscribe', sessionId })
    // Count transcript-stream frames only: the first append flips the session's
    // transcriptAvailable flag, which broadcasts a sessionsChanged to every
    // client (subscribed or not) — that capability flip is not a stream frame.
    const frames = () =>
      client.sent.filter((m) => m.type === 'transcriptAppend' || m.type === 'transcriptSnapshot')
        .length
    const before = frames()
    reg.onDaemonMessage({
      type: 'transcriptAppend',
      sessionId,
      items: [{ id: 'x', role: 'user', text: 'unseen' }],
    })
    expect(frames()).toBe(before)
  })
})

describe('sendText (chat send path)', () => {
  it('wraps single-line text in bracketed paste, then submits with a separate CR', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.onDaemonMessage(bind(sessionId))
    expect(reg.sendText({ sessionId, text: 'run the tests' })).toEqual({ ok: true })
    // Single-line goes through the same paste-then-CR path as multi-line: a CR fused
    // onto the text in one write gets absorbed by some TUIs — the message lands in the
    // input but never submits, which was the "types into native but doesn't submit" bug.
    const inputs = daemon
      .filter((m) => m.type === 'input')
      .map((m) => Buffer.from((m as { data: string }).data, 'base64').toString())
    expect(inputs).toEqual(['\x1b[200~run the tests\x1b[201~', '\r'])
  })

  it('wraps multi-line text in bracketed paste, then submits with a separate CR', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.onDaemonMessage(bind(sessionId))
    reg.sendText({ sessionId, text: 'a\nb' })
    // The paste block and the submitting CR are separate writes — a CR fused onto
    // the paste-end marker gets absorbed by some TUIs and never submits.
    const inputs = daemon
      .filter((m) => m.type === 'input')
      .map((m) => Buffer.from((m as { data: string }).data, 'base64').toString())
    expect(inputs).toEqual(['\x1b[200~a\nb\x1b[201~', '\r'])
  })

  it('refuses for exited sessions', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.onDaemonMessage({ type: 'agentExit', sessionId, code: 0 })
    expect(reg.sendText({ sessionId, text: 'hello?' })).toEqual({ ok: false })
  })
})

describe('hibernation', () => {
  function liveSession(reg: SessionRegistry, daemon: ControlMessage[]) {
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.onDaemonMessage(bind(sessionId))
    reg.onDaemonMessage({
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'abc-123' },
    })
    return sessionId
  }

  it('hibernate kills the process, keeps the row, survives the agentExit echo', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)

    expect(reg.hibernateSession({ sessionId })).toEqual({ ok: true })
    expect(daemon).toContainEqual({ type: 'kill', sessionId })
    expect(reg.listSessions()[0]).toMatchObject({ sessionId, status: 'hibernated' })
    // The daemon's kill produces an exit — it must not flip hibernated → exited.
    reg.onDaemonMessage({ type: 'agentExit', sessionId, code: 0 })
    expect(reg.listSessions()[0]?.status).toBe('hibernated')
  })

  it('refuses to hibernate a session with no resume ref (would be a kill)', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'shell', cwd: '/w' })
    reg.onDaemonMessage(bind(sessionId))
    expect(reg.hibernateSession({ sessionId }).ok).toBe(false)
  })

  it('resurrect respawns under the same id with the resume ref', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)
    reg.hibernateSession({ sessionId })
    daemon.length = 0

    expect(reg.resurrectSession({ sessionId })).toEqual({ ok: true })
    expect(daemon).toContainEqual(
      expect.objectContaining({
        type: 'spawn',
        sessionId,
        resume: { kind: 'claude-session', value: 'abc-123' },
      }),
    )
    expect(reg.listSessions()[0]?.status).toBe('starting')
  })

  it('resurrect revives an exited (crashed) session with a resume ref', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)
    // The process dies out from under us (crash / external kill).
    reg.onDaemonMessage({ type: 'agentExit', sessionId, code: 0 })
    expect(reg.listSessions()[0]?.status).toBe('exited')
    daemon.length = 0

    expect(reg.resurrectSession({ sessionId })).toEqual({ ok: true })
    expect(daemon).toContainEqual(
      expect.objectContaining({
        type: 'spawn',
        sessionId,
        resume: { kind: 'claude-session', value: 'abc-123' },
      }),
    )
    expect(reg.listSessions()[0]?.status).toBe('starting')
  })

  it('restarts an exited shell fresh in the same cwd — no resume ref needed', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'shell', cwd: '/w' })
    reg.onDaemonMessage(bind(sessionId))
    reg.onDaemonMessage({ type: 'agentExit', sessionId, code: 137 })
    expect(reg.listSessions()[0]?.status).toBe('exited')
    daemon.length = 0

    expect(reg.resurrectSession({ sessionId })).toEqual({ ok: true })
    const spawn = daemon.find((m) => m.type === 'spawn')
    expect(spawn).toMatchObject({ sessionId, agentKind: 'shell', cwd: '/w' })
    expect(spawn && 'resume' in spawn ? spawn.resume : undefined).toBeUndefined()
  })

  it('refuses to resurrect a live session', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)
    expect(reg.resurrectSession({ sessionId }).ok).toBe(false)
  })

  it('auto-hibernates the oldest idle resumable session above the memory threshold', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const settings = store.getSettings()
    store.setSettings({
      ...settings,
      hibernation: { enabled: true, memoryPct: 80, idleMinutes: 1 },
    })
    const sessionId = liveSession(reg, daemon)
    // Mark the agent idle, with activity old enough to pass the idle cutoff.
    reg.onDaemonMessage({
      type: 'agentState',
      sessionId,
      state: {
        phase: 'idle',
        since: '2026-06-12T00:00:00.000Z',
        openTaskCount: 0,
        idle: { kind: 'done' },
      },
    })
    const session = reg.listSessions()[0]
    expect(session?.agentState?.phase).toBe('idle')
    // agentState bumps lastActiveAt to now — rewind it via the store round-trip.
    // (The idle cutoff compares lastActiveAt; simulate an hour of silence.)
    // biome-ignore lint/suspicious/noExplicitAny: test reaches into the private map on purpose
    const internal = (reg as any).sessions.get(sessionId)
    internal.lastActiveAt = new Date(Date.now() - 3_600_000).toISOString()

    reg.onDaemonMessage({
      type: 'hostMetrics',
      hostname: 'box',
      sampledAt: new Date().toISOString(),
      memory: {
        totalBytes: 100,
        availableBytes: 10, // 90% used
        swapTotalBytes: 0,
        swapFreeBytes: 0,
      },
    })
    expect(reg.listSessions()[0]?.status).toBe('hibernated')
  })
})

describe('reconnect identity (hello reclaim)', () => {
  const VP = { cols: 80, rows: 24, dpr: 1 }

  it('a reconnecting client reclaims its prior controller role and evicts the stale one', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.onDaemonMessage(bind(s1))

    // First socket: attaches and becomes controller; its input flows.
    const a = sink()
    const idA = reg.attachClient(a.send)
    reg.onClientMessage(idA, { type: 'attach', sessionId: s1 })
    reg.onClientMessage(idA, { type: 'input', sessionId: s1, data: 'eA==' })
    expect(daemon).toContainEqual({ type: 'input', sessionId: s1, data: 'eA==' })

    // The socket goes half-open; a new socket connects and re-presents idA in hello,
    // then re-attaches the way the client does on reconnect.
    const b = sink()
    const idB = reg.attachClient(b.send)
    reg.onClientMessage(idB, { type: 'hello', clientId: idA, viewport: VP })
    reg.onClientMessage(idB, { type: 'attach', sessionId: s1 })

    daemon.length = 0
    // B now drives input (it inherited control)...
    reg.onClientMessage(idB, { type: 'input', sessionId: s1, data: 'eQ==' })
    expect(daemon).toContainEqual({ type: 'input', sessionId: s1, data: 'eQ==' })
    // ...and the stale A is gone: its messages are dropped, not honored.
    reg.onClientMessage(idA, { type: 'input', sessionId: s1, data: 'eg==' })
    expect(daemon).not.toContainEqual({ type: 'input', sessionId: s1, data: 'eg==' })
  })

  it('hello with an unknown prior id is a harmless no-op', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const c = sink()
    const id = reg.attachClient(c.send)
    expect(() =>
      reg.onClientMessage(id, { type: 'hello', clientId: 'c-stale-gone', viewport: VP }),
    ).not.toThrow()
  })

  describe('session draft sync', () => {
    it('broadcasts setSessionDraft to other clients, not the sender', () => {
      const reg = new SessionRegistry()
      const a: ServerMessage[] = []
      const b: ServerMessage[] = []
      const idA = reg.attachClient((m) => a.push(m))
      reg.attachClient((m) => b.push(m))
      reg.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: 'half typed' })
      expect(a.filter((m) => m.type === 'sessionDraftChanged')).toEqual([])
      expect(b).toContainEqual({ type: 'sessionDraftChanged', sessionId: 'sess', text: 'half typed' })
    })

    it('replays stored drafts to a freshly connected client', () => {
      const reg = new SessionRegistry()
      const idA = reg.attachClient(() => {})
      reg.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: 'wip' })
      const c: ServerMessage[] = []
      reg.attachClient((m) => c.push(m))
      expect(c).toContainEqual({ type: 'sessionDraftChanged', sessionId: 'sess', text: 'wip' })
    })

    it('clears a draft when text is empty', () => {
      const reg = new SessionRegistry()
      const idA = reg.attachClient(() => {})
      reg.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: 'wip' })
      reg.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: '' })
      const c: ServerMessage[] = []
      reg.attachClient((m) => c.push(m))
      expect(c.filter((m) => m.type === 'sessionDraftChanged')).toEqual([])
    })

    it('persists a draft (debounced) across a server restart and replays it', () => {
      vi.useFakeTimers()
      try {
        const dir = mkdtempSync(join(tmpdir(), 'podium-draft-'))
        const dbPath = join(dir, 'podium.db')
        const store = new SessionStore(dbPath)
        const reg = new SessionRegistry(store)
        const idA = reg.attachClient(() => {})
        reg.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: 'real work' })
        // Not written yet — keystrokes coalesce; the row appears once the debounce fires.
        expect(store.loadDrafts().sess).toBeUndefined()
        vi.advanceTimersByTime(1000)
        expect(store.loadDrafts().sess).toBe('real work')
        store.close()

        // "Restart": a fresh registry on the same DB replays the persisted draft
        // to the first client to connect (issue #34: survives a full reload).
        const store2 = new SessionStore(dbPath)
        const reg2 = new SessionRegistry(store2)
        const c: ServerMessage[] = []
        reg2.attachClient((m) => c.push(m))
        expect(c).toContainEqual({ type: 'sessionDraftChanged', sessionId: 'sess', text: 'real work' })
        store2.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears the persisted draft immediately when the composer empties (send)', () => {
      vi.useFakeTimers()
      try {
        const store = new SessionStore(':memory:')
        const reg = new SessionRegistry(store)
        const idA = reg.attachClient(() => {})
        reg.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: 'about to send' })
        reg.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: '' })
        // No debounce wait: an empty draft flushes at once so a restart right after
        // a send never restores stale text.
        expect(store.loadDrafts().sess).toBeUndefined()
        store.close()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('SessionRegistry snooze', () => {
  const agentState = (sessionId: string, phase: AgentPhase, extra: Record<string, unknown> = {}) =>
    ({
      type: 'agentState',
      sessionId,
      state: { phase, since: '2026-06-19T00:00:00.000Z', openTaskCount: 0, ...extra },
    }) as const

  it('set/list/clear round-trips and shows on the session meta', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.onDaemonMessage(bind(sessionId))

    reg.setSnooze({ sessionId, until: null })
    expect(reg.listSnoozes()).toEqual({ [sessionId]: null })
    expect(reg.listSessions()[0]?.snoozedUntil).toBeNull()

    reg.clearSnooze(sessionId)
    expect(reg.listSnoozes()).toEqual({})
    expect('snoozedUntil' in (reg.listSessions()[0] ?? {})).toBe(false)
  })

  it('a submitted prompt (sendText) clears the snooze', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.onDaemonMessage(bind(sessionId))
    reg.setSnooze({ sessionId, until: null })

    reg.sendText({ sessionId, text: 'hi' })
    expect(reg.listSnoozes()).toEqual({})
  })

  it('leaving the attention phase clears it; staying in attention keeps it', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.onDaemonMessage(bind(sessionId))
    reg.onDaemonMessage(agentState(sessionId, 'needs_user', { need: { kind: 'question' } }))
    reg.setSnooze({ sessionId, until: null })

    // needs_user -> idle/question is still attention: snooze survives.
    reg.onDaemonMessage(agentState(sessionId, 'idle', { idle: { kind: 'question' } }))
    expect(reg.listSnoozes()).toEqual({ [sessionId]: null })

    // -> working leaves attention: snooze clears.
    reg.onDaemonMessage(agentState(sessionId, 'working'))
    expect(reg.listSnoozes()).toEqual({})
  })

  it('seeds snoozedUntil from the store at load', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession({
      id: 's1',
      agentKind: 'claude-code',
      cwd: '/p',
      title: 't',
      name: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'hibernated',
      exitCode: null,
      durableLabel: 'd',
      createdAt: '2026-06-19T00:00:00.000Z',
      lastActiveAt: '2026-06-19T00:00:00.000Z',
      archived: false,
      workState: null,
    })
    store.setSnooze('s1', null)
    const reg = new SessionRegistry(store)
    expect(reg.listSessions()[0]?.snoozedUntil).toBeNull()
  })
})
