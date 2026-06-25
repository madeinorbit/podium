import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentPhase,
  AgentRuntimeState,
  ControlMessage,
  ServerMessage,
} from '@podium/protocol'
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

  it('passes initialPrompt to the daemon spawn for argv-capable agents (claude/codex/grok)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    reg.createSession({ agentKind: 'claude-code', cwd: '/w', initialPrompt: 'fix the bug' })
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', agentKind: 'claude-code', initialPrompt: 'fix the bug' }),
    )
  })

  it('does NOT put initialPrompt on the spawn for non-argv agents — seeds the composer draft instead', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const client = sink()
    reg.attachClient(client.send)
    const { sessionId } = reg.createSession({ agentKind: 'shell', cwd: '/w', initialPrompt: 'remember this' })
    const spawn = daemon.find((m) => m.type === 'spawn')
    expect(spawn).toBeDefined()
    expect(spawn).not.toHaveProperty('initialPrompt')
    // The prompt is delivered as a draft instead, broadcast to clients.
    expect(client.sent).toContainEqual({
      type: 'sessionDraftChanged',
      sessionId,
      text: 'remember this',
    })
  })

  it('resolves the "auto" agent sentinel to a concrete kind (issue start-flow)', () => {
    // The issue start-flow spawns with the issue's defaultAgent, which falls back
    // to the 'auto' settings sentinel and is cast `as AgentKind` at the boundary.
    // A session must NEVER persist/broadcast 'auto' — it is not a valid AgentKind,
    // so it fails the sessionsChanged zod-parse and silently wipes the entire
    // session list on every client.
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({
      agentKind: 'auto' as unknown as 'claude-code',
      cwd: '/proj',
    })
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code' }),
    )
    expect(reg.listSessions()[0]?.agentKind).toBe('claude-code')
  })

  it('still sends welcome + sessions when the issues payload build throws', () => {
    // The issues list is DERIVED (allWire embeds member sessions). If building it
    // throws (e.g. a poison issue row), it must NOT abort the attach / broadcast and
    // take sessions + the whole connection down with it. Degrade issues to [] + log.
    const reg = new SessionRegistry()
    ;(reg.issues as unknown as { allWire: () => unknown }).allWire = () => {
      throw new Error('boom')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sent: ServerMessage[] = []
    expect(() => reg.attachClient((m) => sent.push(m))).not.toThrow()
    expect(sent.some((m) => m.type === 'welcome')).toBe(true)
    expect(sent.some((m) => m.type === 'sessionsChanged')).toBe(true)
    const issues = sent.find((m) => m.type === 'issuesChanged')
    expect(issues?.type === 'issuesChanged' && issues.issues).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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

  it('resume reuses an existing LIVE row for the same conversation instead of spawning a duplicate', () => {
    // The bug: each resume of one conversation minted a fresh row + its own
    // durable master. dedupeSessionsByResume only HID the siblings, so closing
    // the visible row revealed a masked one (its own title/transcript/stage).
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const first = reg.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
    })
    reg.onDaemonMessage(bind(first.sessionId))
    const spawnsBefore = daemon.filter((m) => m.type === 'spawn').length
    const second = reg.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
    })
    expect(second.sessionId).toBe(first.sessionId)
    expect(reg.listSessions()).toHaveLength(1)
    // No second durable master spawned for the same conversation.
    expect(daemon.filter((m) => m.type === 'spawn').length).toBe(spawnsBefore)
  })

  it('resume resurrects an existing HIBERNATED row for the same conversation (one row, same id)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const first = reg.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
    })
    reg.onDaemonMessage(bind(first.sessionId))
    reg.hibernateSession({ sessionId: first.sessionId })
    const second = reg.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
    })
    expect(second.sessionId).toBe(first.sessionId)
    expect(reg.listSessions()).toHaveLength(1)
    // Reusing a parked row resurrects it (respawn under the same id).
    expect(reg.listSessions()[0]?.status).toBe('starting')
  })

  it('resume still spawns a fresh row when no session exists for that conversation', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    reg.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't1' },
      conversationId: 'c1',
    })
    reg.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't2' },
      conversationId: 'c2',
    })
    expect(reg.listSessions()).toHaveLength(2)
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

  it('write-through: an agentState change persists lastActiveAt so recency survives a restart', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg.onDaemonMessage(bind(sessionId))
    const future = '2999-01-01T00:00:00.000Z'
    reg.onDaemonMessage({
      type: 'agentState',
      sessionId,
      state: { phase: 'working', since: future, openTaskCount: 0 },
    })
    expect(store.loadSessions().at(0)?.lastActiveAt).toBe(future)
  })

  it('write-through: running-shell activity persists the row (recency is durable)', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'shell', cwd: '/a' })
    reg.onDaemonMessage(bind(sessionId))
    const cid = reg.attachClient(sink().send) // first client → controller
    reg.onClientMessage(cid, { type: 'attach', sessionId })
    const spy = vi.spyOn(store, 'upsertSession')
    reg.onClientMessage(cid, {
      type: 'input',
      sessionId,
      data: Buffer.from('ls\r').toString('base64'),
    })
    expect(reg.listSessions().find((m) => m.sessionId === sessionId)?.busy).toBe(true)
    expect(spy).toHaveBeenCalled()
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
    // upsertSession now refuses an out-of-enum agentKind (write-side guard), so a
    // legacy/externally-corrupted row is simulated by writing a valid row and then
    // corrupting the persisted agent_kind directly — the exact loadFromStore scenario.
    store.upsertSession({
      id: 'bad',
      agentKind: 'claude-code',
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
    ;(store as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE sessions SET agent_kind = 'bogus-agent' WHERE id = 'bad'")
      .run()
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
  it('replays nothing on an empty subscribe, then streams live deltas', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const client = sink()
    const clientId = reg.attachClient(client.send)
    // Empty cache → subscribe sends no replay delta (NOT a snapshot/reset — the
    // client loads its history off disk via transcriptRead, not the stream).
    reg.onClientMessage(clientId, { type: 'transcriptSubscribe', sessionId })
    expect(client.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([])

    const item = { id: 'u1', role: 'user' as const, text: 'hi', cursor: 'c1' }
    reg.onDaemonMessage({ type: 'transcriptDelta', sessionId, items: [item], tail: 'c1' })
    expect(client.sent).toContainEqual({
      type: 'transcriptDelta',
      sessionId,
      items: [item],
      tail: 'c1',
    })

    // A reset delta (tailer switched files) clears the cache and fans out reset:true.
    const item2 = { id: 'u2', role: 'user' as const, text: 'again', cursor: 'c2' }
    reg.onDaemonMessage({ type: 'transcriptDelta', sessionId, items: [item2], reset: true })
    expect(client.sent.at(-1)).toEqual({
      type: 'transcriptDelta',
      sessionId,
      items: [item2],
      reset: true,
    })
  })

  it('replays only cached items after `since`, and the whole cache when since is unknown', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    // Seed the recent-delta cache via live deltas.
    const a = { id: 'a', role: 'user' as const, text: 'a', cursor: 'c1' }
    const b = { id: 'b', role: 'assistant' as const, text: 'b', cursor: 'c2' }
    const c = { id: 'c', role: 'user' as const, text: 'c', cursor: 'c3' }
    reg.onDaemonMessage({ type: 'transcriptDelta', sessionId, items: [a, b, c], tail: 'c3' })

    // since=c1 → replay strictly after it (b, c).
    const known = sink()
    const knownId = reg.attachClient(known.send)
    reg.onClientMessage(knownId, { type: 'transcriptSubscribe', sessionId, since: 'c1' })
    expect(known.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([
      { type: 'transcriptDelta', sessionId, items: [b, c] },
    ])

    // since unknown to the cache → replay the whole cache (client cursor-dedups).
    const stale = sink()
    const staleId = reg.attachClient(stale.send)
    reg.onClientMessage(staleId, { type: 'transcriptSubscribe', sessionId, since: 'c0-older' })
    expect(stale.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([
      { type: 'transcriptDelta', sessionId, items: [a, b, c] },
    ])

    // since = the newest cached cursor → nothing after it, send nothing.
    const caught = sink()
    const caughtId = reg.attachClient(caught.send)
    reg.onClientMessage(caughtId, { type: 'transcriptSubscribe', sessionId, since: 'c3' })
    expect(caught.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([])
  })

  it('a subscriber needs no PTY attachment, and unsubscribe stops the stream', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const client = sink()
    const clientId = reg.attachClient(client.send)
    reg.onClientMessage(clientId, { type: 'transcriptSubscribe', sessionId })
    reg.onClientMessage(clientId, { type: 'transcriptUnsubscribe', sessionId })
    // Count transcript-stream frames only: the first delta flips the session's
    // transcriptAvailable flag, which broadcasts a sessionsChanged to every
    // client (subscribed or not) — that capability flip is not a stream frame.
    const frames = () => client.sent.filter((m) => m.type === 'transcriptDelta').length
    const before = frames()
    reg.onDaemonMessage({
      type: 'transcriptDelta',
      sessionId,
      items: [{ id: 'x', role: 'user', text: 'unseen', cursor: 'cx' }],
    })
    expect(frames()).toBe(before)
  })

  it('a daemon transcriptDelta drives the Claude first-prompt title', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const client = sink()
    reg.attachClient(client.send)
    reg.onDaemonMessage({
      type: 'transcriptDelta',
      sessionId,
      items: [{ id: 'u1', role: 'user', text: 'Refactor the transcript reader', cursor: 'c1' }],
      tail: 'c1',
    })
    // First-prompt fallback names the session from the first user prompt.
    expect(client.sent).toContainEqual(
      expect.objectContaining({ type: 'sessionTitleChanged', sessionId }),
    )
    const titled = client.sent.find((m) => m.type === 'sessionTitleChanged') as
      | { title: string }
      | undefined
    expect(titled?.title).toContain('Refactor')
  })
})

describe('readTranscript (disk read via daemon — no cache short-circuit)', () => {
  it('a LIVE session with an EMPTY cache still round-trips to the daemon (the bug fix)', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    // A live, bound session whose recent-delta cache is empty (e.g. right after a
    // server restart). The OLD code short-circuited and returned [] without ever
    // asking the daemon — the core bug. The new code MUST round-trip to disk.
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.onDaemonMessage(bind(sessionId))

    const p = reg.readTranscript({ sessionId, direction: 'before', limit: 50 })
    const req = daemon.find((m) => m.type === 'transcriptRead') as
      | { requestId: string; direction: string; limit: number; sessionId: string }
      | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('transcriptRead not sent — short-circuit regression')
    expect(req.direction).toBe('before')
    expect(req.limit).toBe(50)
    expect(req.sessionId).toBe(sessionId)

    const items = [{ id: 'd1', role: 'user' as const, text: 'from disk', cursor: 'c1' }]
    reg.onDaemonMessage({
      type: 'transcriptReadResult',
      requestId: req.requestId,
      sessionId,
      items,
      head: 'c1',
      tail: 'c1',
      hasMore: true,
    })
    await expect(p).resolves.toEqual({ items, head: 'c1', tail: 'c1', hasMore: true })
  })

  it('passes anchor/direction/limit + agentKind/cwd/resume through to the daemon message', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.resumeSession({
      agentKind: 'codex',
      cwd: '/repo',
      resume: { kind: 'codex-rollout', value: '/r/rollout.jsonl' },
      conversationId: 'conv-1',
    })

    const p = reg.readTranscript({
      sessionId,
      anchor: 'c42',
      direction: 'after',
      limit: 200,
    })
    const req = daemon.find((m) => m.type === 'transcriptRead') as
      | {
          requestId: string
          agentKind: string
          cwd: string
          resume?: { kind: string; value: string }
          anchor?: string
          direction: string
          limit: number
        }
      | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('transcriptRead not sent')
    expect(req.agentKind).toBe('codex')
    expect(req.cwd).toBe('/repo')
    expect(req.resume).toEqual({ kind: 'codex-rollout', value: '/r/rollout.jsonl' })
    expect(req.anchor).toBe('c42')
    expect(req.direction).toBe('after')
    expect(req.limit).toBe(200)

    reg.onDaemonMessage({
      type: 'transcriptReadResult',
      requestId: req.requestId,
      sessionId,
      items: [],
      hasMore: false,
    })
    await expect(p).resolves.toEqual({ items: [], hasMore: false })
  })

  it('resolves an empty page for an unknown session (no daemon round-trip)', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    await expect(
      reg.readTranscript({ sessionId: 'nope', direction: 'before', limit: 10 }),
    ).resolves.toEqual({ items: [], hasMore: false })
    expect(daemon.find((m) => m.type === 'transcriptRead')).toBeUndefined()
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
      expect(b).toContainEqual({
        type: 'sessionDraftChanged',
        sessionId: 'sess',
        text: 'half typed',
      })
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
        expect(c).toContainEqual({
          type: 'sessionDraftChanged',
          sessionId: 'sess',
          text: 'real work',
        })
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
        reg.onClientMessage(idA, {
          type: 'setSessionDraft',
          sessionId: 'sess',
          text: 'about to send',
        })
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

describe('SessionRegistry — auto-continue', () => {
  const erroredState: AgentRuntimeState = {
    phase: 'errored',
    since: '2026-06-24T00:00:00Z',
    openTaskCount: 0,
    error: { class: 'server_error', retryable: true },
  }
  const continueInput = expect.objectContaining({
    type: 'input',
    data: Buffer.from('continue\r').toString('base64'),
  })

  function enableAutoContinue(reg: SessionRegistry) {
    const s = reg.getSettings()
    reg.setSettings({ ...s, autoContinue: { enabled: true, promptDismissed: false } })
  }

  // A session must exist (createSession) and be marked live (bind) before agentState
  // does anything — `bind` only marks an already-registered session live, it does not
  // create the row. continueSession's status gate then accepts the live session.
  function liveSession(reg: SessionRegistry): string {
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    reg.onDaemonMessage(bind(sessionId))
    return sessionId
  }

  it('does NOT auto-send continue when the setting is off', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const sessionId = liveSession(reg)
    reg.onDaemonMessage({ type: 'agentState', sessionId, state: erroredState })
    expect(daemon).not.toContainEqual(continueInput)
    reg.setSettings({ ...reg.getSettings(), autoContinue: { enabled: false, promptDismissed: false } })
  })

  it('auto-sends continue when an enabled session hits a retryable error', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    enableAutoContinue(reg)
    const sessionId = liveSession(reg)
    reg.onDaemonMessage({ type: 'agentState', sessionId, state: erroredState })
    expect(daemon).toContainEqual(continueInput)
    // Cancel the live loop so no real backoff timer dangles past the test.
    reg.setSettings({ ...reg.getSettings(), autoContinue: { enabled: false, promptDismissed: false } })
  })

  it('arms already-errored sessions when the setting is switched on', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const sessionId = liveSession(reg)
    reg.onDaemonMessage({ type: 'agentState', sessionId, state: erroredState })
    expect(daemon).not.toContainEqual(continueInput) // off → silent so far
    enableAutoContinue(reg)
    expect(daemon).toContainEqual(continueInput) // flipping on arms the errored session
    reg.setSettings({ ...reg.getSettings(), autoContinue: { enabled: false, promptDismissed: false } })
  })
})

describe('output-relay priority + frame batch', () => {
  const priorities = (daemon: ControlMessage[]) =>
    daemon.filter(
      (m): m is Extract<ControlMessage, { type: 'sessionPriority' }> =>
        m.type === 'sessionPriority',
    )

  it('a client viewState{visible:[s],focused:s} pushes sessionPriority{priority:0} to the daemon', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const c = sink()
    const id = reg.attachClient(c.send)
    daemon.length = 0 // drop the spawn + daemon-connect priority push

    reg.onClientMessage(id, { type: 'viewState', visible: [sessionId], focused: sessionId })
    // Focused beats visible/attached: tier 0.
    expect(priorities(daemon)).toContainEqual({ type: 'sessionPriority', sessionId, priority: 0 })
  })

  it('computes per-session priority across ALL sessions (clients iterable is materialized, not exhausted)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    // Two sessions: the second would wrongly read as tier 3 if the clients iterator
    // were single-use (it exhausts after the first session) — the array-materialize
    // guard is what keeps this correct.
    const s1 = reg.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    const s2 = reg.createSession({ agentKind: 'claude-code', cwd: '/b' }).sessionId
    const c = sink()
    const id = reg.attachClient(c.send)
    daemon.length = 0

    reg.onClientMessage(id, { type: 'viewState', visible: [s1, s2], focused: s2 })
    const sent = priorities(daemon)
    expect(sent).toContainEqual({ type: 'sessionPriority', sessionId: s1, priority: 1 }) // visible
    expect(sent).toContainEqual({ type: 'sessionPriority', sessionId: s2, priority: 0 }) // focused
  })

  it('only CHANGED sessions are re-pushed (deltas, not the whole map every time)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const c = sink()
    const id = reg.attachClient(c.send)

    reg.onClientMessage(id, { type: 'viewState', visible: [sessionId], focused: sessionId })
    daemon.length = 0
    // An identical viewState changes nothing → no re-send.
    reg.onClientMessage(id, { type: 'viewState', visible: [sessionId], focused: sessionId })
    expect(priorities(daemon)).toEqual([])
  })

  it('a fresh daemon (re)connect gets the current priority of every live session', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'viewState', visible: [sessionId], focused: sessionId })
    // The daemon drops; a fresh one attaches — it knows no priorities, so the full
    // current map must be re-pushed (lastPriority.clear() + pushPriorities()).
    reg.detachDaemon()
    const daemon2: ControlMessage[] = []
    reg.attachDaemon((m) => daemon2.push(m))
    expect(priorities(daemon2)).toContainEqual({
      type: 'sessionPriority',
      sessionId,
      priority: 0,
    })
  })

  it('agentFrameBatch unpacks into one outputFrame broadcast per coalesced frame', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.onDaemonMessage(bind(sessionId))
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, { type: 'attach', sessionId })
    c.sent.length = 0

    reg.onDaemonMessage({ type: 'agentFrameBatch', sessionId, frames: ['ZDE=', 'ZDI='] })
    const frames = c.sent.filter(
      (m): m is Extract<ServerMessage, { type: 'outputFrame' }> => m.type === 'outputFrame',
    )
    // Each coalesced frame becomes its own outputFrame, in order, each with its own
    // server-assigned seq — clients are unaffected by the daemon's coalescing.
    expect(frames.map((f) => f.data)).toEqual(['ZDE=', 'ZDI='])
    expect(frames.map((f) => f.seq)).toEqual([0, 1])
  })
})
