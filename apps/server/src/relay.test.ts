import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

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

  it('attachClient sends welcome + a sessions snapshot', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    reg.createSession({ agentKind: 'claude-code', cwd: '/a' })
    const c = sink()
    const id = reg.attachClient(c.send)
    expect(c.sent).toContainEqual({ type: 'welcome', clientId: id })
    expect(c.sent.some((m) => m.type === 'sessionsChanged')).toBe(true)
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
})
