/**
 * THE SESSION COMMAND PLANE ON THE ONE WRITE PATH (POD-6416, plan Task 16).
 *
 * Driven through the REAL composed server (`makeOracle`):
 *
 *  - `sessions.continue` is registered on the sync write entry point and every
 *    transport reaches it there: `sync.submit`, its old tRPC route and the
 *    agent relay, each with provenance and a receipt; the target check runs
 *    before the handler (and before the dedup, so a replay is checked again);
 *    a shell's keystroke waits for the commit.
 *  - `sessions.setIssueId` is on `sync.submit` only: its route is gone.
 *  - The lifecycle, create and interrupt routes act only through the path:
 *    none of them calls the service from inside the request.
 */

import { asMutationId, asSessionId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appRouter } from '../../router'
import { OPERATOR } from '../../test-support/capabilities'
import { confirmingRetirement } from '../../test-support/host-daemon'
import { envelope, expectAppliedOnPath, rowsOf, submit } from '../sync-write/outbox-test-support'
import { sessionCommandCtx } from './command-ctx'
import { dispatchSessionCommand } from './command-plane'
import { disposeOracles, makeOracle, type Oracle } from './oracle-support'

afterEach(() => disposeOracles())

const ERRORED = {
  phase: 'errored' as const,
  since: '2026-11-05T10:00:00.000Z',
  nativeSubagentCount: 0,
  error: { class: 'rate_limit', retryable: true },
}

const routerRecord = (name: string): Record<string, unknown> =>
  (appRouter as unknown as { _def: { record: Record<string, Record<string, unknown>> } })._def
    .record[name] ?? {}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

async function bindLive(
  o: Oracle,
  sessionId: SessionId,
  agentKind: 'claude-code' | 'shell',
  cwd: string,
): Promise<void> {
  const machineId = o.reg.sessionStore.hostMachineId
  await o.reg.gateway.routeDaemonFrame(machineId, {
    type: 'bind',
    sessionId,
    cmd: agentKind === 'shell' ? 'bash' : 'claude',
    cwd,
    agentKind,
    geometry: { cols: 80, rows: 24 },
  })
  if (agentKind !== 'shell') {
    await o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: `native-${sessionId}` },
      confidence: 'exact',
    })
  }
}

async function errored(o: Oracle, sessionId: SessionId): Promise<void> {
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'agentState',
    sessionId,
    state: ERRORED,
  })
}

/** An agent session, live and errored: a `continue` has something to retry. */
async function erroredAgent(o: Oracle, cwd = '/p'): Promise<SessionId> {
  const { sessionId } = await o.reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd,
  })
  await bindLive(o, sessionId, 'claude-code', cwd)
  await errored(o, sessionId)
  return sessionId
}

const durableSends = (daemon: ControlMessage[], sessionId: SessionId) =>
  daemon.filter((m) => m.type === 'runtimeDurableSendRequest' && m.sessionId === sessionId)

const keystrokes = (daemon: ControlMessage[], sessionId: SessionId) =>
  daemon.filter(
    (m): m is Extract<ControlMessage, { type: 'input' }> =>
      m.type === 'input' &&
      m.sessionId === sessionId &&
      Buffer.from(m.data, 'base64').toString('utf8') === 'continue\r',
  )

/** Two issues, each with its own worktree under the reported repo `/r`. */
async function twoIssues(o: Oracle) {
  await o.store.repos.addRepo('/r', o.store.hostMachineId)
  const a = await o.reg.issues.crud.create(o.reg.issues.reports.store.serverWriter, { repoPath: '/r', title: 'A', startNow: false })
  await o.reg.issues.crud.update(o.reg.issues.reports.store.serverWriter, a.id, { worktreePath: '/r/.worktrees/a' })
  const b = await o.reg.issues.crud.create(o.reg.issues.reports.store.serverWriter, { repoPath: '/r', title: 'B', startNow: false })
  await o.reg.issues.crud.update(o.reg.issues.reports.store.serverWriter, b.id, { worktreePath: '/r/.worktrees/b' })
  return { a, b }
}

describe('sessions.continue is on the sync write entry point', () => {
  it('arrives through sync.submit with provenance and a receipt at the head; a replay runs nothing', async () => {
    const o = await makeOracle()
    const sessionId = await erroredAgent(o)

    const { result } = await expectAppliedOnPath(
      o,
      envelope('sessions.continue', { sessionId }, 'm-continue-1'),
      // The `continue` is a stored message, which is not a change-log entity
      // (like a chat send's); its dedup record is what the replay is answered from.
      { writes: false },
    )
    expect(await o.store.sync.getAppliedMutation(asMutationId('m-continue-1'))).toBeDefined()

    expect(result).toEqual({ ok: true })
    await vi.waitFor(() => expect(durableSends(o.daemon, sessionId)).toHaveLength(1))
    await settle()
    // The replay inside expectAppliedOnPath sent nothing more.
    expect(durableSends(o.daemon, sessionId)).toHaveLength(1)
  })

  it('its old tRPC route is an adapter onto the entry point', async () => {
    const o = await makeOracle()
    const sessionId = await erroredAgent(o)

    const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    expect(await o.call.sessions.continue({ sessionId })).toEqual({ ok: true })

    expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'sessions.continue', input: { sessionId } }),
      expect.anything(),
      'trpc',
    )
    // An absent session keeps its pinned bare refusal (POD-379).
    expect(await o.call.sessions.continue({ sessionId: asSessionId('ghost') })).toEqual({
      ok: false,
    })
  })

  it('the relay arm goes through the entry point as the calling agent', async () => {
    const o = await makeOracle()
    await twoIssues(o)
    const caller = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })
    const target = await erroredAgent(o, '/r/.worktrees/a')
    const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    const reply = await o.relay({
      requestId: 'continue-sibling',
      sessionId: caller.sessionId,
      router: 'sessions',
      proc: 'continue',
      input: { sessionId: target },
    })

    expect(reply).toMatchObject({ ok: true, result: { ok: true } })
    // As the calling agent, over the relay transport, with a relay-minted id.
    const call = submitted.mock.calls.find(([env]) => env.command === 'sessions.continue')
    expect(call?.[0].mutationId).toMatch(/^mut_relay_/)
    expect(call?.[1]).toMatchObject({ kind: 'agent', agentSessionId: caller.sessionId })
    expect(call?.[2]).toBe('relay')
    await vi.waitFor(() => expect(durableSends(o.daemon, target)).toHaveLength(1))
  })

  it('a session outside the agent scope is refused before the handler; --outside-scope confirms it', async () => {
    const o = await makeOracle()
    await twoIssues(o)
    const caller = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })
    const outside = await erroredAgent(o, '/r/.worktrees/b')
    const continueSession = vi.spyOn(o.reg.modules.sessions, 'continueSession')

    const refused = await o.relay({
      requestId: 'continue-outside',
      sessionId: caller.sessionId,
      router: 'sessions',
      proc: 'continue',
      input: { sessionId: outside, mutationId: 'm-outside' },
    })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/outside your scope/)
    expect(continueSession).not.toHaveBeenCalled()

    const confirmed = await o.relay({
      requestId: 'continue-outside-confirmed',
      sessionId: caller.sessionId,
      router: 'sessions',
      proc: 'continue',
      input: { sessionId: outside, mutationId: 'm-outside' },
      outsideScope: true,
    })
    expect(confirmed).toMatchObject({ ok: true, result: { ok: true } })
    expect(continueSession).toHaveBeenCalledTimes(1)

    // The target check runs before the dedup: the recorded write replayed
    // WITHOUT the confirmation is refused again, and runs nothing.
    const replay = await o.relay({
      requestId: 'continue-outside-replay',
      sessionId: caller.sessionId,
      router: 'sessions',
      proc: 'continue',
      input: { sessionId: outside, mutationId: 'm-outside' },
    })
    expect(replay.ok).toBe(false)
    expect(continueSession).toHaveBeenCalledTimes(1)
  })

  it("a shell's keystroke waits for the commit: a rollback types nothing, a commit types once", async () => {
    const o = await makeOracle()
    const { sessionId } = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/p',
    })
    await bindLive(o, sessionId, 'shell', '/p')
    await errored(o, sessionId)
    const plane = async () =>
      await dispatchSessionCommand(
        await sessionCommandCtx(o.reg.modules, OPERATOR, false, 'trpc'),
        'continue',
        { sessionId },
      )

    await expect(
      o.store.transact(async () => {
        expect(await plane()).toEqual({ ok: true })
        throw new Error('forced rollback')
      }),
    ).rejects.toThrow('forced rollback')
    await settle()
    expect(keystrokes(o.daemon, sessionId)).toHaveLength(0)

    await o.store.transact(async () => {
      expect(await plane()).toEqual({ ok: true })
      // Inside the unit nothing is typed yet.
      expect(keystrokes(o.daemon, sessionId)).toHaveLength(0)
    })
    await vi.waitFor(() => expect(keystrokes(o.daemon, sessionId)).toHaveLength(1))
    await settle()
    expect(keystrokes(o.daemon, sessionId)).toHaveLength(1)
  })
})

describe('the relay chat sends are on the sync write entry point (POD-6591)', () => {
  /** An agent in issue A, and a shell to send to in issue A or B. */
  async function caller(o: Oracle) {
    const issues = await twoIssues(o)
    const { sessionId } = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })
    return { ...issues, caller: sessionId }
  }

  async function shellIn(o: Oracle, cwd: string): Promise<SessionId> {
    return (await o.reg.modules.sessions.createSession({ agentKind: 'shell', cwd })).sessionId
  }

  for (const proc of ['sendText', 'resumeAndSend'] as const) {
    it(`${proc}: as the calling agent, under the CLI's message id; a replay runs nothing`, async () => {
      const o = await makeOracle()
      const { caller: agent } = await caller(o)
      const target = await shellIn(o, '/r/.worktrees/a')
      const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
      const id =
        proc === 'sendText'
          ? 'msg_00000000-0000-4000-8000-000000006591'
          : 'msg_00000000-0000-4000-8000-000000006592'
      const send = async (requestId: string) =>
        await o.relay({
          requestId,
          sessionId: agent,
          router: 'sessions',
          proc,
          input: { sessionId: target, text: 'over the path', mutationId: id },
        })

      expect(await send(`${proc}-1`)).toMatchObject({ ok: true, result: { ok: true } })
      const call = submitted.mock.calls.find(([env]) => env.command === `sessions.${proc}`)
      expect(call?.[0]).toMatchObject({ mutationId: id })
      expect(call?.[0].confirmed).toBeUndefined()
      expect(call?.[1]).toMatchObject({ kind: 'agent', agentSessionId: agent })
      expect(call?.[2]).toBe('relay')
      expect(await o.store.sync.getAppliedMutation(asMutationId(id))).toBeDefined()
      expect(await o.store.messages.getMessage(id)).not.toBeNull()

      const mailSend = vi.spyOn(o.reg.modules.messageGate, 'dispatch')
      expect(await send(`${proc}-2`)).toMatchObject({ ok: true, result: { ok: true } })
      const replay = (await submitted.mock.results.at(-1)?.value) as {
        reply: { outcome: string; replayed?: boolean }
      }
      expect(replay.reply).toMatchObject({ outcome: 'applied', replayed: true })
      expect(mailSend).not.toHaveBeenCalled()
    })
  }

  it("a send outside the agent's scope is refused in the plane's words; --outside-scope confirms it", async () => {
    const o = await makeOracle()
    const { caller: agent, b } = await caller(o)
    const outside = await shellIn(o, '/r/.worktrees/b')
    const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const id = 'msg_00000000-0000-4000-8000-000000006593'
    const send = async (requestId: string, outsideScope?: true) =>
      await o.relay({
        requestId,
        sessionId: agent,
        router: 'sessions',
        proc: 'sendText',
        input: { sessionId: outside, text: 'across issues', mutationId: id },
        ...(outsideScope ? { outsideScope } : {}),
      })

    const refused = await send('send-outside')
    expect(refused.ok).toBe(false)
    expect(refused.error).toBe(
      `issue ${b.id} is outside your subtree; re-run with --outside-scope to confirm`,
    )
    expect(await o.store.messages.getMessage(id)).toBeNull()
    expect(await o.store.sync.getAppliedMutation(asMutationId(id))).toBeUndefined()

    expect(await send('send-outside-confirmed', true)).toMatchObject({
      ok: true,
      result: { ok: true },
    })
    expect(submitted.mock.calls.at(-1)?.[0]).toMatchObject({ mutationId: id, confirmed: true })
    expect(await o.store.messages.getMessage(id)).not.toBeNull()

    // The target check runs before the dedup: the recorded send replayed
    // WITHOUT the confirmation is refused again, in the same words.
    const replay = await send('send-outside-replay')
    expect(replay.ok).toBe(false)
    expect(replay.error).toMatch(/outside your subtree/)
  })

  it("an issueless session is refused in the plane's words, and --outside-scope does not substitute", async () => {
    const o = await makeOracle()
    const { caller: agent } = await caller(o)
    const issueless = await shellIn(o, '/nowhere/unrelated')
    const id = 'msg_00000000-0000-4000-8000-000000006594'

    for (const outsideScope of [false, true]) {
      const reply = await o.relay({
        requestId: `send-issueless-${outsideScope}`,
        sessionId: agent,
        router: 'sessions',
        proc: 'sendText',
        input: { sessionId: issueless, text: 'hello?', mutationId: id },
        ...(outsideScope ? { outsideScope } : {}),
      })
      expect(reply).toMatchObject({
        ok: false,
        error: 'target session has no issue; only its parent or the operator may message it',
      })
    }
    expect(await o.store.messages.getMessage(id)).toBeNull()
  })
})

describe('sessions.setIssueId is on sync.submit only', () => {
  it('has no tRPC route: no shipped client ever called one', () => {
    expect(routerRecord('sessions').setIssueId).toBeUndefined()
  })

  it('attaches with provenance and a receipt; a replay returns its result and changes nothing', async () => {
    const o = await makeOracle()
    await o.store.repos.addRepo('/p', o.store.hostMachineId)
    const issue = await o.reg.issues.crud.create(o.reg.issues.reports.store.serverWriter, { repoPath: '/p', title: 't', startNow: false })
    const { sessionId } = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/scratch',
    })

    await expectAppliedOnPath(
      o,
      envelope('sessions.setIssueId', { sessionId, issueId: issue.id }, 'm-attach'),
      { writes: true },
    )

    expect((await o.meta(sessionId)).issueId).toBe(issue.id)
    const rows = await rowsOf(o, 'm-attach')
    expect(rows.some((row) => row.entity === 'session' && row.entityId === sessionId)).toBe(true)
  })

  it('an unknown session is refused before the handler', async () => {
    const o = await makeOracle()
    const setSessionIssueId = vi.spyOn(o.reg.modules.sessions, 'setSessionIssueId')

    const reply = await submit(
      o,
      envelope('sessions.setIssueId', { sessionId: 'ghost', issueId: null }, 'm-ghost'),
    )

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(setSessionIssueId).not.toHaveBeenCalled()
  })
})

describe('the lifecycle routes act only through the path', () => {
  async function liveAgent(o: Oracle): Promise<SessionId> {
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await bindLive(o, sessionId, 'claude-code', '/p')
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    return sessionId
  }

  it('a stop while the machine is offline answers pending and calls no service; the reconnect stops it once', async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    const machineId = o.reg.sessionStore.hostMachineId
    const stopSession = vi.spyOn(o.reg.modules.issueSessionLifecycle, 'stopSession')
    o.reg.gateway.detachDaemon(machineId)

    expect(await o.call.sessions.stop({ sessionId })).toMatchObject({ ok: true, pending: true })
    expect(stopSession).not.toHaveBeenCalled()
    const state = await o.reg.modules.sessions.desiredStateOf(sessionId)
    expect(state?.lifecycle).toMatchObject({ desired: 'stopped' })
    expect(state?.lifecycle.observedRevision).toBeLessThan(state?.lifecycle.revision ?? 0)

    await o.reg.gateway.attachDaemon(
      machineId,
      confirmingRetirement(o.reg, machineId, (msg: ControlMessage) => {
        o.daemon.push(msg)
      }),
    )
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledTimes(1))
    await vi.waitFor(async () => {
      const after = await o.reg.modules.sessions.desiredStateOf(sessionId)
      expect(after?.lifecycle.observedRevision).toBe(after?.lifecycle.revision)
    })
    expect(stopSession).toHaveBeenCalledTimes(1)
  })

  it('a resume of a running session is answered from the record, with no service call', async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    const resurrectSession = vi.spyOn(o.reg.modules.issueSessionLifecycle, 'resurrectSession')

    expect(await o.call.sessions.resurrect({ sessionId })).toEqual({ ok: true })
    expect(resurrectSession).not.toHaveBeenCalled()
  })

  it('kill removes the record through the path and never calls killSession from the route', async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    const removes = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    await expect(o.call.sessions.kill({ sessionId })).resolves.toBeUndefined()

    expect(removes.mock.calls.map(([env]) => env.command)).toContain('records.session.remove')
    expect(await o.reg.modules.sessions.desiredStateOf(sessionId)).toBeUndefined()
  })
})

describe('create and interrupt never act from inside the request', () => {
  it('create with no daemon attached refuses at once and starts nothing', async () => {
    const o = await makeOracle()
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    const createSession = vi.spyOn(o.reg.modules.sessions, 'createSession')

    await expect(o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })).rejects.toThrow(
      'no machine is online',
    )
    expect(createSession).not.toHaveBeenCalled()
  })

  it('an interrupt named by a prefix goes through a session.interrupt record for the full id', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await bindLive(o, sessionId, 'claude-code', '/p')
    const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    await o.call.sessions.interrupt({ sessionId: asSessionId(sessionId.slice(0, 8)) })

    const effect = submitted.mock.calls
      .map(([env]) => env)
      .find((env) => env.command === 'effects.create')
    expect(effect?.input).toMatchObject({
      kind: 'session.interrupt',
      target: { kind: 'session', id: sessionId },
    })
  })
})

describe('configure and resume act through effect records', () => {
  /** The `effects.create` envelopes submitted while `spy` watched. */
  const effectCreates = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls
      .map(
        ([env]) => env as { command: string; mutationId: string; input: Record<string, unknown> },
      )
      .filter((env) => env.command === 'effects.create')

  it('configure: a rollback asks the driver nothing; the route asks it once, after the commit', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await bindLive(o, sessionId, 'claude-code', '/p')
    const configureSession = vi
      .spyOn(o.reg.modules.sessions, 'configureSession')
      .mockResolvedValue({ ok: true, effective: 'next-turn' })

    // A record whose unit rolls back never runs. (`sync.submit` refuses to
    // open inside a unit, so the record is inserted as its handler would.)
    await expect(
      o.store.transact(async () => {
        await o.store.effects.insert(
          fixtureWriteScope(),
          {
            id: 'eff_configure-rolled-back',
            kind: 'session.configure',
            target: { kind: 'session', id: sessionId },
            input: { model: 'opus' },
            deadlineAt: undefined,
            createdBy: null,
          },
          Date.now(),
        )
        throw new Error('forced rollback')
      }),
    ).rejects.toThrow('forced rollback')
    await settle()
    expect(await o.store.effects.get('eff_configure-rolled-back')).toBeUndefined()
    expect(configureSession).not.toHaveBeenCalled()

    // The route, by a prefix: one record for the full id, one driver call.
    const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    expect(
      await o.call.sessions.configure({
        sessionId: asSessionId(sessionId.slice(0, 8)),
        model: 'opus',
      }),
    ).toEqual({ ok: true, effective: 'next-turn' })
    const [created] = effectCreates(submitted)
    expect(created?.input).toMatchObject({
      kind: 'session.configure',
      target: { kind: 'session', id: sessionId },
      input: { model: 'opus' },
    })
    expect(configureSession).toHaveBeenCalledTimes(1)
    expect(configureSession).toHaveBeenCalledWith({ sessionId, model: 'opus' })
    const record = await o.store.effects.get(created?.input.id as string)
    expect(record).toMatchObject({ kind: 'session.configure', status: 'succeeded' })
    await settle()
    expect(configureSession).toHaveBeenCalledTimes(1)
  })

  it("configure: the driver's refusal comes back in the route's shape", async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await bindLive(o, sessionId, 'claude-code', '/p')
    vi.spyOn(o.reg.modules.sessions, 'configureSession').mockResolvedValue({
      reason: 'unsupported',
      detail: 'this harness cannot change its model while it runs',
    })

    expect(await o.call.sessions.configure({ sessionId, effort: 'high' })).toEqual({
      reason: 'unsupported',
      detail: 'this harness cannot change its model while it runs',
    })
  })

  it('resume: a session.launch record carries the resume ref; the running row is reused, once', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await bindLive(o, sessionId, 'claude-code', '/p')
    const resumeSession = vi.spyOn(o.reg.modules.issueSessionLifecycle, 'resumeSession')
    const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const input = {
      agentKind: 'claude-code' as const,
      cwd: '/p',
      resume: { kind: 'claude-session', value: `native-${sessionId}` },
      conversationId: `native-${sessionId}`,
    }

    expect(await o.call.sessions.resume(input)).toEqual({ sessionId })

    const [created] = effectCreates(submitted)
    expect(created?.input).toMatchObject({
      kind: 'session.launch',
      input: { resume: input.resume, conversationId: input.conversationId },
    })
    expect(resumeSession).toHaveBeenCalledTimes(1)
    expect(await o.store.effects.get(created?.input.id as string)).toMatchObject({
      status: 'succeeded',
    })
  })

  it('resume: a rollback spawns nothing', async () => {
    const o = await makeOracle()
    const resumeSession = vi.spyOn(o.reg.modules.issueSessionLifecycle, 'resumeSession')

    await expect(
      o.store.transact(async () => {
        await o.store.effects.insert(
          fixtureWriteScope(),
          {
            id: 'eff_resume-rolled-back',
            kind: 'session.launch',
            target: { kind: 'session', id: '6f1f0b7e-1b7e-4c8e-9a52-6a0d3c1f2b11' },
            input: {
              agentKind: 'claude-code',
              cwd: '/p',
              resume: { kind: 'claude-session', value: 'native-rolled-back' },
              conversationId: 'native-rolled-back',
            },
            deadlineAt: undefined,
            createdBy: null,
          },
          Date.now(),
        )
        throw new Error('forced rollback')
      }),
    ).rejects.toThrow('forced rollback')
    await settle()
    expect(await o.store.effects.get('eff_resume-rolled-back')).toBeUndefined()
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('resume: a launch record that names a resume without its agent is refused before it is stored', async () => {
    const o = await makeOracle()
    const reply = await submit(
      o,
      envelope(
        'effects.create',
        {
          id: 'eff_resume-no-agent',
          kind: 'session.launch',
          target: { kind: 'session', id: '0c4d6a8e-2f5b-4b7d-8e1a-3c9f7b2d5e60' },
          input: { cwd: '/p', resume: { kind: 'claude-session', value: 'native-x' } },
        },
        'm-resume-no-agent',
      ),
    )
    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'invalid' } })
    expect(await o.store.effects.get('eff_resume-no-agent')).toBeUndefined()
  })
})
