/**
 * ORACLE — command-class session writes (POD-379 for POD-312 / POD-381).
 *
 * create · resume · kill · hibernate · resurrect · sendText · resumeAndSend ·
 * answerAskUserQuestion · continue.
 *
 * These are the writes that command a PROCESS, so what is pinned here is the
 * control message that reaches the daemon, its ORDER, the refusal REASONS
 * (returned, not thrown, for the lifecycle primitives), and what survives in
 * the durable row. See oracle-support.ts for the tag contract.
 */

import type { ControlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, MUST_NOT_CHANGE, makeOracle, waitFor, willChange } from './oracle-support'

afterEach(() => disposeOracles())

const RESUME = { kind: 'claude-session', value: 'native-1' } as const

const inputs = (daemon: ControlMessage[]) =>
  daemon.filter((m): m is Extract<ControlMessage, { type: 'input' }> => m.type === 'input')

/** Bind a created session as a live agent with a known resume ref and phase. */
function goLive(
  o: ReturnType<typeof makeOracle>,
  sessionId: string,
  phase: 'idle' | 'working' = 'idle',
): void {
  o.reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/p',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  o.reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'sessionResumeRef',
    sessionId,
    resume: RESUME,
    confidence: 'exact',
  })
  o.reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'agentState',
    sessionId,
    state: { phase, since: new Date().toISOString(), nativeSubagentCount: 0 },
  })
}

describe('oracle: create', () => {
  it(`${MUST_NOT_CHANGE}: create spawns on the daemon, persists the row, and returns the id the client may have chosen`, async () => {
    const o = makeOracle()
    const clientId = '11111111-1111-4111-8111-111111111111'

    const { sessionId } = await o.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/p',
      sessionId: clientId,
    })

    expect(sessionId).toBe(clientId)
    expect(o.daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/p' }),
    )
    expect(o.store.sessions.loadSessions().map((r) => r.id)).toEqual([clientId])
  })

  it(`${MUST_NOT_CHANGE}: a non-uuid client sessionId is refused before it can reach the durable-label / scope path`, async () => {
    const o = makeOracle()

    await expect(
      o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p', sessionId: '../../evil' }),
    ).rejects.toThrow()
    expect(o.store.sessions.loadSessions()).toEqual([])
  })

  it(`${willChange('POD-1079', "machines become owned compute; 'use' defaults to the owner only")}: placement is ambient — any authenticated caller may spawn on any paired machine`, async () => {
    const o = makeOracle()
    // A second paired machine nobody "owns": there is no owner column today.
    o.store.machines.upsertMachine({ id: 'other', name: 'other', hostname: 'o', tokenHash: 'x' })
    const other: ControlMessage[] = []
    o.reg.modules.sessions.attachDaemon('other', (m) => other.push(m))

    const { sessionId } = await o.call.sessions.create({
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'other',
    })

    expect(other).toContainEqual(expect.objectContaining({ type: 'spawn', sessionId }))
    expect(o.daemon.filter((m) => m.type === 'spawn')).toHaveLength(0)
    expect(o.meta(sessionId).machineId).toBe('other')
  })
})

describe('oracle: resume', () => {
  it(`${MUST_NOT_CHANGE}: a resume with no matching row spawns a fresh session carrying the resume ref`, async () => {
    const o = makeOracle()

    const { sessionId } = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: RESUME,
      conversationId: 'native-1',
    })

    expect(o.daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, resume: RESUME }),
    )
    expect(o.meta(sessionId).resume).toEqual(RESUME)
  })

  it(`${MUST_NOT_CHANGE}: resuming an EXISTING row reuses it instead of minting a second session`, async () => {
    const o = makeOracle()
    const first = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: RESUME,
      conversationId: 'native-1',
    })

    const second = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: RESUME,
      conversationId: 'native-1',
    })

    expect(second.sessionId).toBe(first.sessionId)
    expect(o.reg.modules.sessions.listSessions()).toHaveLength(1)
  })
})

describe('oracle: hibernate', () => {
  it(`${MUST_NOT_CHANGE}: hibernate parks a live session — status flips and the daemon is told to kill the process`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)

    expect(await o.call.sessions.hibernate({ sessionId })).toEqual({ ok: true })

    expect(o.meta(sessionId).status).toBe('hibernated')
    expect(o.daemon).toContainEqual(expect.objectContaining({ type: 'kill', sessionId }))
    expect(o.store.sessions.loadSessions().find((r) => r.id === sessionId)?.status).toBe(
      'hibernated',
    )
  })

  it(`${MUST_NOT_CHANGE}: hibernate REFUSES with a reason (never a throw) when the session is not running`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    o.reg.modules.sessions.onDaemonMessageFrom('local', { type: 'agentExit', sessionId, code: 0 })

    expect(await o.call.sessions.hibernate({ sessionId })).toEqual({
      ok: false,
      reason: 'not running',
    })
  })

  it(`${MUST_NOT_CHANGE}: hibernate refuses a live session with no resume ref — parking it would lose the conversation`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    o.reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })

    const refused = await o.call.sessions.hibernate({ sessionId })

    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('no resume ref yet — the agent has not reported one')
    expect(o.meta(sessionId).status).toBe('live')
  })

  it(`${MUST_NOT_CHANGE}: hibernate refuses a WORKING agent so an in-flight turn is never killed`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId, 'working')

    expect(await o.call.sessions.hibernate({ sessionId })).toEqual({
      ok: false,
      reason: 'agent is working — let it reach idle first',
    })
    expect(o.meta(sessionId).status).toBe('live')
  })
})

describe('oracle: resurrect', () => {
  it(`${MUST_NOT_CHANGE}: resurrect respawns a parked session with its resume ref and moves it to 'starting'`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    expect(await o.call.sessions.resurrect({ sessionId })).toEqual({ ok: true })

    expect(o.meta(sessionId).status).toBe('starting')
    expect(o.daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, resume: RESUME }),
    )
  })

  it(`${MUST_NOT_CHANGE}: resurrect refuses a still-running session with a reason`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)

    expect(await o.call.sessions.resurrect({ sessionId })).toEqual({
      ok: false,
      reason: 'process still running',
    })
  })

  it(`${MUST_NOT_CHANGE}: an exited AGENT with no resume ref cannot be resurrected; a shell can (a fresh spawn IS its recovery)`, async () => {
    const o = makeOracle()
    const agent = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    o.reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentExit',
      sessionId: agent.sessionId,
      code: 1,
    })
    const shell = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    o.reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentExit',
      sessionId: shell.sessionId,
      code: 1,
    })

    expect(await o.call.sessions.resurrect({ sessionId: agent.sessionId })).toEqual({
      ok: false,
      reason: 'no resume ref',
    })
    expect(await o.call.sessions.resurrect({ sessionId: shell.sessionId })).toEqual({ ok: true })
  })
})

describe('oracle: kill', () => {
  it(`${MUST_NOT_CHANGE}: kill tombstones the row with deletion_source 'standalone' and removes it from the live list`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    goLive(o, sessionId)

    await o.call.sessions.kill({ sessionId })

    expect(o.reg.modules.sessions.listSessions()).toEqual([])
    expect(o.store.sessions.loadSessions()).toEqual([])
    const tombstone = o.store.sessions.loadDeletedSessions().find((r) => r.id === sessionId)
    expect(tombstone?.deletionSource).toBe('standalone')
    expect(typeof tombstone?.deletedAt).toBe('string')
    expect(tombstone?.deletedByIssueId).toBeNull()
  })

  it(`${MUST_NOT_CHANGE}: kill signals the owning daemon and publishes the removal to clients`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    goLive(o, sessionId)

    await o.call.sessions.kill({ sessionId })

    expect(o.daemon).toContainEqual(expect.objectContaining({ type: 'kill', sessionId }))
    await waitFor(
      () =>
        o.client.some(
          (m) => m.type === 'sessionsChanged' && !m.sessions.some((s) => s.sessionId === sessionId),
        ),
      'the removal to reach the attached client',
    )
  })
})

describe('oracle: sendText / resumeAndSend', () => {
  it(`${MUST_NOT_CHANGE}: sendText to a live session reports a disposition and reaches the PTY stamped 'mail' (the unified substrate), not 'human'`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    const result = await o.call.sessions.sendText({ sessionId, text: 'hello there' })

    expect(result.ok).toBe(true)
    expect(typeof result.disposition).toBe('string')
    await waitFor(() => inputs(o.daemon).length > 0, 'the text to reach the PTY')
    // Operator chat sends ride the messaging substrate (#237), so the PTY frame
    // carries inputOrigin 'mail' — NOT 'human'. Only the direct keystroke paths
    // (answerAskUserQuestion below) stamp 'human'. The distinction is what the
    // actor / on-behalf-of split in POD-312 has to preserve or replace.
    expect(inputs(o.daemon).map((m) => m.inputOrigin)).toEqual(['mail'])
    expect(
      inputs(o.daemon)
        .map((m) => Buffer.from(m.data, 'base64').toString())
        .join(''),
    ).toContain('hello there')
  })

  it(`${MUST_NOT_CHANGE}: sendText bypasses controller gating — a chat send is an explicit user act, not a competing keyboard`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    // Another client holds control; the chat send must still land.
    o.reg.modules.sessions.attachClient(() => {})
    o.daemon.length = 0

    expect((await o.call.sessions.sendText({ sessionId, text: 'still lands' })).ok).toBe(true)
    await waitFor(() => inputs(o.daemon).length > 0, 'the gated-around send to reach the PTY')
  })

  it(`${MUST_NOT_CHANGE}: resumeAndSend wakes a PARKED session (the send is not dropped)`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    const result = await o.call.sessions.resumeAndSend({ sessionId, text: 'wake up' })

    expect(result.ok).toBe(true)
    await waitFor(
      () => o.daemon.some((m) => m.type === 'spawn' && m.sessionId === sessionId),
      'the wake spawn to be dispatched',
    )
    expect(o.meta(sessionId).status).toBe('starting')
  })
})

describe('oracle: answerAskUserQuestion', () => {
  it(`${MUST_NOT_CHANGE}: a single-select answer types the bare option digit (no Enter)`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    expect(
      await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [2] }] }),
    ).toEqual({ ok: true })

    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual(['2'])
    expect(inputs(o.daemon).map((m) => m.inputOrigin)).toEqual(['human'])
  })

  it(`${MUST_NOT_CHANGE}: a multi-select answer types comma-separated indices AND a carriage return to confirm`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [1, 3] }] })

    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual(['1,3\r'])
  })

  it(`${MUST_NOT_CHANGE}: a multi-question payload is typed in order, one keystroke batch per question`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    await o.call.sessions.answerAskUserQuestion({
      sessionId,
      choices: [{ optionIndices: [1] }, { optionIndices: [2, 3] }],
    })

    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual([
      '1',
      '2,3\r',
    ])
  })

  it(`${MUST_NOT_CHANGE}: answering a session that is not live is refused with ok:false and types nothing`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    expect(
      await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [1] }] }),
    ).toEqual({ ok: false })
    expect(inputs(o.daemon)).toEqual([])
  })
})
