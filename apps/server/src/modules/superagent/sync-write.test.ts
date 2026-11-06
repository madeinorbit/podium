/**
 * THE SUPERAGENT'S WRITES ON THE SYNC WRITE ENTRY POINT (POD-6419).
 *
 * Through the server the oracle composes: the eight thread commands arrive
 * through `submit` with a receipt; a replay answers the recorded result and runs
 * nothing again; a thread that is not the caller's is refused before the handler,
 * and a replay is refused once the account is gone. Every daemon call the
 * commands make (the headless spawn frame, the turn, the interrupt, the kill, the
 * terminal's PTY spawn) runs after the commit: never on a rollback, exactly once
 * on a commit. The old routes stay, as thin adapters onto the entry point.
 */

import {
  asMutationId,
  asSessionId,
  asThreadId,
  asUserId,
  firstAdminMemberId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { FAMILY_COMMAND_NAMES } from '../sync-write/family-commands'
import {
  appliedReply,
  envelope,
  expectAppliedOnPath,
  rowsOf,
  submit,
} from '../sync-write/outbox-test-support'
import type { SuperagentService } from './service'

afterEach(() => disposeOracles())

const SUPERAGENT_WRITES = [
  'superagent.sendTurn',
  'superagent.interruptTurn',
  'superagent.openInTerminal',
  'superagent.clear',
  'superagent.restart',
  'superagent.ensureSession',
  'superagent.startBtw',
  'superagent.concierge',
] as const

const ADMIN = firstAdminMemberId()
const GLOBAL = asThreadId('global')

function superagent(o: Oracle): SuperagentService {
  const service = o.reg.modules.superagent
  if (!service) throw new Error('the oracle adopts its superagent')
  return service
}

/** The headless establish frames sent to the daemon. */
const spawnFrames = (o: Oracle): ControlMessage[] =>
  o.daemon.filter(
    (msg) =>
      msg.type === 'spawn' &&
      (msg as { requestedDriverId?: string }).requestedDriverId === 'headless',
  )

/** A member account that exists, so its role is read live. */
async function member(o: Oracle, id = 'usr_member_6419'): Promise<UserId> {
  const user = asUserId(id)
  await o.store.users.createUnclaimed({
    id: user,
    displayName: 'Member',
    email: null,
    role: 'member',
    createdAt: new Date().toISOString(),
    disabledAt: null,
  })
  return user
}

/** A thread with a harness conversation, as a finished first turn leaves it. */
async function threadWithHarness(o: Oracle, id = 'btw_s-harness', owner: UserId = ADMIN) {
  await o.store.superagent.upsertSuperagentThread({
    id,
    ownerUserId: owner,
    kind: 'btw',
    originSessionId: asSessionId('s-harness'),
  })
  await o.store.superagent.updateSuperagentThreadBinding(id, {
    agentKind: 'claude-code',
    harnessSessionId: 'harness-conv-1',
  })
  return asThreadId(id)
}

/** Run `fn` inside a unit of work that rolls back. */
async function rolledBack(o: Oracle, fn: () => Promise<unknown>): Promise<void> {
  const rollback = new Error('forced rollback')
  await expect(
    o.store.transact(async () => {
      await fn()
      throw rollback
    }),
  ).rejects.toBe(rollback)
}

/** Run `fn` inside a unit of work that commits. */
async function committed<T>(o: Oracle, fn: () => Promise<T>): Promise<T> {
  return await o.store.transact(fn)
}

/** Let the after-commit work the commit dispatched run. */
const settle = async () => await new Promise((resolve) => setTimeout(resolve, 20))

describe('the superagent writes on the entry point', () => {
  it('the composed registry holds all eight', async () => {
    const o = await makeOracle()
    const names = o.reg.modules.syncWrite.registry.names()
    for (const name of SUPERAGENT_WRITES) {
      expect(names, name).toContain(name)
      expect(FAMILY_COMMAND_NAMES, name).toContain(name)
    }
  })

  it('ensureSession mints the headless session with provenance; the replay spawns nothing', async () => {
    const o = await makeOracle()
    const { result, rows } = await expectAppliedOnPath(
      o,
      envelope('superagent.ensureSession', { threadId: 'global' }, 'mut_sa_ensure'),
      { writes: true },
    )
    const { podiumSessionId } = result as { podiumSessionId: SessionId }
    expect(rows.some((row) => row.entityId === podiumSessionId)).toBe(true)
    await settle()
    // One establish frame for the one session, after the commit; the replay
    // inside expectAppliedOnPath sent none.
    expect(spawnFrames(o).map((msg) => (msg as { sessionId: string }).sessionId)).toEqual([
      podiumSessionId,
    ])
  })

  it('sendTurn is accepted in the write and runs once after the commit; the replay runs nothing', async () => {
    const o = await makeOracle()
    const turn = vi
      .spyOn(o.reg.modules.headless, 'headlessTurn')
      .mockImplementation(() => new Promise(() => {}))
    const env = envelope(
      'superagent.sendTurn',
      { threadId: 'global', text: 'hello' },
      'mut_sa_turn',
    )
    const reply = appliedReply(await submit(o, env))
    expect(reply.result).toMatchObject({ threadId: 'global', queued: false })
    expect(reply.receipt.seq).toBeLessThanOrEqual(await o.reg.changeLedger.cursor())
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1))

    const replay = appliedReply(await submit(o, env))
    expect(replay.replayed).toBe(true)
    expect(replay.result).toEqual(reply.result)
    await settle()
    expect(turn).toHaveBeenCalledTimes(1)
    expect(await o.store.superagent.listQueuedInputs(GLOBAL)).toEqual([])
  })

  it('startBtw creates the caller’s own btw thread', async () => {
    const o = await makeOracle()
    const btw = appliedReply(
      await submit(o, envelope('superagent.startBtw', { sessionId: 's-btw' }, 'mut_sa_btw')),
    )
    expect(btw.result).toEqual({ threadId: 'btw_s-btw', isNew: true })
    expect((await o.store.superagent.getSuperagentThread('btw_s-btw'))?.ownerUserId).toBe(ADMIN)
  })

  it("a handler's own refusal is a rejected reply with its message, and nothing is written", async () => {
    const o = await makeOracle()
    const threadId = await threadWithHarness(o)
    await o.store.superagent.updateSuperagentThreadBinding(threadId, { harnessSessionId: null })
    const reply = await submit(
      o,
      envelope('superagent.openInTerminal', { threadId }, 'mut_sa_open_refused'),
    )
    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: {
        kind: 'invalid',
        message: 'this thread has no harness session yet — send a message first',
      },
    })
    expect(await rowsOf(o, 'mut_sa_open_refused')).toEqual([])
  })
})

describe('the superagent target check', () => {
  it("refuses someone else's thread before the handler, and an unknown one alike", async () => {
    const o = await makeOracle()
    const user = await member(o)
    const threadId = await threadWithHarness(o, 'btw_s-admins')
    const restart = vi.spyOn(superagent(o), 'restartThread')
    const as = userCommandPrincipal(user, 'member')
    const submitAs = async (input: unknown, id: string) =>
      await o.reg.modules.syncWrite.submit(envelope('superagent.restart', input, id), as, 'trpc')

    expect(await submitAs({ threadId }, 'mut_sa_other')).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })
    expect(await submitAs({ threadId: 'no-such-thread' }, 'mut_sa_unknown')).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })
    expect(restart).not.toHaveBeenCalled()
  })

  it("an operator's `all` scope does not reach another person's thread", async () => {
    const o = await makeOracle()
    const user = await member(o)
    await threadWithHarness(o, 'btw_s-members', user)
    const clear = vi.spyOn(superagent(o), 'clear')
    const reply = await submit(
      o,
      envelope('superagent.clear', { threadId: 'btw_s-members' }, 'mut_sa_cross'),
    )
    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(clear).not.toHaveBeenCalled()
  })

  it('a member writes their own global thread; once the account is disabled the replay is refused', async () => {
    const o = await makeOracle()
    const user = await member(o)
    const as = userCommandPrincipal(user, 'member')
    const env = envelope('superagent.ensureSession', { threadId: 'global' }, 'mut_sa_member')
    const first = appliedReply(await o.reg.modules.syncWrite.submit(env, as, 'trpc'))
    expect(first.result).toMatchObject({ threadId: `global:${user}` })

    await o.store.users.disable(user, new Date().toISOString())
    expect(await o.reg.modules.syncWrite.submit(env, as, 'trpc')).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'unauthorized' },
    })
  })
})

describe('the daemon calls run after the commit', () => {
  it('ensureSession: the headless spawn frame', async () => {
    const o = await makeOracle()
    const sa = superagent(o)
    await rolledBack(
      o,
      async () => await sa.ensureSession({ ownerUserId: ADMIN, threadId: GLOBAL }),
    )
    await settle()
    expect(spawnFrames(o)).toEqual([])
    expect((await o.store.superagent.getSuperagentThread('global'))?.podiumSessionId).toBeFalsy()

    await committed(o, async () => await sa.ensureSession({ ownerUserId: ADMIN, threadId: GLOBAL }))
    await settle()
    expect(spawnFrames(o)).toHaveLength(1)
  })

  it('sendTurn: the turn', async () => {
    const o = await makeOracle()
    const sa = superagent(o)
    const turn = vi
      .spyOn(o.reg.modules.headless, 'headlessTurn')
      .mockImplementation(() => new Promise(() => {}))
    await rolledBack(o, async () =>
      sa.sendTurn({ ownerUserId: ADMIN, threadId: GLOBAL, text: 'rolled back' }),
    )
    await settle()
    expect(turn).not.toHaveBeenCalled()
    expect(spawnFrames(o)).toEqual([])
    expect(await o.store.superagent.listQueuedInputs(GLOBAL)).toEqual([])

    await committed(o, async () =>
      sa.sendTurn({ ownerUserId: ADMIN, threadId: GLOBAL, text: 'committed' }),
    )
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1))
    expect(spawnFrames(o)).toHaveLength(1)
  })

  it('interruptTurn: the interrupt', async () => {
    const o = await makeOracle()
    const sa = superagent(o)
    await sa.ensureSession({ ownerUserId: ADMIN, threadId: GLOBAL })
    const interrupt = vi.spyOn(o.reg.modules.headless, 'headlessInterrupt')
    await rolledBack(
      o,
      async () => await sa.interruptTurn({ ownerUserId: ADMIN, threadId: GLOBAL }),
    )
    await settle()
    expect(interrupt).not.toHaveBeenCalled()

    await committed(o, async () => await sa.interruptTurn({ ownerUserId: ADMIN, threadId: GLOBAL }))
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
  })

  it('restart: the interrupt of the abandoned turn', async () => {
    const o = await makeOracle()
    const sa = superagent(o)
    await sa.ensureSession({ ownerUserId: ADMIN, threadId: GLOBAL })
    const interrupt = vi.spyOn(o.reg.modules.headless, 'headlessInterrupt')
    await rolledBack(
      o,
      async () => await sa.restartThread({ ownerUserId: ADMIN, threadId: GLOBAL }),
    )
    await settle()
    expect(interrupt).not.toHaveBeenCalled()
    expect((await o.store.superagent.getSuperagentThread('global'))?.podiumSessionId).toBeTruthy()

    await committed(o, async () => await sa.restartThread({ ownerUserId: ADMIN, threadId: GLOBAL }))
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
  })

  it('clear: the kill and the interrupt', async () => {
    const o = await makeOracle()
    const sa = superagent(o)
    await sa.ensureSession({ ownerUserId: ADMIN, threadId: GLOBAL })
    const interrupt = vi.spyOn(o.reg.modules.headless, 'headlessInterrupt')
    const kill = vi.spyOn(o.reg.modules.sessions, 'killSession')
    await rolledBack(o, async () => await sa.clear(ADMIN, GLOBAL))
    await settle()
    expect(kill).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()

    await committed(o, async () => await sa.clear(ADMIN, GLOBAL))
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('openInTerminal: the PTY spawn, under the id the write bound', async () => {
    const o = await makeOracle()
    const sa = superagent(o)
    const threadId = await threadWithHarness(o)
    const resume = vi
      .spyOn(o.reg.modules.issueSessionLifecycle, 'resumeSession')
      .mockImplementation(async (input) => ({ sessionId: input.sessionId as SessionId }))
    await rolledBack(o, async () => await sa.openInTerminal({ ownerUserId: ADMIN, threadId }))
    await settle()
    expect(resume).not.toHaveBeenCalled()
    expect((await o.store.superagent.getSuperagentThread(threadId))?.terminalSessionId).toBeFalsy()

    const { sessionId } = await committed(
      o,
      async () => await sa.openInTerminal({ ownerUserId: ADMIN, threadId }),
    )
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1))
    expect(resume.mock.calls[0]?.[0]).toMatchObject({ sessionId })
    expect((await o.store.superagent.getSuperagentThread(threadId))?.terminalSessionId).toBe(
      sessionId,
    )
  })
})

describe('the old superagent routes', () => {
  it('every one is served, as a mutation, and is a thin adapter onto the entry point', async () => {
    const o = await makeOracle()
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    await o.call.superagent.ensureSession({ threadId: GLOBAL })
    await o.call.superagent.startBtw({ sessionId: asSessionId('s-route') })
    expect(entry.mock.calls.map(([env]) => env.command)).toEqual([
      'superagent.ensureSession',
      'superagent.startBtw',
    ])
  })

  it("answers a handler's refusal with the service's own error", async () => {
    const o = await makeOracle()
    const threadId = await threadWithHarness(o)
    await o.store.superagent.updateSuperagentThreadBinding(threadId, { harnessSessionId: null })
    await expect(o.call.superagent.openInTerminal({ threadId })).rejects.toThrow(
      /no harness session yet/,
    )
  })

  it('a route call carrying a mutationId is deduplicated against sync.submit', async () => {
    const o = await makeOracle()
    const mutationId = asMutationId('mut_sa_shared')
    const first = appliedReply(
      await submit(o, envelope('superagent.ensureSession', { threadId: 'global' }, mutationId)),
    )
    const viaRoute = await o.call.superagent.ensureSession({
      threadId: GLOBAL,
      mutationId,
    } as never)
    expect(viaRoute).toEqual(first.result)
    await settle()
    expect(spawnFrames(o)).toHaveLength(1)
  })
})
