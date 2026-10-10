import { firstAdminMemberId, type AgentRuntimeState } from '@podium/model'
import type { ControlMessage, RuntimeEvent } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import {
  createClaudeSdkRuntime,
  type ClaudeSdkPermissionRequest,
  type ClaudeSdkRuntimeHost,
  type ClaudeSdkTurnHandle,
  type ClaudeSdkTurnResult,
} from '../../../../packages/harness/src/driver/families/claude-sdk/runtime.js'
import { createMemoryDriverSlots } from '../../../../packages/harness/src/driver/testing/index.js'
import { SessionRegistry } from '../relay'
import { openTestStore } from '../test-support/open-test-store'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  // A test may reject acceptance before the driver has attached its listener.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

async function fixture() {
  const store = await openTestStore(':memory:')
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const commands: ControlMessage[] = []
  await store.machines.upsertMachine({
    id: store.hostMachineId, name: 'Host', hostname: 'test', tokenHash: 'test',
    ownerUserId: firstAdminMemberId(), assignment: { server: true, agentExecution: true },
  })
  await registry.gateway.attachDaemon(store.hostMachineId, (message) => commands.push(message))
  const { sessionId } = await registry.modules.sessions.createSession({
    agentKind: 'claude-code', cwd: '/claude-state-fixture',
  })
  await registry.gateway.routeDaemonFrame(store.hostMachineId, {
    type: 'bind', sessionId, cmd: 'claude', cwd: '/claude-state-fixture',
    agentKind: 'claude-code', geometry: { cols: 80, rows: 24 }, driverId: 'claude-sdk',
  })
  let clock = Date.now() + 1_000
  let clockStep = 0
  const turns: Array<{
    accept(): void
    finish(): void
    fail(error: Error): void
    permission(request: ClaudeSdkPermissionRequest): void
    answer: ReturnType<typeof vi.fn<ClaudeSdkTurnHandle['answerPermission']>>
  }> = []
  const host: ClaudeSdkRuntimeHost = {
    mintSessionId: () => sessionId,
    mintResumeValue: () => '00000000-0000-4000-8000-000000000001',
    now: () => { const at = new Date(clock).toISOString(); clock += clockStep; return at },
    startTurn(input) {
      const accepted = deferred<void>()
      const done = deferred<ClaudeSdkTurnResult>()
      const answer = vi.fn<ClaudeSdkTurnHandle['answerPermission']>(() => {})
      turns.push({
        accept: () => accepted.resolve(),
        finish: () => done.resolve({ resumeValue: input.resumeValue, output: 'finished' }),
        fail: done.reject,
        permission: input.onPermission,
        answer,
      })
      return {
        accepted: accepted.promise, done: done.promise,
        interrupt() {}, answerPermission: answer, dispose() {},
      }
    },
    readTranscript: async () => ({ items: [], hasMore: false }),
    readArchive: async () => undefined,
  }
  const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
  const handle = await runtime.createWithId(sessionId, {
    harness: 'claude-code', workdir: '/claude-state-fixture', model: {},
    selection: { auth: 'subscription', platform: 'linux', available: ['claude-sdk'], preference: 'claude-sdk' },
    instructions: { supported: false, reason: 'fixture' },
    mcpServers: { supported: false, reason: 'fixture' },
  })
  const emitted: RuntimeEvent[] = []
  let after: 'bootstrap' | RuntimeEvent['cursor'] = 'bootstrap'
  async function forward() {
    const snapshot = await handle.snapshot()
    if (after !== 'bootstrap' && after.components.seq === snapshot.cursor.components.seq) return
    for await (const event of handle.events(after)) {
      const deliveryId = `claude-state-${event.cursor.components.seq}`
      await registry.gateway.routeDaemonFrame(store.hostMachineId, {
        type: 'runtimeEvent', sessionId, deliveryId, event,
      })
      expect(commands.find((message) => message.type === 'runtimeEventAck' && message.deliveryId === deliveryId),
        `server admission of ${event.t} in epoch ${event.turnEpoch}`).toEqual({
        type: 'runtimeEventAck', deliveryId, outcome: 'committed',
      })
      emitted.push(event)
      after = event.cursor
      if (event.cursor.components.seq === snapshot.cursor.components.seq) break
    }
  }
  async function agrees(phase: AgentRuntimeState['phase'], workingMsTotal?: number) {
    await forward()
    const state = await handle.state()
    expect(state.phase).toBe(phase)
    if (workingMsTotal !== undefined) expect(state.workingMsTotal).toBe(workingMsTotal)
    expect((await registry.modules.sessions.sessionById(sessionId))?.agentState).toEqual(state)
    const row = (await store.sessions.loadSessions()).find((session) => session.id === sessionId)
    expect(row?.workingMsTotal).toBe(state.workingMsTotal)
    expect(await store.events.listRuntimeEvents(sessionId)).toEqual(emitted)
    return state
  }
  async function start(id = `turn-${turns.length + 1}`) {
    const index = turns.length
    const receipt = handle.send({ id, text: 'work' }, { origin: 'human', delivery: 'when-ready' })
    await vi.waitFor(() => expect(turns).toHaveLength(index + 1))
    turns[index]!.accept()
    expect(await receipt).toMatchObject({ outcome: 'accepted', turnEpoch: index + 1 })
    return turns[index]!
  }
  async function close() {
    runtime.dispose()
    await registry.dispose()
    await store.close()
  }
  try { await agrees('idle', 0) } catch (error) { await close(); throw error }
  return {
    runtime, handle, store, registry, sessionId, turns, emitted, forward, agrees, start, close,
    advance: (ms: number) => { clock += ms },
    tickOnRead: () => { clockStep = 1 },
  }
}

describe('Claude SDK causal state publication through the server projection', () => {
  it('publishes an idle state when a pre-turn interaction is answered', async () => {
    const f = await fixture()
    try {
      const id = f.runtime.testInteractionRequested(f.sessionId, {
        kind: 'permission',
        payload: { v: 1, toolName: 'Bash', canAlwaysAllow: false },
      })
      await f.agrees('needs_user', 0)
      expect(await f.handle.answer(id, { decision: 'allow-once' })).toEqual({ ok: true })
      expect((await f.agrees('idle', 0)).need).toBeUndefined()
      expect(f.emitted.some((event) => event.t === 'turn')).toBe(false)
    } finally { await f.close() }
  })

  it('publishes working only after acceptance and after opening the turn epoch', async () => {
    const f = await fixture()
    try {
      const receipt = f.handle.send({ id: 'accepted-start', text: 'work' }, { origin: 'human', delivery: 'when-ready' })
      await vi.waitFor(() => expect(f.turns).toHaveLength(1))
      await f.agrees('idle', 0)
      expect(f.emitted.some((event) => event.t === 'turn')).toBe(false)
      f.turns[0]!.accept()
      expect(await receipt).toMatchObject({ outcome: 'accepted', turnEpoch: 1 })
      await f.agrees('working', 0)
      expect(f.emitted.filter((event) => event.turnEpoch === 1)).toMatchObject([
        { t: 'turn', ev: { ev: 'started' } },
        { t: 'state', change: { kind: 'prompt_submitted' } },
      ])
    } finally { await f.close() }
  })

  it('resumes after the final permission answer and excludes permission waits from working time', async () => {
    const f = await fixture()
    try {
      const turn = await f.start()
      await f.agrees('working', 0)
      f.advance(3_000)
      turn.permission({ id: 'permission-1', toolName: 'Bash', input: { command: 'true' } })
      await f.agrees('needs_user', 3_000)
      turn.permission({ id: 'permission-2', toolName: 'Read' })
      await f.agrees('needs_user', 3_000)
      f.advance(10_000)
      expect(await f.handle.answer('permission-1', { decision: 'allow-once' })).toEqual({ ok: true })
      await f.agrees('needs_user', 3_000)
      expect((await f.handle.interactions()).map((interaction) => interaction.id)).toEqual(['permission-2'])
      expect(await f.handle.answer('permission-2', { decision: 'allow-once' })).toEqual({ ok: true })
      const resumed = await f.agrees('working', 3_000)
      expect(resumed.need).toBeUndefined()
      expect(await f.handle.interactions()).toHaveLength(0)
      expect(f.emitted.slice(-2)).toMatchObject([
        { t: 'interaction', ev: { ev: 'answered', id: 'permission-2' } },
        { t: 'state', turnEpoch: 1, change: { kind: 'activity' } },
      ])
      f.advance(4_000)
      turn.finish()
      await vi.waitFor(async () => expect((await f.handle.state()).phase).toBe('idle'))
      await f.agrees('idle', 7_000)
    } finally { await f.close() }
  })

  it('keeps failed or invalid permission answers waiting without publishing a resume', async () => {
    const f = await fixture()
    try {
      const turn = await f.start()
      turn.permission({ id: 'permission', toolName: 'Bash' })
      await f.agrees('needs_user')
      const before = f.emitted.length
      expect(await f.handle.answer('permission', { decision: 'allow-always' })).toMatchObject({ ok: false, reason: 'not-yet-supported' })
      turn.answer.mockImplementationOnce(() => { throw new Error('answer delivery failed') })
      expect(await f.handle.answer('permission', { decision: 'allow-once' })).toMatchObject({ ok: false, reason: 'delivery-failed' })
      await f.agrees('needs_user')
      expect(f.emitted).toHaveLength(before)
      expect(await f.handle.answer('permission', { decision: 'deny' })).toEqual({ ok: true })
      await f.agrees('working')
    } finally { await f.close() }
  })

  it('opens a queued follow-up only after its own acknowledgement and clears the completed verdict', async () => {
    const f = await fixture()
    try {
      const first = await f.start()
      await f.agrees('working', 0)
      expect(await f.handle.send({ id: 'queued-follow-up', text: 'next' }, { origin: 'human', delivery: 'queue' })).toMatchObject({ outcome: 'queued' })
      await f.agrees('working', 0)
      f.advance(2_000)
      first.finish()
      await vi.waitFor(() => expect(f.turns).toHaveLength(2))
      expect(await f.agrees('idle', 2_000)).toMatchObject({ idle: { kind: 'done' } })
      expect(f.emitted.slice(-2)).toMatchObject([
        { t: 'state', turnEpoch: 1, change: { kind: 'turn_completed' } },
        { t: 'turn', turnEpoch: 1, ev: { ev: 'completed' } },
      ])
      f.advance(5_000)
      f.turns[1]!.accept()
      await vi.waitFor(async () => expect((await f.handle.state()).phase).toBe('working'))
      const next = await f.agrees('working', 2_000)
      expect(next.idle).toBeUndefined()
      expect(f.emitted.slice(-2)).toMatchObject([
        { t: 'turn', turnEpoch: 2, ev: { ev: 'started' } },
        { t: 'state', turnEpoch: 2, change: { kind: 'prompt_submitted' } },
      ])
      f.advance(1_000)
      f.turns[1]!.finish()
      await vi.waitFor(async () => expect((await f.handle.state()).phase).toBe('idle'))
      await f.agrees('idle', 3_000)
    } finally { await f.close() }
  })

  it('publishes failure before closing the epoch and clears the error on the next accepted turn', async () => {
    const f = await fixture()
    try {
      const turn = await f.start()
      await f.agrees('working', 0)
      f.advance(2_000)
      turn.fail(new Error('authentication failed'))
      await vi.waitFor(async () => expect((await f.handle.state()).phase).toBe('errored'))
      expect(await f.agrees('errored', 2_000)).toMatchObject({ error: { class: 'authentication', retryable: false } })
      const failed = f.emitted.findIndex((event) => event.t === 'turn' && event.ev.ev === 'failed')
      const state = f.emitted.findIndex((event) => event.t === 'state' && event.change.kind === 'turn_failed')
      expect(state).toBeGreaterThan(-1)
      expect(state).toBeLessThan(failed)
      expect(await f.store.events.runtimeEventCheckpoint(f.sessionId)).toMatchObject({ closedTurnEpoch: 1 })
      f.advance(5_000)
      await f.start()
      const resumed = await f.agrees('working', 2_000)
      expect(resumed.error).toBeUndefined()
      expect(resumed.need).toBeUndefined()
    } finally { await f.close() }
  })

  it('does not publish a late permission resume after the provider closes its epoch', async () => {
    const f = await fixture()
    try {
      const turn = await f.start()
      turn.permission({ id: 'late-permission', toolName: 'Bash' })
      await f.agrees('needs_user')
      const delivered = deferred<void>()
      turn.answer.mockImplementationOnce(() => delivered.promise)
      const answer = f.handle.answer('late-permission', { decision: 'allow-once' })
      turn.fail(new Error('authentication failed'))
      await vi.waitFor(async () => expect((await f.handle.state()).phase).toBe('errored'))
      await f.agrees('errored')
      const before = f.emitted.length
      delivered.resolve()
      expect(await answer).toEqual({ ok: true })
      await f.agrees('errored')
      expect(f.emitted).toHaveLength(before)
      expect(await f.handle.interactions()).toHaveLength(0)
    } finally { await f.close() }
  })

  it('uses the same event time for local folds and server projection', async () => {
    const f = await fixture()
    try {
      // Distinct clock reads expose a fold/envelope timestamp mismatch that a
      // fixed-clock fixture would conceal.
      f.tickOnRead()
      const turn = await f.start()
      await f.agrees('working')
      turn.permission({ id: 'timed-permission', toolName: 'Bash' })
      await f.agrees('needs_user')
      expect(await f.handle.answer('timed-permission', { decision: 'allow-once' })).toEqual({ ok: true })
      await f.agrees('working')
      turn.finish()
      await vi.waitFor(async () => expect((await f.handle.state()).phase).toBe('idle'))
      await f.agrees('idle')
    } finally { await f.close() }
  })
})
