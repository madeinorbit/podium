import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentPhase, AgentRuntimeState, ControlMessage, ServerMessage } from '@podium/protocol'
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
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/proj' }),
    )
    expect(reg.modules.sessions.listSessions()).toMatchObject([
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
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/proj' }),
    )
  })

  it('create can spawn a shell session', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/proj' })
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'shell', cwd: '/proj' }),
    )
    expect(reg.modules.sessions.listSessions()).toMatchObject([{ sessionId, agentKind: 'shell', cwd: '/proj' }])
  })

  it('createSession records spawnedBy provenance, persists it, and omits it when unset (issue #60)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store = new SessionStore(file)
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/proj',
      spawnedBy: 'issue:iss_1',
    })
    const anon = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/other' }).sessionId
    const metaOf = (id: string, r: SessionRegistry = reg) =>
      r.modules.sessions.listSessions().find((s) => s.sessionId === id)
    expect(metaOf(sessionId)?.spawnedBy).toBe('issue:iss_1')
    // No default at the registry layer: an untagged programmatic create stays unknown.
    expect(metaOf(anon)?.spawnedBy).toBeUndefined()
    store.close()
    // Survives a restart (round-trips through the sessions table).
    const reg2 = new SessionRegistry(new SessionStore(file))
    expect(metaOf(sessionId, reg2)?.spawnedBy).toBe('issue:iss_1')
    expect(metaOf(anon, reg2)?.spawnedBy).toBeUndefined()
  })

  it('createSession honors a client-provided sessionId verbatim (optimistic row reconciliation)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const clientId = 'client-picked-id-123'
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/proj',
      sessionId: clientId,
    })
    expect(sessionId).toBe(clientId)
    expect(reg.modules.sessions.listSessions()).toMatchObject([{ sessionId: clientId, cwd: '/proj' }])
    expect(daemon).toContainEqual(expect.objectContaining({ type: 'spawn', sessionId: clientId }))
  })

  it('createSession mints a random uuid when sessionId is omitted (unchanged default behavior)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('createSession refuses a client sessionId that already exists (never clobbers a live session)', () => {
    // Server-minted uuids were unique by construction; a client-supplied id is not,
    // so a collision must be rejected rather than overwrite the live Session (which
    // would orphan its PTY/daemon binding) or re-fire a spawn.
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const clientId = 'dup-id-xyz'
    reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj', sessionId: clientId })
    expect(() =>
      reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/other', sessionId: clientId }),
    ).toThrow()
    // The original session is intact — not overwritten by the second cwd.
    const mine = reg.modules.sessions.listSessions().filter((s) => s.sessionId === clientId)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.cwd).toBe('/proj')
  })

  it('restamps session cwd when the agent moves into a worktree (hook cwd change)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/repo' })
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'sessionCwd',
      sessionId,
      cwd: '/repo/.worktrees/feat',
    })
    expect(reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.cwd).toBe(
      '/repo/.worktrees/feat',
    )
  })

  it('ignores a sessionCwd that is empty or unchanged', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/repo' })
    const cwdOf = () => reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.cwd
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'sessionCwd', sessionId, cwd: '' })
    expect(cwdOf()).toBe('/repo')
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'sessionCwd', sessionId, cwd: '/repo' })
    expect(cwdOf()).toBe('/repo')
  })

  it('passes initialPrompt to the daemon spawn for argv-capable agents (claude/codex/grok)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w', initialPrompt: 'fix the bug' })
    expect(daemon).toContainEqual(
      expect.objectContaining({
        type: 'spawn',
        agentKind: 'claude-code',
        initialPrompt: 'fix the bug',
      }),
    )
  })

  it('pins one exact workflow revision, prepends it to the spawn prompt, and starts a run', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (message) => daemon.push(message))
    const operator = { actor: { kind: 'operator' as const, id: null }, protectedWrite: true }
    const created = reg.modules.workflows.create(
      {
        name: 'Research, plan, implement',
        description: '',
        scope: 'global',
        instructions: 'Research before changing code.',
        steps: [
          {
            id: 'research',
            title: 'Research',
            instructions: 'Inspect the system.',
            completionGuidance: 'Unknowns resolved.',
          },
        ],
      },
      operator,
    )
    reg.modules.workflows.publish({ revisionId: created.revision.id }, operator)
    reg.modules.workflows.assign(
      { targetKind: 'global', targetId: '', revisionId: created.revision.id },
      operator,
    )
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      initialPrompt: 'fix the bug',
    })
    const spawn = daemon.find(
      (message) => message.type === 'spawn' && message.sessionId === sessionId,
    )
    expect(spawn).toMatchObject({ type: 'spawn' })
    expect(spawn?.type === 'spawn' ? spawn.initialPrompt : '').toContain(
      '# Podium workflow: Research, plan, implement (revision 1)',
    )
    expect(spawn?.type === 'spawn' ? spawn.initialPrompt : '').toContain('# Task\n\nfix the bug')
    expect(reg.modules.workflows.runs({}, operator)).toMatchObject([
      { coordinatorSessionId: sessionId, revision: { id: created.revision.id } },
    ])
  })

  it('delivers worker checkpoints through the durable system:workflow message ledger', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', () => {})
    const coordinator = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    }).sessionId
    const worker = reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/w',
    }).sessionId
    const operator = { actor: { kind: 'operator' as const, id: null }, protectedWrite: true }
    const created = reg.modules.workflows.create(
      {
        name: 'Delegated review',
        description: '',
        scope: 'global',
        instructions: 'Use a separate reviewer.',
        steps: [
          {
            id: 'review',
            title: 'Review',
            instructions: 'Review the change.',
            completionGuidance: 'Report findings.',
          },
        ],
      },
      operator,
    )
    const run = reg.modules.workflows.startRun({
      sessionId: coordinator,
      cwd: '/w',
      revisionId: created.revision.id,
    })
    const coordinatorCaller = {
      actor: { kind: 'session' as const, id: coordinator },
      capability: reg.modules.sessions.capabilityForSession(coordinator),
    }
    reg.modules.workflows.assignStep(
      { runId: run.id, stepId: 'review', sessionId: worker },
      coordinatorCaller,
    )
    reg.modules.workflows.checkpoint(
      {
        runId: run.id,
        stepId: 'review',
        status: 'complete',
        summary: 'No findings.',
        evidence: { summary: '', tests: [], artifacts: [] },
      },
      {
        actor: { kind: 'session', id: worker },
        capability: reg.modules.sessions.capabilityForSession(worker),
      },
    )

    const notices = store.messages.listMessagesFor({ kind: 'session', id: coordinator })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      fromKind: 'system',
      fromName: 'workflow',
      toKind: 'session',
      toId: coordinator,
      kind: 'notification',
      urgency: 'fyi',
      lifecycle: 'wait',
      body: 'Workflow step "Review" complete: No findings.',
    })
    expect(
      store.events.listEventsSince(0, { kinds: ['message.queued'] }).at(-1)?.payload,
    ).toMatchObject({ fromKind: 'system', fromName: 'workflow' })
    // Notifications never expect an ack, so #468's settle fallback cannot
    // repeatedly nag the coordinator for workflow notices.
    expect(reg.modules.messages.deliveredUnacked(coordinator)).toEqual([])
    reg.dispose()
  })

  it('does NOT put initialPrompt on the spawn for non-argv agents — seeds the composer draft instead', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const client = sink()
    reg.modules.sessions.attachClient(client.send)
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
      initialPrompt: 'remember this',
    })
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
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'auto' as unknown as 'claude-code',
      cwd: '/proj',
    })
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code' }),
    )
    expect(reg.modules.sessions.listSessions()[0]?.agentKind).toBe('claude-code')
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
    expect(() => reg.modules.sessions.attachClient((m) => sent.push(m))).not.toThrow()
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
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.resumeSession({
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
    expect(reg.modules.sessions.listSessions().at(0)).toMatchObject({
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
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const first = reg.modules.sessions.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
    })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(first.sessionId))
    const spawnsBefore = daemon.filter((m) => m.type === 'spawn').length
    const second = reg.modules.sessions.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
    })
    expect(second.sessionId).toBe(first.sessionId)
    expect(reg.modules.sessions.listSessions()).toHaveLength(1)
    // No second durable master spawned for the same conversation.
    expect(daemon.filter((m) => m.type === 'spawn').length).toBe(spawnsBefore)
  })

  it('resume resurrects an existing HIBERNATED row for the same conversation (one row, same id)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const first = reg.modules.sessions.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
    })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(first.sessionId))
    reg.modules.sessions.hibernateSession({ sessionId: first.sessionId })
    const second = reg.modules.sessions.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
    })
    expect(second.sessionId).toBe(first.sessionId)
    expect(reg.modules.sessions.listSessions()).toHaveLength(1)
    // Reusing a parked row resurrects it (respawn under the same id).
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('starting')
  })

  it('resume keeps the original provenance on an existing row, stamps its own only on the fresh-spawn fallback (issue #60)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    // An issue-spawned session that later learned its resume ref.
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      spawnedBy: 'issue:iss_1',
    })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'r1' },
    })
    // Resuming that conversation reuses the row — the resume's own tag must NOT win.
    const reused = reg.modules.sessions.resumeSession({
      agentKind: 'claude-code',
      cwd: '/w',
      resume: { kind: 'claude-session', value: 'r1' },
      conversationId: 'c1',
      spawnedBy: 'user',
    })
    expect(reused.sessionId).toBe(sessionId)
    const metaOf = (id: string) => reg.modules.sessions.listSessions().find((s) => s.sessionId === id)
    expect(metaOf(sessionId)?.spawnedBy).toBe('issue:iss_1')
    // No existing row for this ref → fresh spawn carries the caller's tag.
    const fresh = reg.modules.sessions.resumeSession({
      agentKind: 'claude-code',
      cwd: '/w',
      resume: { kind: 'claude-session', value: 'r2' },
      conversationId: 'c2',
      spawnedBy: 'user',
    })
    expect(fresh.sessionId).not.toBe(sessionId)
    expect(metaOf(fresh.sessionId)?.spawnedBy).toBe('user')
  })

  it('resume still spawns a fresh row when no session exists for that conversation', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    reg.modules.sessions.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't1' },
      conversationId: 'c1',
    })
    reg.modules.sessions.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't2' },
      conversationId: 'c2',
    })
    expect(reg.modules.sessions.listSessions()).toHaveLength(2)
  })

  it('answers a client ping with pong (browser-level keepalive)', () => {
    const reg = new SessionRegistry()
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'ping' })
    expect(c.sent).toContainEqual({ type: 'pong' })
  })

  it('routes frames only to clients attached to that session (ISOLATION)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    const s2 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/b' }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s1))
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s2))
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId: s1, seq: 0, data: 'QQ==' })
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId: s2, seq: 0, data: 'Qg==' })
    const frames = c.sent.filter((m) => m.type === 'outputFrame')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ sessionId: s1, data: 'QQ==' })
  })

  it('replays buffered output to a client that attaches after frames were produced', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s1))
    // Frames arrive before any client attaches (e.g. a boot session, or a re-mount).
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId: s1, seq: 0, data: 'QQ==' })
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId: s1, seq: 1, data: 'Qg==' })
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'attach', sessionId: s1 })
    const frames = c.sent.filter((m) => m.type === 'outputFrame')
    expect(frames.map((f) => (f as { data: string }).data)).toEqual(['QQ==', 'Qg=='])
  })

  it('resets the replay buffer on a screen clear so replay starts from the clear', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s1))
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentFrame',
      sessionId: s1,
      seq: 0,
      data: Buffer.from('stale', 'latin1').toString('base64'),
    })
    const clearFrame = Buffer.from('\x1b[2Jfresh', 'latin1').toString('base64')
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentFrame',
      sessionId: s1,
      seq: 1,
      data: clearFrame,
    })
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'attach', sessionId: s1 })
    const frames = c.sent.filter((m) => m.type === 'outputFrame')
    expect(frames.map((f) => (f as { data: string }).data)).toEqual([clearFrame])
  })

  it('routes controller input to the daemon tagged with the right sessionId', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s1))
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.modules.sessions.onClientMessage(id, { type: 'input', sessionId: s1, data: 'eA==' })
    expect(daemon).toContainEqual({ type: 'input', sessionId: s1, data: 'eA==' })
  })

  it('takeover on one session leaves another session epoch untouched', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    const s2 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/b' }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s1))
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s2))
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.modules.sessions.onClientMessage(id, { type: 'requestControl', sessionId: s1 })
    expect(reg.modules.sessions.listSessions().find((m) => m.sessionId === s2)?.epoch).toBe(0)
  })

  it('heals a foreground resize that arrives before its viewState (quarter-size bug)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s1))
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.modules.sessions.onClientMessage(id, { type: 'presence', visible: true })
    // Real client order on a live foreground: the panel's effect fires before the
    // store's, so requestControl + the fitted resize arrive BEFORE viewState.
    reg.modules.sessions.onClientMessage(id, { type: 'requestControl', sessionId: s1 })
    reg.modules.sessions.onClientMessage(id, { type: 'resize', sessionId: s1, cols: 200, rows: 50 })
    // The viewVisible gate dropped it (the session isn't in viewState yet).
    expect(daemon).not.toContainEqual({ type: 'resize', sessionId: s1, cols: 200, rows: 50 })
    // viewState lands → the dropped size self-heals instead of sticking at 80x24.
    reg.modules.sessions.onClientMessage(id, { type: 'viewState', visible: [s1], focused: s1 })
    expect(daemon).toContainEqual({ type: 'resize', sessionId: s1, cols: 200, rows: 50 })
  })

  it('never reconciles one session viewport into another visible session', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    const s2 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/b' }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s1))
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s2))
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'attach', sessionId: s1 })
    reg.modules.sessions.onClientMessage(id, { type: 'attach', sessionId: s2 })

    // A resize for hidden s2 is remembered for s2 only. When viewState later says
    // s1 is visible, reconciliation must not apply s2's small grid to s1.
    reg.modules.sessions.onClientMessage(id, { type: 'resize', sessionId: s2, cols: 40, rows: 12 })
    reg.modules.sessions.onClientMessage(id, { type: 'viewState', visible: [s1], focused: s1 })

    expect(daemon).not.toContainEqual({ type: 'resize', sessionId: s1, cols: 40, rows: 12 })
  })

  it('kill removes the session and tells the daemon', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.modules.sessions.killSession({ sessionId: s1 })
    expect(daemon).toContainEqual({ type: 'kill', sessionId: s1 })
    expect(reg.modules.sessions.listSessions()).toHaveLength(0)
  })

  it('agentExit marks the session exited but keeps it listed', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentExit', sessionId: s1, code: 0 })
    expect(reg.modules.sessions.listSessions().find((m) => m.sessionId === s1)).toMatchObject({
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
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    archived: false,
    workState: null,
    ...over,
  })

  it('probes an exited session on boot and reattaches it when the master is alive', () => {
    const store = new SessionStore(':memory:')
    const id = 'orphan-1'
    store.sessions.upsertSession(exitedRow(id))
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    // Boot probes the exited row against the durable host.
    expect(daemon).toContainEqual(
      expect.objectContaining({ type: 'reattach', sessionId: id, durableLabel: `podium-${id}` }),
    )
    // The daemon found the master alive → bind → the session comes back live and
    // the stale exit is cleared. Without the fix it would stay 'exited' forever.
    reg.modules.sessions.onDaemonMessageFrom('local', bind(id))
    const healed = reg.modules.sessions.listSessions().find((m) => m.sessionId === id)
    expect(healed).toMatchObject({ status: 'live' })
    expect(healed?.exitCode).toBeUndefined()
  })

  it('leaves a dead exited session exited and untouched when its master is gone', () => {
    const store = new SessionStore(':memory:')
    const id = 'dead-1'
    store.sessions.upsertSession(exitedRow(id))
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', () => {})
    // The durable host has no such session → reattachFailed. An already-exited row
    // must stay put: no status change, no exitCode churn (0 → -1), no re-broadcast.
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'reattachFailed',
      sessionId: id,
      reason: 'session not found',
    })
    expect(reg.modules.sessions.listSessions().find((m) => m.sessionId === id)).toMatchObject({
      status: 'exited',
      exitCode: 0,
    })
  })

  it('does not probe an archived exited session', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession(exitedRow('arch-1', { archived: true }))
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    expect(daemon.some((m) => m.type === 'reattach' && m.sessionId === 'arch-1')).toBe(false)
  })

  it('reattaches most-recently-used sessions first', () => {
    const store = new SessionStore(':memory:')
    // Insert out of recency order to prove the order is by lastActiveAt, not insertion.
    store.sessions.upsertSession(exitedRow('mid', { lastActiveAt: '2026-03-02T00:00:00.000Z' }))
    store.sessions.upsertSession(exitedRow('newest', { lastActiveAt: '2026-03-09T00:00:00.000Z' }))
    store.sessions.upsertSession(exitedRow('oldest', { lastActiveAt: '2026-01-01T00:00:00.000Z' }))
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const order = daemon.filter((m) => m.type === 'reattach').map((m) => m.sessionId)
    expect(order).toEqual(['newest', 'mid', 'oldest'])
  })

  it('daemon disconnect drops live sessions to reconnecting so the next daemon re-binds them', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId)) // → live
    expect(reg.modules.sessions.listSessions().at(0)?.status).toBe('live')
    // Daemon-only restart: its WS closes while the server keeps running.
    reg.modules.sessions.detachDaemon('local')
    expect(reg.modules.sessions.listSessions().at(0)?.status).toBe('reconnecting')
    // A fresh daemon attaches with no bridges → it must be asked to reattach.
    const daemon2: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon2.push(m))
    expect(daemon2.some((m) => m.type === 'reattach' && m.sessionId === sessionId)).toBe(true)
  })

  it('attachClient sends welcome plus session and conversation snapshots', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'conversationsChanged',
      conversations: [{ id: 'conv-1', agentKind: 'codex', providerId: 'codex-jsonl' }],
      diagnostics: [],
    })
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    expect(c.sent).toContainEqual({ type: 'welcome', clientId: id })
    expect(c.sent.some((m) => m.type === 'sessionsChanged')).toBe(true)
    expect(c.sent).toContainEqual({
      type: 'conversationsChanged',
      // The registry enriches broadcasts with the stable podium identity.
      conversations: [
        {
          id: 'conv-1',
          agentKind: 'codex',
          providerId: 'codex-jsonl',
          podiumId: expect.stringMatching(/^conv_/),
        },
      ],
      diagnostics: [],
    })
  })

  it('broadcasts updated metas when a session gains a resume ref (resumable → hibernate)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/proj' })
    const c = sink()
    reg.modules.sessions.attachClient(c.send)
    c.sent.length = 0

    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-1' },
    })
    reg.modules.sessions.flushBroadcasts() // createSession's broadcast armed the coalescer — run the pending pipeline

    const pushed = c.sent.filter(
      (m): m is Extract<ServerMessage, { type: 'sessionsChanged' }> => m.type === 'sessionsChanged',
    )
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.at(-1)?.sessions.find((s) => s.sessionId === sessionId)?.resumable).toBe(true)
  })

  it('broadcasts daemon conversation changes to current clients', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const c = sink()
    reg.modules.sessions.attachClient(c.send)
    c.sent.length = 0

    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'conversationsChanged',
      conversations: [{ id: 'conv-2', agentKind: 'claude-code', providerId: 'claude-code-jsonl' }],
      diagnostics: [],
    })

    expect(c.sent).toEqual([
      {
        type: 'conversationsChanged',
        conversations: [
          {
            id: 'conv-2',
            agentKind: 'claude-code',
            providerId: 'claude-code-jsonl',
            podiumId: expect.stringMatching(/^conv_/),
          },
        ],
        diagnostics: [],
      },
    ])
  })

  it('scanResult updates the latest conversation snapshot and broadcasts it', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const c = sink()
    reg.modules.sessions.attachClient(c.send)
    c.sent.length = 0
    const p = reg.modules.rpc.scan()
    const req = daemon.find((m) => m.type === 'scanRequest') as { requestId: string } | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('scanRequest not sent')

    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'scanResult',
      requestId: req.requestId,
      conversations: [{ id: 'conv-3', agentKind: 'codex', providerId: 'codex-jsonl' }],
      diagnostics: [],
    })

    await expect(p).resolves.toMatchObject({ conversations: [{ id: 'conv-3' }] })
    expect(c.sent).toContainEqual({
      type: 'conversationsChanged',
      conversations: [
        {
          id: 'conv-3',
          agentKind: 'codex',
          providerId: 'codex-jsonl',
          podiumId: expect.stringMatching(/^conv_/),
        },
      ],
      diagnostics: [],
    })
  })

  it('scan correlates the daemon scanResult back to the caller', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const p = reg.modules.rpc.scan()
    const req = daemon.find((m) => m.type === 'scanRequest') as { requestId: string } | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('scanRequest not sent')
    reg.modules.sessions.onDaemonMessageFrom('local', {
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
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const p = reg.modules.rpc.scanRepos(['/home/u/src'])
    const req = daemon.find((m) => m.type === 'scanReposRequest') as
      | { requestId: string; roots: string[] }
      | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('scanReposRequest not sent')
    expect(req.roots).toEqual(['/home/u/src'])
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'scanReposResult',
      requestId: req.requestId,
      repositories: [{ path: '/r', kind: 'repository', worktrees: [] }],
      diagnostics: [],
    })
    await expect(p).resolves.toMatchObject({ repositories: [{ path: '/r' }], diagnostics: [] })
  })

  it('a daemon title updates the session and pushes sessionTitleChanged to clients', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    const c = sink()
    reg.modules.sessions.attachClient(c.send)
    c.sent.length = 0 // drop the welcome + initial sessionsChanged

    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'title', sessionId, title: '✳ rename functionality' })

    expect(c.sent).toContainEqual({
      type: 'sessionTitleChanged',
      sessionId,
      title: '✳ rename functionality',
    })
    // Not a full list rebroadcast.
    expect(c.sent.some((m) => m.type === 'sessionsChanged')).toBe(false)
    // Late joiners see it via listSessions().
    expect(reg.modules.sessions.listSessions().at(0)).toMatchObject({ sessionId, title: '✳ rename functionality' })
  })

  it('ignores a title for an unknown session', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const c = sink()
    reg.modules.sessions.attachClient(c.send)
    c.sent.length = 0
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'title', sessionId: 'nope', title: 'x' })
    expect(c.sent).toEqual([])
  })

  it('write-through: a spawned session is persisted, live/exit/title update the row', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a', title: 't' })
    expect(store.sessions.loadSessions()).toMatchObject([{ id: sessionId, status: 'starting', title: 't' }])
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    expect(store.sessions.loadSessions().at(0)).toMatchObject({ status: 'live' })
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'title', sessionId, title: '✳ working' })
    expect(store.sessions.loadSessions().at(0)).toMatchObject({ title: '✳ working' })
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentExit', sessionId, code: 0 })
    expect(store.sessions.loadSessions().at(0)).toMatchObject({ status: 'exited', exitCode: 0 })
    reg.modules.sessions.killSession({ sessionId })
    expect(store.sessions.loadSessions()).toEqual([])
  })

  it('write-through: an agentState change persists lastActiveAt so recency survives a restart', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    const future = '2999-01-01T00:00:00.000Z'
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId,
      state: { phase: 'working', since: future, openTaskCount: 0 },
    })
    expect(store.sessions.loadSessions().at(0)?.lastActiveAt).toBe(future)
  })

  it('write-through: running-shell activity persists the row (recency is durable)', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/a' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    const cid = reg.modules.sessions.attachClient(sink().send) // first client → controller
    reg.modules.sessions.onClientMessage(cid, { type: 'attach', sessionId })
    const spy = vi.spyOn(store.sessions, 'upsertSession')
    reg.modules.sessions.onClientMessage(cid, {
      type: 'input',
      sessionId,
      data: Buffer.from('ls\r').toString('base64'),
    })
    expect(reg.modules.sessions.listSessions().find((m) => m.sessionId === sessionId)?.busy).toBe(true)
    expect(spy).toHaveBeenCalled()
  })

  it('mints opaque durable session ids (uuid), not the s0 counter', () => {
    const reg = new SessionRegistry(new SessionStore(':memory:'))
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' })
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('boot reconcile: persisted live sessions reload as reconnecting and trigger reattach', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg1.modules.sessions.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
      title: 'old',
    })
    reg1.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    store1.close()

    // Restart: fresh registry over the same db.
    const store2 = new SessionStore(file)
    const reg2 = new SessionRegistry(store2)
    expect(reg2.modules.sessions.listSessions().find((m) => m.sessionId === sessionId)).toMatchObject({
      status: 'reconnecting',
      title: 'old',
      origin: { kind: 'resume', conversationId: 'c9' },
    })
    // Attaching the daemon fires a reattach for the reconnecting session.
    const control: import('@podium/protocol').ControlMessage[] = []
    reg2.modules.sessions.attachDaemon('local', (m) => control.push(m))
    expect(control).toContainEqual(
      expect.objectContaining({ type: 'reattach', sessionId, durableLabel: `podium-${sessionId}` }),
    )
    store2.close()
  })

  it('reattach success: bind on a reconnecting session makes it live', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg1.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg1.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    store1.close()
    const reg2 = new SessionRegistry(new SessionStore(file))
    reg2.modules.sessions.attachDaemon('local', () => {})
    expect(reg2.modules.sessions.listSessions().at(0)?.status).toBe('reconnecting')
    reg2.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    expect(reg2.modules.sessions.listSessions().at(0)?.status).toBe('live')
  })

  it('reattachFailed marks the session exited', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg1.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' })
    reg1.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    store1.close()
    const reg2 = new SessionRegistry(new SessionStore(file))
    reg2.modules.sessions.attachDaemon('local', () => {})
    expect(reg2.modules.sessions.listSessions().at(0)?.status).toBe('reconnecting') // handler must drive the transition
    reg2.modules.sessions.onDaemonMessageFrom('local', {
      type: 'reattachFailed',
      sessionId,
      reason: 'no tmux session',
    })
    expect(reg2.modules.sessions.listSessions().at(0)?.status).toBe('exited')
  })

  it('skips a persisted session with an invalid agentKind on load', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession({
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
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
    })
    // upsertSession now refuses an out-of-enum agentKind (write-side guard), so a
    // legacy/externally-corrupted row is simulated by writing a valid row and then
    // corrupting the persisted agent_kind directly — the exact loadFromStore scenario.
    store.sessions.upsertSession({
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
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
    })
    ;(store as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE sessions SET agent_kind = 'bogus-agent' WHERE id = 'bad'")
      .run()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = new SessionRegistry(store)
    const ids = reg.modules.sessions.listSessions().map((m) => m.sessionId)
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
    reg.modules.sessions.attachClient(a.send)
    reg.modules.sessions.attachClient(b.send)
    reg.modules.sessions.onDaemonMessageFrom('local', sample('podium-host'))
    reg.modules.sessions.onDaemonMessageFrom('local', sample('podium-host', 8)) // newer sample replaces, not appends
    const last = metricsMsgs(a.sent).at(-1)
    expect(last?.hosts).toEqual([expect.objectContaining({ hostname: 'podium-host' })])
    expect(last?.hosts[0]?.memory.availableBytes).toBe(8)
    expect(metricsMsgs(b.sent).at(-1)).toEqual(last)
  })

  it('keeps hosts side by side when several machines report', () => {
    // Per-machine model: each machine reports its own single host sample, keyed by its
    // machineId, so two distinct machines sit side by side (a SAME-machine re-report
    // replaces — see the "latest sample per host" test above).
    const store = new SessionStore(':memory:')
    store.machines.upsertMachine({ id: 'm-alpha', name: 'alpha', hostname: 'alpha', tokenHash: 'x' })
    store.machines.upsertMachine({ id: 'm-beta', name: 'beta', hostname: 'beta', tokenHash: 'y' })
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('m-alpha', () => {})
    reg.modules.sessions.attachDaemon('m-beta', () => {})
    const a = sink()
    reg.modules.sessions.attachClient(a.send)
    reg.modules.sessions.onDaemonMessageFrom('m-alpha', sample('alpha'))
    reg.modules.sessions.onDaemonMessageFrom('m-beta', sample('beta'))
    const hosts = metricsMsgs(a.sent)
      .at(-1)
      ?.hosts.map((h) => h.hostname)
    expect(hosts?.sort()).toEqual(['alpha', 'beta'])
  })

  it('snapshots current metrics to a late-joining client', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.onDaemonMessageFrom('local', sample('podium-host'))
    const late = sink()
    reg.modules.sessions.attachClient(late.send)
    expect(metricsMsgs(late.sent).at(-1)?.hosts).toEqual([
      expect.objectContaining({ hostname: 'podium-host' }),
    ])
  })

  it('clears and re-broadcasts when the daemon detaches (stale numbers never linger)', () => {
    const reg = new SessionRegistry()
    const a = sink()
    reg.modules.sessions.attachClient(a.send)
    reg.modules.sessions.attachDaemon('local', () => {})
    reg.modules.sessions.onDaemonMessageFrom('local', sample('podium-host'))
    reg.modules.sessions.detachDaemon('local')
    expect(metricsMsgs(a.sent).at(-1)?.hosts).toEqual([])
  })
})

describe('memory breakdown relay', () => {
  const memory = { totalBytes: 32, availableBytes: 16, swapTotalBytes: 0, swapFreeBytes: 0 }

  it('forwards the request to the daemon and resolves with its answer', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const pending = reg.modules.hosts.memoryBreakdown(['/src/app'])
    const req = daemon.find(
      (m): m is Extract<ControlMessage, { type: 'memoryBreakdownRequest' }> =>
        m.type === 'memoryBreakdownRequest',
    )
    expect(req?.roots).toEqual(['/src/app'])
    reg.modules.sessions.onDaemonMessageFrom('local', {
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
      reg.modules.sessions.attachDaemon('local', () => {})
      const pending = reg.modules.hosts.memoryBreakdown([])
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
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    const client = sink()
    reg.modules.sessions.attachClient(client.send)
    client.sent.length = 0
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: STATE })
    const update = client.sent.find((m) => m.type === 'sessionAgentStateChanged')
    expect(update).toEqual({ type: 'sessionAgentStateChanged', sessionId, state: STATE })
    // Hook events fire often — this must NOT re-broadcast the whole session list.
    expect(client.sent.some((m) => m.type === 'sessionsChanged')).toBe(false)
    // Late joiners still see the state via listSessions().
    expect(reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.agentState).toEqual(STATE)
  })

  it('agentState for an unknown session is ignored', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    expect(() =>
      reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentState', sessionId: 'ghost', state: STATE }),
    ).not.toThrow()
  })

  it('continueSession writes "continue\\r" to the PTY only while errored', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    // not errored yet → refused
    expect(reg.modules.sessions.continueSession({ sessionId })).toEqual({ ok: false })
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: STATE })
    expect(reg.modules.sessions.continueSession({ sessionId })).toEqual({ ok: true })
    const input = daemon.find((m) => m.type === 'input' && m.sessionId === sessionId)
    expect(input).toBeDefined()
    expect(
      Buffer.from((input as Extract<ControlMessage, { type: 'input' }>).data, 'base64').toString(
        'utf8',
      ),
    ).toBe('continue\r')
    expect(reg.modules.sessions.continueSession({ sessionId: 'ghost' })).toEqual({ ok: false })
  })

  it('sends every configured external push target only when no client is visible', () => {
    const store = new SessionStore(':memory:')
    const settings = store.settings.getSettings()
    store.settings.setSettings({
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
      reg.modules.sessions.attachDaemon('local', () => {})
      const { sessionId } = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/proj',
        title: 'keyboard',
      })
      const hidden = sink()
      const hiddenId = reg.modules.sessions.attachClient(hidden.send)
      reg.modules.sessions.onClientMessage(hiddenId, { type: 'presence', visible: false })
      hidden.sent.length = 0

      reg.modules.sessions.onDaemonMessageFrom('local', {
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
      const visibleId = reg.modules.sessions.attachClient(visible.send)
      reg.modules.sessions.onClientMessage(visibleId, { type: 'presence', visible: true })
      reg.modules.sessions.onDaemonMessageFrom('local', {
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

  it('connects Telegram from a start-code update', async () => {
    const store = new SessionStore(':memory:')
    const settings = store.settings.getSettings()
    store.settings.setSettings({
      ...settings,
      notifications: {
        ...settings.notifications,
        telegramBotToken: '123456:secret',
      },
    })
    const getMe = vi.fn().mockResolvedValue({ username: 'mwpodium_bot' })
    const getUpdates = vi.fn().mockImplementation(async () => [
      {
        updateId: 12,
        chatId: 129784115,
        chatType: 'private',
        chatLabel: 'mikewirth',
        text: '/start PODIUM123',
      },
    ])
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    try {
      const reg = new SessionRegistry(
        store,
        { ntfy: vi.fn(), telegram: vi.fn() },
        {
          telegramSetup: { getMe, getUpdates, sendMessage },
          generateTelegramSetupCode: () => 'PODIUM123',
          now: () => 1_000,
        },
      )

      const setup = await reg.modules.settings.startTelegramSetup()
      expect(setup).toEqual({
        setupId: expect.any(String),
        code: 'PODIUM123',
        botUsername: 'mwpodium_bot',
        telegramUrl: 'https://t.me/mwpodium_bot?start=PODIUM123',
        expiresAt: new Date(301_000).toISOString(),
      })

      const result = await reg.modules.settings.pollTelegramSetup(setup.setupId)

      expect(result.status).toBe('connected')
      if (result.status !== 'connected') throw new Error('expected setup to connect')
      expect(result.settings.notifications.telegramChatId).toBe('129784115')
      expect(sendMessage).toHaveBeenCalledWith(
        { botToken: '123456:secret', chatId: '129784115' },
        expect.stringContaining('Telegram notifications are connected'),
      )
    } finally {
      store.close()
    }
  })

  it('sends a catch-up Telegram push when Telegram is enabled for an existing attention session', () => {
    const store = new SessionStore(':memory:')
    const ntfy = vi.fn()
    const telegram = vi.fn()

    try {
      const reg = new SessionRegistry(store, { ntfy, telegram })
      reg.modules.sessions.attachDaemon('local', () => {})
      const { sessionId } = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/proj',
        title: 'keyboard',
      })
      const visible = sink()
      const visibleId = reg.modules.sessions.attachClient(visible.send)
      reg.modules.sessions.onClientMessage(visibleId, { type: 'presence', visible: true })

      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentState',
        sessionId,
        state: {
          phase: 'needs_user',
          since: '2026-06-12T10:00:00.000Z',
          openTaskCount: 0,
          need: { kind: 'question', summary: 'SQLite or Postgres?' },
        },
      })

      expect(telegram).not.toHaveBeenCalled()

      const settings = reg.modules.settings.getSettings()
      reg.modules.settings.setSettings({
        ...settings,
        notifications: {
          ...settings.notifications,
          telegramBotToken: '123456:secret',
          telegramChatId: '-100123',
        },
      })

      expect(telegram).toHaveBeenCalledWith(
        { botToken: '123456:secret', chatId: '-100123' },
        { title: 'keyboard needs you', body: 'SQLite or Postgres?' },
      )
      expect(ntfy).not.toHaveBeenCalled()

      telegram.mockClear()
      const updated = reg.modules.settings.getSettings()
      reg.modules.settings.setSettings({
        ...updated,
        notifications: {
          ...updated.notifications,
          web: false,
        },
      })

      expect(telegram).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })
})

describe('structured transcript channel', () => {
  it('replays nothing on an empty subscribe, then streams live deltas', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const client = sink()
    const clientId = reg.modules.sessions.attachClient(client.send)
    // Empty cache → subscribe sends no replay delta (NOT a snapshot/reset — the
    // client loads its history off disk via transcriptRead, not the stream).
    reg.modules.sessions.onClientMessage(clientId, { type: 'transcriptSubscribe', sessionId })
    expect(client.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([])

    const item = { id: 'u1', role: 'user' as const, text: 'hi', cursor: 'c1' }
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'transcriptDelta',
      sessionId,
      items: [item],
      tail: 'c1',
    })
    expect(client.sent).toContainEqual({
      type: 'transcriptDelta',
      sessionId,
      items: [item],
      tail: 'c1',
    })

    // A reset delta (tailer switched files) clears the cache and fans out reset:true.
    const item2 = { id: 'u2', role: 'user' as const, text: 'again', cursor: 'c2' }
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'transcriptDelta',
      sessionId,
      items: [item2],
      reset: true,
    })
    expect(client.sent.at(-1)).toEqual({
      type: 'transcriptDelta',
      sessionId,
      items: [item2],
      reset: true,
    })
  })

  it('replays only cached items after `since`, and the whole cache when since is unknown', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    // Seed the recent-delta cache via live deltas.
    const a = { id: 'a', role: 'user' as const, text: 'a', cursor: 'c1' }
    const b = { id: 'b', role: 'assistant' as const, text: 'b', cursor: 'c2' }
    const c = { id: 'c', role: 'user' as const, text: 'c', cursor: 'c3' }
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'transcriptDelta',
      sessionId,
      items: [a, b, c],
      tail: 'c3',
    })

    // since=c1 → replay strictly after it (b, c).
    const known = sink()
    const knownId = reg.modules.sessions.attachClient(known.send)
    reg.modules.sessions.onClientMessage(knownId, { type: 'transcriptSubscribe', sessionId, since: 'c1' })
    expect(known.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([
      { type: 'transcriptDelta', sessionId, items: [b, c] },
    ])

    // since unknown to the cache → replay the whole cache (client cursor-dedups).
    const stale = sink()
    const staleId = reg.modules.sessions.attachClient(stale.send)
    reg.modules.sessions.onClientMessage(staleId, { type: 'transcriptSubscribe', sessionId, since: 'c0-older' })
    expect(stale.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([
      { type: 'transcriptDelta', sessionId, items: [a, b, c] },
    ])

    // since = the newest cached cursor → nothing after it, send nothing.
    const caught = sink()
    const caughtId = reg.modules.sessions.attachClient(caught.send)
    reg.modules.sessions.onClientMessage(caughtId, { type: 'transcriptSubscribe', sessionId, since: 'c3' })
    expect(caught.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([])
  })

  it('a subscriber needs no PTY attachment, and unsubscribe stops the stream', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const client = sink()
    const clientId = reg.modules.sessions.attachClient(client.send)
    reg.modules.sessions.onClientMessage(clientId, { type: 'transcriptSubscribe', sessionId })
    reg.modules.sessions.onClientMessage(clientId, { type: 'transcriptUnsubscribe', sessionId })
    // Count transcript-stream frames only: the first delta flips the session's
    // transcriptAvailable flag, which broadcasts a sessionsChanged to every
    // client (subscribed or not) — that capability flip is not a stream frame.
    const frames = () => client.sent.filter((m) => m.type === 'transcriptDelta').length
    const before = frames()
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'transcriptDelta',
      sessionId,
      items: [{ id: 'x', role: 'user', text: 'unseen', cursor: 'cx' }],
    })
    expect(frames()).toBe(before)
  })

  it('a daemon transcriptDelta drives the Claude first-prompt title', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const client = sink()
    reg.modules.sessions.attachClient(client.send)
    reg.modules.sessions.onDaemonMessageFrom('local', {
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
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    // A live, bound session whose recent-delta cache is empty (e.g. right after a
    // server restart). The OLD code short-circuited and returned [] without ever
    // asking the daemon — the core bug. The new code MUST round-trip to disk.
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))

    const p = reg.modules.rpc.readTranscript({ sessionId, direction: 'before', limit: 50 })
    const req = daemon.find((m) => m.type === 'transcriptRead') as
      | { requestId: string; direction: string; limit: number; sessionId: string }
      | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('transcriptRead not sent — short-circuit regression')
    expect(req.direction).toBe('before')
    expect(req.limit).toBe(50)
    expect(req.sessionId).toBe(sessionId)

    const items = [{ id: 'd1', role: 'user' as const, text: 'from disk', cursor: 'c1' }]
    reg.modules.sessions.onDaemonMessageFrom('local', {
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
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.resumeSession({
      agentKind: 'codex',
      cwd: '/repo',
      resume: { kind: 'codex-rollout', value: '/r/rollout.jsonl' },
      conversationId: 'conv-1',
    })

    const p = reg.modules.rpc.readTranscript({
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

    reg.modules.sessions.onDaemonMessageFrom('local', {
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
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    await expect(
      reg.modules.rpc.readTranscript({ sessionId: 'nope', direction: 'before', limit: 10 }),
    ).resolves.toEqual({ items: [], hasMore: false })
    expect(daemon.find((m) => m.type === 'transcriptRead')).toBeUndefined()
  })
})

describe('sendText (chat send path)', () => {
  const readInputs = (daemon: ControlMessage[]): string[] =>
    daemon
      .filter((m) => m.type === 'input')
      .map((m) => Buffer.from((m as { data: string }).data, 'base64').toString())

  it('wraps single-line text in bracketed paste, then submits with a DELAYED CR', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
      reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
      expect(reg.modules.sessions.sendText({ sessionId, text: 'run the tests' })).toEqual({ ok: true })
      // The paste block goes out immediately; the submitting CR is DEFERRED so it
      // lands in a separate PTY read — a CR fused to the paste-end marker is swallowed
      // by the new Claude renderer, so the message types in but the turn never starts.
      expect(readInputs(daemon)).toEqual(['\x1b[200~run the tests\x1b[201~'])
      vi.advanceTimersByTime(100)
      expect(readInputs(daemon)).toEqual(['\x1b[200~run the tests\x1b[201~', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('wraps multi-line text in bracketed paste, then submits with a DELAYED CR', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
      reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
      reg.modules.sessions.sendText({ sessionId, text: 'a\nb' })
      vi.advanceTimersByTime(100)
      expect(readInputs(daemon)).toEqual(['\x1b[200~a\nb\x1b[201~', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses for exited sessions', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentExit', sessionId, code: 0 })
    expect(reg.modules.sessions.sendText({ sessionId, text: 'hello?' })).toEqual({ ok: false })
  })
})

describe('queueText drain (resume/spawn readiness — #5b, durable queue)', () => {
  const inputsOf = (daemon: ControlMessage[]): string =>
    daemon
      .filter((m) => m.type === 'input')
      .map((m) => Buffer.from((m as { data: string }).data, 'base64').toString())
      .join('')

  it('waits for the spawned TUI to produce output AND settle before delivering', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/w' })
      reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId)) // -> live
      reg.modules.sessions.queueText({ sessionId, text: 'deferred-msg' })

      // The TUI is still drawing: an output frame every poll for ~2s.
      let seq = 0
      for (let i = 0; i < 10; i += 1) {
        reg.modules.sessions.onDaemonMessageFrom('local', {
          type: 'agentFrame',
          sessionId,
          seq: seq++,
          data: 'eA==',
        })
        vi.advanceTimersByTime(200)
      }
      // Output is still recent → NOT delivered (this is what the fix prevents:
      // sending on 'live' alone would have fired immediately into the booting TUI).
      expect(inputsOf(daemon)).not.toContain('deferred-msg')

      // Output goes quiet → after the quiet+floor window it delivers (the bracketed
      // paste block contains the text).
      vi.advanceTimersByTime(1200)
      expect(inputsOf(daemon)).toContain('deferred-msg')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not deliver while the session is still starting (not yet live)', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/w' }) // 'starting'
      reg.modules.sessions.queueText({ sessionId, text: 'too-early' })
      vi.advanceTimersByTime(5000)
      expect(inputsOf(daemon)).not.toContain('too-early')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to delivering a silent spawn after the max settle window', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry()
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/w' })
      reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId)) // live, but never emits output
      reg.modules.sessions.queueText({ sessionId, text: 'silent-msg' })
      vi.advanceTimersByTime(5000)
      expect(inputsOf(daemon)).not.toContain('silent-msg') // still within the max window
      vi.advanceTimersByTime(2000)
      expect(inputsOf(daemon)).toContain('silent-msg') // delivered after the fallback
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('hibernation', () => {
  function liveSession(reg: SessionRegistry, daemon: ControlMessage[]) {
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'abc-123' },
    })
    return sessionId
  }

  it('does not write the DB on every output frame — coalesces to the flush', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)
    const spy = vi.spyOn(store.sessions, 'upsertSession')
    for (let i = 0; i < 50; i++) {
      reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId, seq: i, data: 'eA==' })
    }
    const duringFrames = spy.mock.calls.length
    reg.modules.sessions.flushActivity()
    expect(spy.mock.calls.length - duringFrames).toBeLessThanOrEqual(1) // one write at flush
    expect(duringFrames).toBe(0) // zero writes during the 50 frames
  })

  it('dispose stops the periodic flush timer (no DB write after shutdown) and is idempotent', () => {
    vi.useFakeTimers()
    try {
      const store = new SessionStore(':memory:')
      const reg = new SessionRegistry(store)
      const daemon: ControlMessage[] = []
      reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
      const sessionId = liveSession(reg, daemon)
      // Mark the session dirty so a timer tick WOULD persist it if the timer still ran.
      reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId, seq: 0, data: 'eA==' })
      reg.dispose()
      // Calling dispose twice must be safe (graceful-shutdown path may double-fire).
      reg.dispose()
      const spy = vi.spyOn(store.sessions, 'upsertSession')
      // Advance well past the 12s flush interval — the timer is cleared, so nothing fires.
      vi.advanceTimersByTime(60_000)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('seeds activity counters from the DB on a fresh registry (survives restart)', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId, seq: 0, data: 'eA==' })
    reg.modules.sessions.flushActivity()
    // New registry on the SAME store — simulates a restart.
    const reg2 = new SessionRegistry(store)
    // biome-ignore lint/suspicious/noExplicitAny: inspect the rehydrated session
    const seeded = (reg2 as any).modules.sessions.sessions.get(sessionId)
    expect(seeded.lastOutputAtMs).toBeGreaterThan(0)
  })

  it('hibernate kills the process, keeps the row, survives the agentExit echo', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)

    expect(reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
    expect(daemon).toContainEqual({ type: 'kill', sessionId })
    expect(reg.modules.sessions.listSessions()[0]).toMatchObject({ sessionId, status: 'hibernated' })
    // The daemon's kill produces an exit — it must not flip hibernated → exited.
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentExit', sessionId, code: 0 })
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('hibernated')
  })

  it('refuses to hibernate a session with no resume ref (would be a kill)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    expect(reg.modules.sessions.hibernateSession({ sessionId }).ok).toBe(false)
  })

  it('resurrect respawns under the same id with the resume ref', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)
    reg.modules.sessions.hibernateSession({ sessionId })
    daemon.length = 0

    expect(reg.modules.sessions.resurrectSession({ sessionId })).toEqual({ ok: true })
    expect(daemon).toContainEqual(
      expect.objectContaining({
        type: 'spawn',
        sessionId,
        resume: { kind: 'claude-session', value: 'abc-123' },
      }),
    )
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('starting')
  })

  it('resurrect revives an exited (crashed) session with a resume ref', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)
    // The process dies out from under us (crash / external kill).
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentExit', sessionId, code: 0 })
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('exited')
    daemon.length = 0

    expect(reg.modules.sessions.resurrectSession({ sessionId })).toEqual({ ok: true })
    expect(daemon).toContainEqual(
      expect.objectContaining({
        type: 'spawn',
        sessionId,
        resume: { kind: 'claude-session', value: 'abc-123' },
      }),
    )
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('starting')
  })

  it('restarts an exited shell fresh in the same cwd — no resume ref needed', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentExit', sessionId, code: 137 })
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('exited')
    daemon.length = 0

    expect(reg.modules.sessions.resurrectSession({ sessionId })).toEqual({ ok: true })
    const spawn = daemon.find((m) => m.type === 'spawn')
    expect(spawn).toMatchObject({ sessionId, agentKind: 'shell', cwd: '/w' })
    expect(spawn && 'resume' in spawn ? spawn.resume : undefined).toBeUndefined()
  })

  it('refuses to resurrect a live session', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const sessionId = liveSession(reg, daemon)
    expect(reg.modules.sessions.resurrectSession({ sessionId }).ok).toBe(false)
  })

  it('auto-hibernates the oldest idle resumable session above the memory threshold', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const settings = store.settings.getSettings()
    store.settings.setSettings({
      ...settings,
      hibernation: { enabled: true, memoryPct: 80, idleMinutes: 1 },
    })
    const sessionId = liveSession(reg, daemon)
    // Mark the agent idle, with activity old enough to pass the idle cutoff.
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId,
      state: {
        phase: 'idle',
        since: '2026-06-12T00:00:00.000Z',
        openTaskCount: 0,
        idle: { kind: 'done' },
      },
    })
    const session = reg.modules.sessions.listSessions()[0]
    expect(session?.agentState?.phase).toBe('idle')
    // agentState bumps lastActiveAt to now — rewind it via the store round-trip.
    // (The idle cutoff compares lastActiveAt; simulate an hour of silence.)
    // biome-ignore lint/suspicious/noExplicitAny: test reaches into the private map on purpose
    const internal = (reg as any).modules.sessions.sessions.get(sessionId)
    internal.lastActiveAt = new Date(Date.now() - 3_600_000).toISOString()

    reg.modules.sessions.onDaemonMessageFrom('local', {
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
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('hibernated')
  })

  it('does not re-hibernate a session that was just resurrected (resume resets the idle timer)', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    store.settings.setSettings({
      ...store.settings.getSettings(),
      hibernation: { enabled: true, memoryPct: 80, idleMinutes: 1 },
    })
    const sessionId = liveSession(reg, daemon)
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId,
      state: {
        phase: 'idle',
        since: '2026-06-12T00:00:00.000Z',
        openTaskCount: 0,
        idle: { kind: 'done' },
      },
    })
    // biome-ignore lint/suspicious/noExplicitAny: reach into the private map on purpose
    const internal = (reg as any).modules.sessions.sessions.get(sessionId)
    internal.lastActiveAt = new Date(Date.now() - 3_600_000).toISOString()
    reg.modules.sessions.hibernateSession({ sessionId })
    reg.modules.sessions.resurrectSession({ sessionId })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId)) // respawn binds → live
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'hostMetrics',
      hostname: 'box',
      sampledAt: new Date().toISOString(),
      memory: { totalBytes: 100, availableBytes: 10, swapTotalBytes: 0, swapFreeBytes: 0 },
    })
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('live')
  })

  it('keeps a session awake when the user typed recently, even with no agent activity', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    store.settings.setSettings({
      ...store.settings.getSettings(),
      hibernation: { enabled: true, memoryPct: 80, idleMinutes: 1 },
    })
    const sessionId = liveSession(reg, daemon)
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId,
      state: {
        phase: 'idle',
        since: '2026-06-12T00:00:00.000Z',
        openTaskCount: 0,
        idle: { kind: 'done' },
      },
    })
    // biome-ignore lint/suspicious/noExplicitAny: reach into the private map on purpose
    const internal = (reg as any).modules.sessions.sessions.get(sessionId)
    internal.lastActiveAt = new Date(Date.now() - 3_600_000).toISOString()
    // Controller types just now — recent input must veto hibernation.
    const c = sink()
    const idC = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(idC, { type: 'attach', sessionId })
    reg.modules.sessions.onClientMessage(idC, { type: 'input', sessionId, data: 'eA==' })
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'hostMetrics',
      hostname: 'box',
      sampledAt: new Date().toISOString(),
      memory: { totalBytes: 100, availableBytes: 10, swapTotalBytes: 0, swapFreeBytes: 0 },
    })
    expect(reg.modules.sessions.listSessions()[0]?.status).toBe('live')
  })
})

describe('reconnect identity (hello reclaim)', () => {
  const VP = { cols: 80, rows: 24, dpr: 1 }

  it('a reconnecting client reclaims its prior controller role and evicts the stale one', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    reg.modules.sessions.onDaemonMessageFrom('local', bind(s1))

    // First socket: attaches and becomes controller; its input flows.
    const a = sink()
    const idA = reg.modules.sessions.attachClient(a.send)
    reg.modules.sessions.onClientMessage(idA, { type: 'attach', sessionId: s1 })
    reg.modules.sessions.onClientMessage(idA, { type: 'input', sessionId: s1, data: 'eA==' })
    expect(daemon).toContainEqual({ type: 'input', sessionId: s1, data: 'eA==' })

    // The socket goes half-open; a new socket connects and re-presents idA in hello,
    // then re-attaches the way the client does on reconnect.
    const b = sink()
    const idB = reg.modules.sessions.attachClient(b.send)
    reg.modules.sessions.onClientMessage(idB, { type: 'hello', clientId: idA, viewport: VP })
    reg.modules.sessions.onClientMessage(idB, { type: 'attach', sessionId: s1 })

    daemon.length = 0
    // B now drives input (it inherited control)...
    reg.modules.sessions.onClientMessage(idB, { type: 'input', sessionId: s1, data: 'eQ==' })
    expect(daemon).toContainEqual({ type: 'input', sessionId: s1, data: 'eQ==' })
    // ...and the stale A is gone: its messages are dropped, not honored.
    reg.modules.sessions.onClientMessage(idA, { type: 'input', sessionId: s1, data: 'eg==' })
    expect(daemon).not.toContainEqual({ type: 'input', sessionId: s1, data: 'eg==' })
  })

  it('hello with an unknown prior id is a harmless no-op', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    expect(() =>
      reg.modules.sessions.onClientMessage(id, { type: 'hello', clientId: 'c-stale-gone', viewport: VP }),
    ).not.toThrow()
  })

  describe('session draft sync', () => {
    it('broadcasts setSessionDraft to other clients, not the sender', () => {
      const reg = new SessionRegistry()
      const a: ServerMessage[] = []
      const b: ServerMessage[] = []
      const idA = reg.modules.sessions.attachClient((m) => a.push(m))
      reg.modules.sessions.attachClient((m) => b.push(m))
      reg.modules.sessions.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: 'half typed' })
      expect(a.filter((m) => m.type === 'sessionDraftChanged')).toEqual([])
      expect(b).toContainEqual({
        type: 'sessionDraftChanged',
        sessionId: 'sess',
        text: 'half typed',
      })
    })

    it('replays stored drafts to a freshly connected client', () => {
      const reg = new SessionRegistry()
      const idA = reg.modules.sessions.attachClient(() => {})
      reg.modules.sessions.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: 'wip' })
      const c: ServerMessage[] = []
      reg.modules.sessions.attachClient((m) => c.push(m))
      expect(c).toContainEqual({ type: 'sessionDraftChanged', sessionId: 'sess', text: 'wip' })
    })

    it('clears a draft when text is empty', () => {
      const reg = new SessionRegistry()
      const idA = reg.modules.sessions.attachClient(() => {})
      reg.modules.sessions.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: 'wip' })
      reg.modules.sessions.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: '' })
      const c: ServerMessage[] = []
      reg.modules.sessions.attachClient((m) => c.push(m))
      expect(c.filter((m) => m.type === 'sessionDraftChanged')).toEqual([])
    })

    it('persists a draft (debounced) across a server restart and replays it', () => {
      vi.useFakeTimers()
      try {
        const dir = mkdtempSync(join(tmpdir(), 'podium-draft-'))
        const dbPath = join(dir, 'podium.db')
        const store = new SessionStore(dbPath)
        const reg = new SessionRegistry(store)
        const idA = reg.modules.sessions.attachClient(() => {})
        reg.modules.sessions.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: 'real work' })
        // Not written yet — keystrokes coalesce; the row appears once the debounce fires.
        expect(store.sessions.loadDrafts().sess).toBeUndefined()
        vi.advanceTimersByTime(1000)
        expect(store.sessions.loadDrafts().sess).toBe('real work')
        store.close()

        // "Restart": a fresh registry on the same DB replays the persisted draft
        // to the first client to connect (issue #34: survives a full reload).
        const store2 = new SessionStore(dbPath)
        const reg2 = new SessionRegistry(store2)
        const c: ServerMessage[] = []
        reg2.modules.sessions.attachClient((m) => c.push(m))
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
        const idA = reg.modules.sessions.attachClient(() => {})
        reg.modules.sessions.onClientMessage(idA, {
          type: 'setSessionDraft',
          sessionId: 'sess',
          text: 'about to send',
        })
        reg.modules.sessions.onClientMessage(idA, { type: 'setSessionDraft', sessionId: 'sess', text: '' })
        // No debounce wait: an empty draft flushes at once so a restart right after
        // a send never restores stale text.
        expect(store.sessions.loadDrafts().sess).toBeUndefined()
        store.close()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('SessionRegistry read state (#124)', () => {
  it('a fresh session is unread; markSessionRead clears it and persists across reload', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))

    const before = reg.modules.sessions.listSessions()[0]
    expect(before?.readAt).toBeNull()
    expect(before?.unread).toBe(true)

    reg.modules.sessions.markSessionRead(sessionId)
    const after = reg.modules.sessions.listSessions()[0]
    expect(after?.readAt).not.toBeNull()
    expect(after?.unread).toBe(false)

    // read_at is durable — a fresh registry over the same store reads it back.
    const reg2 = new SessionRegistry(store)
    expect(reg2.modules.sessions.listSessions()[0]?.readAt).toBe(after?.readAt)
    reg.dispose()
    reg2.dispose()
  })

  it('markSessionRead broadcasts a fresh sessionsChanged marking it read', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    const c = sink()
    reg.modules.sessions.attachClient(c.send)
    c.sent.length = 0

    reg.modules.sessions.markSessionRead(sessionId)
    reg.modules.sessions.flushBroadcasts()

    const pushed = c.sent.filter(
      (m): m is Extract<ServerMessage, { type: 'sessionsChanged' }> => m.type === 'sessionsChanged',
    )
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.at(-1)?.sessions.find((s) => s.sessionId === sessionId)?.unread).toBe(false)
    reg.dispose()
  })

  it('markSessionUnread nulls readAt so the session re-reads as unread + broadcasts (#138)', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    reg.modules.sessions.markSessionRead(sessionId)
    expect(reg.modules.sessions.listSessions()[0]?.unread).toBe(false)

    const c = sink()
    reg.modules.sessions.attachClient(c.send)
    c.sent.length = 0
    reg.modules.sessions.markSessionUnread(sessionId)
    reg.modules.sessions.flushBroadcasts()

    const after = reg.modules.sessions.listSessions()[0]
    expect(after?.readAt).toBeNull()
    expect(after?.unread).toBe(true)
    // Durable: a fresh registry over the same store reads readAt back as null.
    const reg2 = new SessionRegistry(store)
    expect(reg2.modules.sessions.listSessions()[0]?.readAt).toBeNull()
    // And the change was broadcast to clients.
    const pushed = c.sent.filter(
      (m): m is Extract<ServerMessage, { type: 'sessionsChanged' }> => m.type === 'sessionsChanged',
    )
    expect(pushed.at(-1)?.sessions.find((s) => s.sessionId === sessionId)?.unread).toBe(true)
    reg.dispose()
    reg2.dispose()
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
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))

    reg.modules.sessions.setSnooze({ sessionId, until: null })
    expect(reg.sessionStore.sessions.listSnoozes()).toEqual({ [sessionId]: null })
    expect(reg.modules.sessions.listSessions()[0]?.snoozedUntil).toBeNull()

    reg.modules.sessions.clearSnooze(sessionId)
    expect(reg.sessionStore.sessions.listSnoozes()).toEqual({})
    expect('snoozedUntil' in (reg.modules.sessions.listSessions()[0] ?? {})).toBe(false)
  })

  it('a submitted prompt (sendText) clears the snooze', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    reg.modules.sessions.setSnooze({ sessionId, until: null })

    reg.modules.sessions.sendText({ sessionId, text: 'hi' })
    expect(reg.sessionStore.sessions.listSnoozes()).toEqual({})
  })

  it('leaving the attention phase clears it; staying in attention keeps it', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    reg.modules.sessions.onDaemonMessageFrom(
      'local',
      agentState(sessionId, 'needs_user', { need: { kind: 'question' } }),
    )
    reg.modules.sessions.setSnooze({ sessionId, until: null })

    // needs_user -> idle/question is still attention: snooze survives.
    reg.modules.sessions.onDaemonMessageFrom('local', agentState(sessionId, 'idle', { idle: { kind: 'question' } }))
    expect(reg.sessionStore.sessions.listSnoozes()).toEqual({ [sessionId]: null })

    // -> working leaves attention: snooze clears.
    reg.modules.sessions.onDaemonMessageFrom('local', agentState(sessionId, 'working'))
    expect(reg.sessionStore.sessions.listSnoozes()).toEqual({})
  })

  it('seeds snoozedUntil from the store at load', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession({
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
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      archived: false,
      workState: null,
    })
    store.sessions.setSnooze('s1', null)
    const reg = new SessionRegistry(store)
    expect(reg.modules.sessions.listSessions()[0]?.snoozedUntil).toBeNull()
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
    const s = reg.modules.settings.getSettings()
    reg.modules.settings.setSettings({ ...s, autoContinue: { enabled: true, promptDismissed: false } })
  }

  // A session must exist (createSession) and be marked live (bind) before agentState
  // does anything — `bind` only marks an already-registered session live, it does not
  // create the row. continueSession's status gate then accepts the live session.
  function liveSession(reg: SessionRegistry): string {
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    return sessionId
  }

  it('does NOT auto-send continue when the setting is off', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const sessionId = liveSession(reg)
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: erroredState })
    expect(daemon).not.toContainEqual(continueInput)
    reg.modules.settings.setSettings({
      ...reg.modules.settings.getSettings(),
      autoContinue: { enabled: false, promptDismissed: false },
    })
  })

  it('auto-sends continue when an enabled session hits a retryable error', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    enableAutoContinue(reg)
    const sessionId = liveSession(reg)
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: erroredState })
    expect(daemon).toContainEqual(continueInput)
    // Cancel the live loop so no real backoff timer dangles past the test.
    reg.modules.settings.setSettings({
      ...reg.modules.settings.getSettings(),
      autoContinue: { enabled: false, promptDismissed: false },
    })
  })

  it('arms already-errored sessions when the setting is switched on', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const sessionId = liveSession(reg)
    reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: erroredState })
    expect(daemon).not.toContainEqual(continueInput) // off → silent so far
    enableAutoContinue(reg)
    expect(daemon).toContainEqual(continueInput) // flipping on arms the errored session
    reg.modules.settings.setSettings({
      ...reg.modules.settings.getSettings(),
      autoContinue: { enabled: false, promptDismissed: false },
    })
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
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    daemon.length = 0 // drop the spawn + daemon-connect priority push

    reg.modules.sessions.onClientMessage(id, { type: 'viewState', visible: [sessionId], focused: sessionId })
    // Focused beats visible/attached: tier 0.
    expect(priorities(daemon)).toContainEqual({ type: 'sessionPriority', sessionId, priority: 0 })
  })

  it('stores the rendered-mode map from a viewState message on the client (available, not used for scheduling)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)

    reg.modules.sessions.onClientMessage(id, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
      modes: { [sessionId]: 'chat' },
    })
    const client = (reg as any).modules.sessions.clients.get(id)
    expect(client.viewModes).toEqual({ [sessionId]: 'chat' })
  })

  it('defaults viewModes to {} when a viewState omits modes (backward compatible)', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)

    // First set a mode, then send a modes-less viewState — it must reset, not retain.
    reg.modules.sessions.onClientMessage(id, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
      modes: { [sessionId]: 'native' },
    })
    reg.modules.sessions.onClientMessage(id, { type: 'viewState', visible: [sessionId], focused: sessionId })
    const client = (reg as any).modules.sessions.clients.get(id)
    expect(client.viewModes).toEqual({})
  })

  it('a fresh client starts with empty viewModes', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    expect((reg as any).modules.sessions.clients.get(id).viewModes).toEqual({})
  })

  it('computes per-session priority across ALL sessions (clients iterable is materialized, not exhausted)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    // Two sessions: the second would wrongly read as tier 3 if the clients iterator
    // were single-use (it exhausts after the first session) — the array-materialize
    // guard is what keeps this correct.
    const s1 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/a' }).sessionId
    const s2 = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/b' }).sessionId
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    daemon.length = 0

    reg.modules.sessions.onClientMessage(id, { type: 'viewState', visible: [s1, s2], focused: s2 })
    const sent = priorities(daemon)
    expect(sent).toContainEqual({ type: 'sessionPriority', sessionId: s1, priority: 1 }) // visible
    expect(sent).toContainEqual({ type: 'sessionPriority', sessionId: s2, priority: 0 }) // focused
  })

  it('only CHANGED sessions are re-pushed (deltas, not the whole map every time)', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)

    reg.modules.sessions.onClientMessage(id, { type: 'viewState', visible: [sessionId], focused: sessionId })
    daemon.length = 0
    // An identical viewState changes nothing → no re-send.
    reg.modules.sessions.onClientMessage(id, { type: 'viewState', visible: [sessionId], focused: sessionId })
    expect(priorities(daemon)).toEqual([])
  })

  it('a fresh daemon (re)connect gets the current priority of every live session', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'viewState', visible: [sessionId], focused: sessionId })
    // The daemon drops; a fresh one attaches — it knows no priorities, so the full
    // current map must be re-pushed (lastPriority.clear() + pushPriorities()).
    reg.modules.sessions.detachDaemon('local')
    const daemon2: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon2.push(m))
    expect(priorities(daemon2)).toContainEqual({
      type: 'sessionPriority',
      sessionId,
      priority: 0,
    })
  })

  it('agentFrameBatch unpacks into one outputFrame broadcast per coalesced frame', () => {
    const reg = new SessionRegistry()
    reg.modules.sessions.attachDaemon('local', () => {})
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    reg.modules.sessions.onDaemonMessageFrom('local', bind(sessionId))
    const c = sink()
    const id = reg.modules.sessions.attachClient(c.send)
    reg.modules.sessions.onClientMessage(id, { type: 'attach', sessionId })
    c.sent.length = 0

    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentFrameBatch',
      sessionId,
      frames: ['ZDE=', 'ZDI='],
    })
    const frames = c.sent.filter(
      (m): m is Extract<ServerMessage, { type: 'outputFrame' }> => m.type === 'outputFrame',
    )
    // Each coalesced frame becomes its own outputFrame, in order, each with its own
    // server-assigned seq — clients are unaffected by the daemon's coalescing.
    expect(frames.map((f) => f.data)).toEqual(['ZDE=', 'ZDI='])
    expect(frames.map((f) => f.seq)).toEqual([0, 1])
  })
})

describe('listDir routing', () => {
  it('routes listDir to the worktree machine and resolves entries', async () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('local', (m) => daemon.push(m))

    const p = reg.modules.rpc.listDir({ machineId: 'local', root: '/w', path: '/w' })
    const req = daemon.find((m) => m.type === 'dirListRequest') as
      | { requestId: string; path: string }
      | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('dirListRequest not sent')

    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'dirListResult',
      requestId: req.requestId,
      ok: true,
      path: req.path,
      entries: [{ name: 'src', isDir: true }],
    })

    const r = await p
    expect(r.ok).toBe(true)
    expect(r.entries).toEqual([{ name: 'src', isDir: true }])
  })
})
