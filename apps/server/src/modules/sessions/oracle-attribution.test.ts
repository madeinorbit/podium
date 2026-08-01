/**
 * ORACLE — attribution stamped by session writes (POD-379 for POD-312).
 *
 * Under §3.1.3 A3 attribution becomes a PAIR: actor (which agent) AND
 * on-behalf-of (which human), both taken from the authenticated transport
 * principal, never from payload. This file records which fields exist TODAY and
 * what each one holds, so the migration can show exactly which fields grow a
 * second half, which are replaced, and which are absent and must be added.
 *
 * The single-valued fields recorded here — `spawnedBy`, `nameSource`,
 * `deletion_source`, `stopReason`, `inputOrigin`, `humanQuestionAskedBy` — are
 * all ROLE-level or DEVICE-level today. None of them names a person, because
 * there are no people in the model (docs/multi-user-readiness.md §3.2).
 */

import { FIRST_ADMIN_USER_ID, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, MUST_NOT_CHANGE, makeOracle, willChange } from './oracle-support'

afterEach(() => disposeOracles())

const NO_PERSON = willChange(
  'POD-1075',
  'attribution becomes (actor, on-behalf-of); today no field names a person',
)

describe('oracle: who created this session', () => {
  it('tRPC creation stamps user provenance and durable human ownership', async () => {
    const o = makeOracle()

    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    expect(o.meta(sessionId).spawnedBy).toBe('user')
    expect(o.store.sessions.loadSessions().find((r) => r.id === sessionId)).toMatchObject({
      spawnedBy: 'user',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
  })

  it(`${NO_PERSON}: a resume through the tRPC seam stamps 'user' on its fresh-spawn fallback`, async () => {
    const o = makeOracle()

    const { sessionId } = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: { kind: 'claude-session', value: 'n1' },
      conversationId: 'n1',
    })

    expect(o.meta(sessionId).spawnedBy).toBe('user')
  })

  it(`${MUST_NOT_CHANGE}: an agent-spawned child is stamped 'session:<parent>' — the actor half already exists, from the capability`, async () => {
    const o = makeOracle()
    const issue = o.reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/a' })
    const parent = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })

    const spawned = await o.relay({
      requestId: 'spawn-child',
      sessionId: parent.sessionId,
      router: 'messages',
      proc: 'spawnAgent',
      input: { issue: issue.id, harness: 'shell', prompt: 'do the thing' },
    })

    expect(spawned.ok).toBe(true)
    const childId = (spawned.result as { sessionId: SessionId }).sessionId
    // Actor = the calling session, resolved from the relay capability. There is
    // no second field recording WHICH HUMAN that agent is acting for.
    expect(o.meta(childId).spawnedBy).toBe(`session:${parent.sessionId}`)
  })
})

describe('oracle: who named this session', () => {
  it(`${NO_PERSON}: nameSource records the CLASS of writer ('user' | 'agent'), never which user or which agent`, async () => {
    const o = makeOracle()
    const issue = o.reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/a' })
    const agent = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })
    const human = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.relay({
      requestId: 'self-title',
      sessionId: agent.sessionId,
      router: 'sessions',
      proc: 'title',
      input: { name: 'named by me' },
    })
    await o.call.sessions.rename({ sessionId: human.sessionId, name: 'named by the operator' })

    expect(o.meta(agent.sessionId).nameSource).toBe('agent')
    expect(o.meta(human.sessionId).nameSource).toBe('user')
    // Two different agents would both stamp the identical 'agent' — the actor
    // half of the pair is NOT recorded on the row.
    const rows = o.store.sessions.loadSessions()
    expect(rows.map((r) => r.nameSource).sort()).toEqual(['agent', 'user'])
  })
})

describe('oracle: who ended this session', () => {
  it(`${NO_PERSON}: a kill records deletion_source 'standalone' — the CAUSE class, with no actor at all`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.kill({ sessionId })

    const tombstone = o.store.sessions.loadDeletedSessions().find((r) => r.id === sessionId)
    expect(tombstone?.deletionSource).toBe('standalone')
    expect(tombstone?.deletedByIssueId).toBeNull()
  })

  it(`${NO_PERSON}: archive's park records stopReason 'parent' — again a cause, not an actor`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame('local', {
      type: 'bind',
      sessionId,
      cmd: 'bash',
      cwd: '/p',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })

    await o.call.sessions.setArchived({ sessionId, archived: true })

    expect(o.store.sessions.loadSessions().find((r) => r.id === sessionId)?.stopReason).toBe(
      'parent',
    )
  })
})

describe('oracle: who typed into this session', () => {
  it(`${NO_PERSON}: PTY frames carry inputOrigin — 'human' for a direct keystroke path, 'mail' for a substrate send`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame('local', {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    o.reg.gateway.routeDaemonFrame('local', {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    o.daemon.length = 0

    await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [1] }] })
    await o.call.sessions.sendText({ sessionId, text: 'via the substrate' })

    const origins = o.daemon
      .filter((m): m is Extract<ControlMessage, { type: 'input' }> => m.type === 'input')
      .map((m) => m.inputOrigin)
    // Both are the SAME operator; the field distinguishes the PATH, not the person.
    expect(origins).toEqual(['human', 'mail'])
  })
})

describe('oracle: who asked the human a question', () => {
  it(`${NO_PERSON}: humanQuestionAskedBy is stamped from the transport principal, and an agent cannot attribute a question to another session`, async () => {
    const o = makeOracle()
    const issue = o.reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/a' })
    const agent = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
      issueId: issue.id,
    })

    const asked = await o.relay({
      requestId: 'needs-human',
      sessionId: agent.sessionId,
      router: 'issues',
      proc: 'setNeedsHuman',
      input: { id: issue.id, question: 'which way?' },
    })
    expect(asked.ok).toBe(true)

    // Stamped from the capability's actorSessionId — a bare session id, and the
    // only attribution the answer-routing path has to work with.
    expect(o.reg.issues.getMeta(issue.id)?.humanQuestionAskedBy).toBe(agent.sessionId)

    // Payload identity is inert (ADR 3 D7): claiming to be someone else is refused.
    const spoofed = await o.relay({
      requestId: 'needs-human-spoof',
      sessionId: agent.sessionId,
      router: 'issues',
      proc: 'setNeedsHuman',
      input: { id: issue.id, question: 'and now?', askedBy: 'some-other-session' },
    })
    expect(spoofed.ok).toBe(false)
    expect(spoofed.error).toBe(
      'askedBy is server-authoritative: agents may only attribute a question to their own session (omit askedBy)',
    )
  })
})

describe('oracle: who moved this session between machines', () => {
  it('handoff preserves the durable per-user session owner', async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })

    const row = o.store.sessions.loadSessions().find((r) => r.id === sessionId)
    // Handoff changes placement without changing the durable human owner.
    expect(row?.ownerUserId).toBe(FIRST_ADMIN_USER_ID)
    expect(
      Object.keys(row ?? {})
        .filter((k) => /source|by|actor|owner|user/i.test(k))
        .sort(),
    ).toEqual(['deletedByIssueId', 'deletionSource', 'nameSource', 'ownerUserId', 'spawnedBy'])
  })
})
