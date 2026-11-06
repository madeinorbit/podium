/**
 * ANSWERING AN AGENT'S QUESTION IS A `session.answer` EFFECT RECORD (POD-6415).
 *
 * Driven through the REAL composed server (`makeOracle`). The delivery itself
 * (driver frames, menu scripts) is pinned elsewhere (oracle-commands, the
 * terminal answer contract); here the delivery seams are spied, and what is
 * pinned is the PATH:
 *
 *  - the old routes (`sessions.answerAskUserQuestion` over tRPC and the relay,
 *    `interactions.answer`) create one record through `sync.submit` and deliver
 *    once, from its run, after the commit;
 *  - a replay of the create delivers nothing more;
 *  - a target out of the writer's reach is refused before anything is stored or
 *    delivered, and an ask row of another session reads as a missing one;
 *  - a record whose unit rolls back never runs;
 *  - recovery after a restart reads the ask row, never guesses.
 */

import { randomUUID } from 'node:crypto'
import { asUserId, type SessionId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { appRouter } from '../../router'
import type { EffectRow } from '../../store/effects'
import type { EffectRunContext } from '../effects/registry'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { envelope, submit } from '../sync-write/outbox-test-support'
import { SESSION_ANSWER_KIND, type SessionAnswerInput } from './answer-effect'

afterEach(() => disposeOracles())

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

async function bindLive(o: Oracle, sessionId: SessionId, cwd: string): Promise<void> {
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd,
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
}

async function liveAgent(o: Oracle, cwd = '/p'): Promise<SessionId> {
  const { sessionId } = await o.reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd,
  })
  await bindLive(o, sessionId, cwd)
  return sessionId
}

/** An open question ask on the session, as its driver reports one. */
async function openAsk(o: Oracle, sessionId: SessionId, id = `ask:${sessionId}`): Promise<string> {
  await o.reg.modules.interactions.onInteractionResolved({
    sessionId,
    ev: {
      ev: 'asked',
      interaction: {
        id,
        sessionId,
        kind: 'question',
        payload: {
          v: 1,
          questions: [
            {
              question: 'Pick',
              multiSelect: false,
              previewLayout: false,
              options: [{ label: 'One' }, { label: 'Two' }],
            },
          ],
        },
        askedAt: new Date().toISOString(),
        source: 'screen-classifier',
        answerable: 'keystroke-emulated',
      },
    },
  })
  return id
}

/** Two issues, each with its own worktree under the reported repo `/r`. */
async function twoIssues(o: Oracle) {
  await o.store.repos.addRepo('/r', o.store.hostMachineId)
  const a = await o.reg.issues.crud.create({ repoPath: '/r', title: 'A', startNow: false })
  await o.reg.issues.crud.update(a.id, { worktreePath: '/r/.worktrees/a' })
  const b = await o.reg.issues.crud.create({ repoPath: '/r', title: 'B', startNow: false })
  await o.reg.issues.crud.update(b.id, { worktreePath: '/r/.worktrees/b' })
  return { a, b }
}

const answerCreates = (submitted: { mock: { calls: unknown[][] } }) =>
  submitted.mock.calls
    .map(([env]) => env as { command: string; input: { id: string; kind: string } })
    .filter((env) => env.command === 'effects.create' && env.input.kind === SESSION_ANSWER_KIND)

describe('sessions.answerAskUserQuestion is a session.answer record', () => {
  it('the tRPC route creates one record for the full id and delivers once, from its run', async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    const deliver = vi
      .spyOn(o.reg.modules.sessions, 'answerAskUserQuestion')
      .mockResolvedValue({ ok: true })
    const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    expect(
      await o.call.sessions.answerAskUserQuestion({
        sessionId: sessionId.slice(0, 8) as SessionId,
        choices: [{ optionIndices: [1] }],
      }),
    ).toEqual({ ok: true })

    const [created] = answerCreates(submitted)
    expect(created?.input).toMatchObject({
      kind: SESSION_ANSWER_KIND,
      target: { kind: 'session', id: sessionId },
      input: { via: 'menu', choices: [{ optionIndices: [1] }] },
    })
    expect(await o.store.effects.get(created?.input.id as string)).toMatchObject({
      status: 'succeeded',
      result: { ok: true },
    })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      choices: [{ optionIndices: [1] }],
      principal: expect.anything(),
    })
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("the driver's refusal comes back in the route's shape", async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    vi.spyOn(o.reg.modules.sessions, 'answerAskUserQuestion').mockResolvedValue({
      ok: false,
      reason: 'no pending question',
    })
    expect(
      await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [1] }] }),
    ).toEqual({ ok: false, reason: 'no pending question' })
  })

  it('a replay of the create returns the recorded result and delivers nothing more', async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    const deliver = vi
      .spyOn(o.reg.modules.sessions, 'answerAskUserQuestion')
      .mockResolvedValue({ ok: true })
    const id = `eff_${randomUUID()}`
    const env = envelope(
      'effects.create',
      {
        id,
        kind: SESSION_ANSWER_KIND,
        target: { kind: 'session', id: sessionId },
        input: { via: 'menu', choices: [{ optionIndices: [2] }] },
      },
      'm-answer-replay',
    )

    const first = await submit(o, env)
    expect(first).toMatchObject({ outcome: 'applied' })
    expect(await o.store.sync.getAppliedMutation(env.mutationId)).toBeDefined()
    await vi.waitFor(async () => expect((await o.store.effects.get(id))?.status).toBe('succeeded'))
    const replay = await submit(o, env)
    expect(replay).toMatchObject({ outcome: 'applied', replayed: true })
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('no agent answers over the relay, directly or through the entry point', async () => {
    const o = await makeOracle()
    await twoIssues(o)
    const caller = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })
    const target = await liveAgent(o, '/r/.worktrees/a')
    const deliver = vi.spyOn(o.reg.modules.sessions, 'answerAskUserQuestion')

    const direct = await o.relay({
      requestId: 'answer-direct',
      sessionId: caller.sessionId,
      router: 'sessions',
      proc: 'answerAskUserQuestion',
      input: { sessionId: target, choices: [{ optionIndices: [1] }] },
    })
    expect(direct).toMatchObject({ ok: false, error: expect.stringMatching(/not permitted/) })
    await settle()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("a session out of the writer's reach is refused at the create: nothing stored, nothing delivered", async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    const member = asUserId('usr_answer_member')
    await o.store.users.create(
      {
        id: member,
        displayName: 'member',
        role: 'member',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabledAt: null,
      },
      'fixture-hash',
    )
    const principal = userCommandPrincipal(member, 'member')
    const call = appRouter.createCaller({
      registry: o.reg,
      repos: {} as never,
      superagent: {} as never,
      capability: principal.capability,
      principal,
    })
    const deliver = vi.spyOn(o.reg.modules.sessions, 'answerAskUserQuestion')
    const insert = vi.spyOn(o.store.effects, 'insert')

    const reply = await call.sync.submit(
      envelope(
        'effects.create',
        {
          id: `eff_${randomUUID()}`,
          kind: SESSION_ANSWER_KIND,
          target: { kind: 'session', id: sessionId },
          input: { via: 'menu', choices: [{ optionIndices: [1] }] },
        },
        'm-answer-out-of-reach',
      ),
    )
    expect(reply).toMatchObject({ outcome: 'rejected' })
    // The old route refuses in its own words, before any record.
    await expect(
      call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [1] }] }),
    ).rejects.toThrow(/only its parent or the operator/)
    await settle()
    expect(insert).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a record whose unit rolls back never runs', async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    const deliver = vi.spyOn(o.reg.modules.sessions, 'answerAskUserQuestion')
    await expect(
      o.store.transact(async () => {
        await o.store.effects.insert(
          {
            id: 'eff_answer-rolled-back',
            kind: SESSION_ANSWER_KIND,
            target: { kind: 'session', id: sessionId },
            input: { via: 'menu', skip: true },
            deadlineAt: undefined,
            createdBy: null,
          },
          Date.now(),
        )
        throw new Error('forced rollback')
      }),
    ).rejects.toThrow('forced rollback')
    await settle()
    expect(await o.store.effects.get('eff_answer-rolled-back')).toBeUndefined()
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe('interactions.answer is a session.answer record', () => {
  it('the route answers through the record, attributed to the person', async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    const askId = await openAsk(o, sessionId)
    const answer = vi
      .spyOn(o.reg.modules.interactions, 'answer')
      .mockResolvedValue({ ok: true } as never)
    const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    expect(await o.call.interactions.answer({ id: askId, text: 'One' })).toMatchObject({ ok: true })

    const [created] = answerCreates(submitted)
    expect(created?.input).toMatchObject({
      target: { kind: 'session', id: sessionId },
      input: { via: 'interaction', interactionId: askId, text: 'One' },
    })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer.mock.calls[0]?.[0]).toMatchObject({
      id: askId,
      text: 'One',
      answeredBy: 'human',
    })
  })

  it('an unknown ask answers as before and stores nothing', async () => {
    const o = await makeOracle()
    const insert = vi.spyOn(o.store.effects, 'insert')
    expect(await o.call.interactions.answer({ id: 'ask:nope', text: 'One' })).toEqual({
      ok: false,
      reason: 'unknown-interaction',
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it('an ask of another session reads as a missing one, and nothing is delivered', async () => {
    const o = await makeOracle()
    const asking = await liveAgent(o)
    const other = await liveAgent(o)
    const askId = await openAsk(o, asking)
    const answer = vi.spyOn(o.reg.modules.interactions, 'answer')

    const reply = await submit(
      o,
      envelope(
        'effects.create',
        {
          id: `eff_${randomUUID()}`,
          kind: SESSION_ANSWER_KIND,
          target: { kind: 'session', id: other },
          input: { via: 'interaction', interactionId: askId, text: 'One' },
        },
        'm-answer-other-session',
      ),
    )
    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'target-not-found' } })
    await settle()
    expect(answer).not.toHaveBeenCalled()
  })
})

describe('session.answer recovery', () => {
  const recoverWith = async (o: Oracle, input: SessionAnswerInput, sessionId: SessionId) => {
    const executor = o.reg.modules.effects?.executors.get(SESSION_ANSWER_KIND)
    if (executor?.recover === undefined) throw new Error('session.answer has no recover')
    const controller = new AbortController()
    return await executor.recover({
      record: {
        id: 'eff_recover',
        kind: SESSION_ANSWER_KIND,
        target: { kind: 'session', id: sessionId },
        input,
      } as unknown as EffectRow,
      input,
      stage: async () => undefined,
      cancelRequested: async () => false,
      signal: controller.signal,
      stopped: controller.signal,
    } as EffectRunContext<unknown>)
  }

  it('an ask still open was never claimed: nothing was typed, the record fails', async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    const askId = await openAsk(o, sessionId)
    expect(
      await recoverWith(o, { via: 'interaction', interactionId: askId, text: 'One' }, sessionId),
    ).toMatchObject({ status: 'failed', error: { code: 'interrupted' } })
  })

  it('a menu answer cut off mid-run is unknown: the session is where to look', async () => {
    const o = await makeOracle()
    const sessionId = await liveAgent(o)
    expect(await recoverWith(o, { via: 'menu', skip: true }, sessionId)).toMatchObject({
      status: 'unknown',
    })
  })
})
