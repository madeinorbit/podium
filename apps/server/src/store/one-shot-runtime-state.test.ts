/** One-shot state acceptance through the real daemon ingress, durable gate,
 * session projection and client publication. Only the hosted runner is fake. */
import { createHash } from 'node:crypto'
import { asAccountId, firstAdminMemberId, type AgentRuntimeState } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalHeadlessContractFacts,
  type SessionSpec,
  type TurnInput,
} from '../../../../packages/harness/src/driver/contract.js'
import { createMemoryDriverSlots } from '../../../../packages/harness/src/driver/testing/index.js'
import {
  createHeadlessRuntime,
  type HeadlessDriverHost,
  type HeadlessDriverRunners,
  type HeadlessPermissionRequest,
} from '../../../../packages/harness/src/driver/families/headless/runtime.js'
import { testHarnessSnapshot } from '../../../../packages/harness/src/driver/families/headless/test-support.js'
import type { HeadlessTurnOutcome } from '../../../../packages/harness/src/driver/families/headless/types.js'
import { SessionRegistry } from '../relay'
import { attachTestClient } from '../test-support/client-transport'
import { attachHostDaemon } from '../test-support/host-daemon'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

interface ControlledTurn {
  finish(result: HeadlessTurnOutcome): void
  fail(error: unknown): void
  permission?: (request: HeadlessPermissionRequest) => void
  answerError?: Error
  answerThenFinish?: boolean
}

async function fixture() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  const controls: ControlMessage[] = []
  await attachHostDaemon(registry, (frame) => { controls.push(frame) })
  const clients: ServerMessage[] = []
  attachTestClient(registry.clientGateway, (frame) => { clients.push(frame) })
  const { sessionId } = await registry.modules.sessions.headless.createHeadlessSession({
    agentKind: 'claude-code', cwd: '/fixture', ownerUserId: firstAdminMemberId(),
  })
  const machineId = registry.sessionStore.hostMachineId
  await registry.gateway.routeDaemonFrame(machineId, {
    type: 'bind', sessionId, cmd: 'headless', cwd: '/fixture', agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 }, driverId: 'headless',
  })

  let now = Date.parse('2026-10-09T08:00:00.000Z')
  const sent: DaemonMessage[] = []
  const turns: ControlledTurn[] = []
  let dispatchError: Error | undefined
  const runners: HeadlessDriverRunners = {
    runTurn: (_deps, input) => {
      if (dispatchError) throw dispatchError
      let finish!: ControlledTurn['finish']
      let fail!: ControlledTurn['fail']
      const done = new Promise<HeadlessTurnOutcome>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
      const turn: ControlledTurn = { finish, fail, permission: input.hooks?.onPermission }
      turns.push(turn)
      return {
        done, interrupt() {},
        answerPermission() {
          if (turn.answerError) throw turn.answerError
          if (turn.answerThenFinish) turn.finish({ harnessSessionId: 'finished', output: 'done' })
        },
      }
    },
    acknowledge: async () => {},
  }
  const host: HeadlessDriverHost = {
    send: (frame) => { sent.push(frame) },
    snapshot: async () => testHarnessSnapshot(),
    engines: () => ({
      startEngine: async () => { throw new Error('no processes in projection regression') },
      reattachEngine: async () => { throw new Error('no processes in projection regression') },
      engineAlive: async () => false, destroyEngine: async () => {},
    }),
    turnChildEnv: () => ({ env: {}, stripEnv: [] }),
    assertNativeAccount() {}, sessionEnv: () => ({}),
    durableLabel: (id) => `podium-${id}`, bindHeadlessSession() {},
    readHistory: async () => ({ items: [], hasMore: false }),
    archiveTranscript: async () => ({ path: '/fixture/transcript' }),
    readFileBytes: async () => new Uint8Array(), now: () => now,
  }
  const runtime = createHeadlessRuntime(host, createMemoryDriverSlots(), runners)
  cleanups.push(async () => { runtime.dispose(); await registry.dispose() })
  const spec: SessionSpec = {
    harness: 'claude-code', workdir: '/fixture', model: {},
    selection: { auth: 'unknown' as const, platform: 'linux', available: [] },
    instructions: { supported: false as const, reason: 'fixture' },
    mcpServers: { supported: false as const, reason: 'fixture' },
  }
  const handle = await runtime.createWithId(sessionId, spec)
  let forwarded = 0
  async function forward(rejectedEpoch?: number) {
    // Settle the runner's done callback, then forward the actual emitted wire
    // frames. A delivery id is normally added by the daemon's coarse outbox.
    await Promise.resolve()
    while (forwarded < sent.length) {
      const frame = sent[forwarded++]!
      if (frame.type === 'runtimeEvent') {
        const deliveryId = `one-shot-${forwarded}`
        await registry.gateway.routeDaemonFrame(machineId, { ...frame, deliveryId })
        const ack = controls.find((item) => item.type === 'runtimeEventAck' && item.deliveryId === deliveryId)
        expect(ack).toMatchObject(frame.event.turnEpoch === rejectedEpoch
          ? { outcome: 'rejected', rejectionReason: 'turn-epoch-regressed' }
          : { outcome: 'committed' })
      } else {
        await registry.gateway.routeDaemonFrame(machineId, frame)
      }
    }
  }
  const localState = () => handle.state()
  const projectedState = async () => (await registry.modules.sessions.sessionById(sessionId))?.agentState
  const publishedStates = () => clients.flatMap((frame) =>
    frame.type === 'sessionAgentStateChanged' && frame.sessionId === sessionId ? [frame.state] : [])
  async function agree(expected: Partial<AgentRuntimeState>) {
    const local = await localState()
    expect(local).toMatchObject(expected)
    const canonical = { ...local, workingMsTotal: local.workingMsTotal ?? 0 }
    expect(await projectedState()).toEqual(canonical)
    expect(publishedStates().at(-1)).toEqual(canonical)
    expect(controls.some((frame) => frame.type === 'runtimeWatch')).toBe(false)
  }
  function input(id: string, structured = false): TurnInput {
    const accountId = asAccountId('native:claude-code:fixture')
    const facts = canonicalHeadlessContractFacts({
      prompt: 'work', accountId, turnId: id, sessionId,
      ...(structured ? { structuredPermissions: true as const } : {}),
    })
    const requestDigest = createHash('sha256')
      .update(facts).digest('hex')
    return { id, text: 'work', accountId, requestDigest, ...(structured ? { structuredPermissions: true } : {}) }
  }
  async function send(id: string, structured = false, interrupt = false) {
    const receipt = await handle.send(input(id, structured), {
      origin: 'system', delivery: interrupt ? 'interrupt' : 'when-ready',
    })
    expect(receipt).toMatchObject({ outcome: 'accepted', turnEpoch: turns.length })
    await forward()
    return turns.at(-1)!
  }
  await forward()
  return {
    registry, runtime, handle, spec, sent, turns, send, input, forward, agree, projectedState,
    publishedStates, tick: () => { now += 1000 },
    dispatchError: (error?: Error) => { dispatchError = error },
  }
}

describe('one-shot runtime state publication', () => {
  it('publishes working and done through the durable projection without a fine watch', async () => {
    const f = await fixture()
    await f.agree({ phase: 'idle' })
    f.tick()
    const turn = await f.send('done')
    await f.agree({ phase: 'working' })
    const start = f.sent.flatMap((frame) => frame.type === 'runtimeEvent' ? [frame.event] : [])
    expect(start.slice(-2)).toMatchObject([
      { t: 'turn', turnEpoch: 1, ev: { ev: 'started' } },
      { t: 'state', turnEpoch: 1, change: { kind: 'prompt_submitted' } },
    ])
    f.tick()
    turn.finish({ harnessSessionId: 'done', output: 'done' })
    await f.forward()
    await f.agree({ phase: 'idle', idle: { kind: 'done' }, workingMsTotal: 1000 })
    expect(f.publishedStates().map((state) => state.phase)).toEqual(['idle', 'working', 'idle'])
    expect((await f.registry.sessionStore.events.listRuntimeEvents(f.handle.binding.sessionId))
      .filter((event) => event.t === 'state')).toHaveLength(3)
  })

  it.each([
    ['provider exploded', 'provider-error', false],
    ['turn timed out', 'timeout', true],
  ] as const)('publishes the %s failure and preserves it against progress markers', async (message, errorClass, retryable) => {
    const f = await fixture()
    const turn = await f.send('failure')
    f.tick()
    turn.fail(new Error(message))
    await f.forward()
    await f.agree({ phase: 'errored', error: { class: errorClass, retryable, detail: message } })
    f.registry.modules.sessions.headless.broadcastHeadlessActivity(f.handle.binding.sessionId, { kind: 'turn-end', error: message })
    f.registry.modules.sessions.headless.broadcastHeadlessActivity(f.handle.binding.sessionId, { kind: 'partial-text', text: 'late progress' })
    await f.agree({ phase: 'errored' })
    await f.send('retry')
    await f.agree({ phase: 'working' })
    expect((await f.handle.state()).error).toBeUndefined()
  })

  it.each(['allow-once', 'deny'] as const)('publishes a permission wait and resumes after %s', async (decision) => {
    const f = await fixture()
    const turn = await f.send('permission', true)
    f.tick()
    turn.permission?.({ id: 'ask', toolName: 'Bash', input: { command: 'true' } })
    await f.forward()
    await f.agree({ phase: 'needs_user', need: { kind: 'permission', summary: 'Bash', ask: { toolName: 'Bash', detail: '{"command":"true"}' } } })
    f.registry.modules.sessions.headless.broadcastHeadlessActivity(f.handle.binding.sessionId, { kind: 'turn-start' })
    await f.agree({ phase: 'needs_user' })
    // A failed answer leaves the live wait intact.
    turn.answerError = new Error('answer transport failed')
    expect(await f.handle.answer('ask', { kind: 'permission', decision })).toMatchObject({ ok: false, reason: 'delivery-failed' })
    await f.forward()
    await f.agree({ phase: 'needs_user' })
    turn.answerError = undefined
    f.tick()
    expect(await f.handle.answer('ask', { kind: 'permission', decision })).toEqual({ ok: true })
    await f.forward()
    await f.agree({ phase: 'working' })
    expect((await f.handle.state()).need).toBeUndefined()
  })

  it('keeps remaining permission asks visible until their own answer', async () => {
    const f = await fixture()
    const turn = await f.send('multiple-asks', true)
    turn.permission?.({ id: 'first', toolName: 'Bash' })
    turn.permission?.({ id: 'second', toolName: 'Edit' })
    await f.forward()
    await f.agree({ phase: 'needs_user', need: { kind: 'permission', summary: 'Bash' } })
    expect(await f.handle.answer('first', { kind: 'permission', decision: 'allow-once' })).toEqual({ ok: true })
    await f.forward()
    await f.agree({ phase: 'needs_user', need: { kind: 'permission', summary: 'Edit' } })
    expect(await f.handle.answer('second', { kind: 'permission', decision: 'deny' })).toEqual({ ok: true })
    await f.forward()
    await f.agree({ phase: 'working' })
  })

  it('publishes interrupted and expires the stopped turn’s permission', async () => {
    const f = await fixture()
    const turn = await f.send('interrupt', true)
    turn.permission?.({ id: 'stopped-ask', toolName: 'Edit' })
    await f.forward()
    await f.handle.interrupt()
    turn.fail(new Error('signal: killed'))
    await f.forward()
    await f.agree({ phase: 'idle', idle: { kind: 'interrupted' } })
    expect(await f.handle.interactions()).toEqual([])
    expect(await f.handle.answer('stopped-ask', { kind: 'permission', decision: 'deny' })).toMatchObject({ ok: false, reason: 'already-answered' })
  })

  it('keeps a superseded outcome in its own epoch and preserves the replacement wait', async () => {
    const f = await fixture()
    const old = await f.send('old', true)
    old.permission?.({ id: 'old-ask', toolName: 'Bash' })
    await f.forward()
    const next = await f.send('next', true, true)
    next.permission?.({ id: 'new-ask', toolName: 'Edit' })
    await f.forward()
    const before = await f.projectedState()
    const statesBefore = f.publishedStates().length
    old.finish({ harnessSessionId: 'old-conversation', output: 'late success' })
    await f.forward(1)
    await f.agree({ phase: 'needs_user', need: { kind: 'permission', summary: 'Edit' } })
    expect(await f.projectedState()).toEqual(before)
    expect(f.publishedStates()).toHaveLength(statesBefore)
    expect(f.handle.binding.resume).toBeNull()
    expect(await f.handle.interactions()).toMatchObject([{ id: 'new-ask' }])
    expect(f.sent.at(-1)).toMatchObject({ type: 'runtimeEvent', event: { t: 'turn', turnEpoch: 1, ev: { turnEpoch: 1 } } })
    next.fail(new Error('provider exploded'))
    await f.forward()
    await f.agree({ phase: 'errored' })
  })

  it('does not publish or consume an epoch for a synchronous dispatch refusal', async () => {
    const f = await fixture()
    const before = f.sent.length
    f.dispatchError(new Error('spawn ENOENT'))
    expect(await f.handle.send(f.input('refused'), { origin: 'system', delivery: 'when-ready' }))
      .toMatchObject({ outcome: 'refused', refusal: { reason: 'not_running' } })
    await f.forward()
    expect(f.sent).toHaveLength(before)
    expect((await f.handle.snapshot()).turnEpoch).toBe(0)
    await f.agree({ phase: 'idle' })
    f.dispatchError()
    await f.send('accepted')
    await f.agree({ phase: 'working' })
  })

  it('bootstraps replacement observer generations before subsequent state events', async () => {
    const f = await fixture()
    const turn = await f.send('resume', true)
    await f.runtime.resumeWithId(f.handle.binding.sessionId, { kind: 'claude-session', value: 'resume' }, f.spec)
    await f.forward()
    await f.agree({ phase: 'working' })
    turn.permission?.({ id: 'resumed-ask', toolName: 'Bash' })
    await f.forward()
    await f.agree({ phase: 'needs_user' })
    await f.runtime.adopt(f.handle.binding)
    await f.forward()
    await f.agree({ phase: 'needs_user' })
    expect(await f.handle.answer('resumed-ask', { kind: 'permission', decision: 'deny' })).toEqual({ ok: true })
    await f.forward()
    await f.agree({ phase: 'working' })
  })

  it('does not reopen working when the turn ends while an answer is delivered', async () => {
    const f = await fixture()
    const turn = await f.send('answer-race', true)
    turn.permission?.({ id: 'race-ask', toolName: 'Bash' })
    await f.forward()
    turn.answerThenFinish = true
    expect(await f.handle.answer('race-ask', { kind: 'permission', decision: 'deny' }))
      .toMatchObject({ ok: false, reason: 'delivery-failed' })
    await f.forward()
    await f.agree({ phase: 'idle', idle: { kind: 'done' } })
  })

  it('publishes ended and ignores the stopped runner’s late outcome', async () => {
    const f = await fixture()
    const turn = await f.send('stop')
    await f.handle.stop()
    await f.forward()
    await f.agree({ phase: 'ended' })
    const before = f.sent.length
    turn.fail(new Error('late stop failure'))
    await f.forward()
    expect(f.sent).toHaveLength(before)
    await f.agree({ phase: 'ended' })
  })

  it('publishes ended when the last turn has already closed', async () => {
    const f = await fixture()
    const turn = await f.send('done-before-stop')
    turn.finish({ harnessSessionId: 'done', output: 'done' })
    await f.forward()
    await f.handle.stop()
    await f.forward()
    await f.agree({ phase: 'ended' })
  })
})
