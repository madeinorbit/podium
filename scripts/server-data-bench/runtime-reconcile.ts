/**
 * Generated POD-7414 turn-end reconcile fixture (POD-7429), for an agent VM only:
 * bun --conditions=@podium/source scripts/server-data-bench/runtime-reconcile.ts
 *
 * Run this same script on the parent and the candidate. Two arms, each on its
 * own disposable store with the report's background log:
 *
 *  - `turnEnd`: the real terminal driver, resumed, re-tails 207 items of a
 *    1,997-item history and ends its first turn, whose last record the live
 *    tail missed. Its frames cross a socket-shaped boundary (32 frames a read,
 *    one read a macrotask) into the real server gateway. Measured from the turn
 *    end until every frame settled.
 *  - `burst`: 1,600 complete items sent across the same boundary, the shape of
 *    a catch-up with no covered item.
 *
 * Setup and verification are outside the measured window; no live server,
 * daemon or provider is contacted.
 */
import '../../test-hermetic-env'
import assert from 'node:assert/strict'
import { firstAdminMemberId, type SessionId, type TranscriptItem } from '@podium/model'
import type { AgentObservation } from '@podium/protocol'
import type { ControlMessage, DaemonMessage, RuntimeEvent } from '@podium/protocol/daemon'
import { createTerminalRuntime, type TerminalHostPorts } from '../../apps/daemon/src/runtime/host'
import { terminalProfileFor } from '../../apps/daemon/src/runtime/registry'
import { driverSlotsOver } from '../../apps/daemon/src/session/driver-slots.js'
import { SessionRegistry as DaemonSessionRegistry } from '../../apps/daemon/src/session/registry.js'
import { SessionRegistry } from '../../apps/server/src/relay'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'
import { pageHistory } from '../../packages/harness/src/driver/history'

// Smaller only for a local smoke run; the measurement uses the report's size.
const BACKGROUND = Number(process.env.BENCH_BACKGROUND ?? 48_434)
const RESET = 207
const OLDER = 1_788
const BURST = 1_600
const SOCKET_READ_FRAMES = 32
const base = Date.parse('2026-08-23T00:00:00.000Z')
const item = (n: number): TranscriptItem => ({
  id: `item-${n}`,
  cursor: `transcript:${n}`,
  role: n % 2 === 0 ? 'user' : 'assistant',
  text: `Generated message ${n}. ${'Transcript replay fixture. '.repeat(8)}`,
  ts: new Date(base + n * 1_000).toISOString(),
})

interface Fixture {
  store: Awaited<ReturnType<typeof openTestStore>>
  registry: SessionRegistry
  machineId: string
  sessionId: SessionId
  acks: Extract<ControlMessage, { type: 'runtimeEventAck' }>[]
  /** Deliver a frame as the mux does: start it now, never wait for the last. */
  deliver(msg: DaemonMessage): void
  settled(): Promise<void>
}

async function fixture(): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  await store.transact(async () => {
    for (let n = 0; n < BACKGROUND; n++) {
      await store.events.appendEvent(
        {
          ts: new Date(base - 86_400_000 + n).toISOString(),
          kind: 'bench.background',
          subject: `background-${n % 32}`,
          payload: { n, text: 'Generated background event.' },
        },
        { announce: false },
      )
    }
  })
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const machineId = store.hostMachine!.id
  const acks: Fixture['acks'] = []
  await store.machines.upsertMachine({
    id: machineId,
    name: 'Replay fixture',
    hostname: 'test',
    tokenHash: 'test',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: true, agentExecution: true },
  })
  await registry.gateway.attachDaemon(machineId, (msg) => {
    if (msg.type === 'runtimeEventAck') acks.push(msg)
  })
  const { sessionId } = await registry.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: '/project',
  })
  await registry.gateway.routeDaemonFrame(machineId, {
    type: 'bind',
    sessionId,
    cmd: 'codex',
    cwd: '/project',
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
    driverId: 'generic-pty',
  })
  // THE PROCESS BOUNDARY. The daemon writes frames to a socket and the server
  // reads them a chunk at a time, each read one macrotask; within a read the mux
  // starts every frame's handler without waiting for the one before.
  const socket: DaemonMessage[] = []
  const inflight: Promise<void>[] = []
  let reading: Promise<void> | undefined
  const read = async () => {
    while (socket.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (const msg of socket.splice(0, SOCKET_READ_FRAMES)) {
        inflight.push(registry.gateway.routeDaemonFrame(machineId, msg))
      }
    }
    reading = undefined
  }
  return {
    store,
    registry,
    machineId,
    sessionId,
    acks,
    deliver: (msg) => {
      socket.push(msg)
      reading ??= read()
    },
    settled: async () => {
      while (reading || inflight.length > 0) {
        await reading
        await Promise.all(inflight.splice(0))
      }
    },
  }
}

/** A 20 ms heartbeat: the longest gap is how long the server stopped serving. */
function heartbeat() {
  let longestGapMs = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    longestGapMs = Math.max(longestGapMs, now - last)
    last = now
  }, 20)
  return {
    stop: async () => {
      // Let the pending tick observe the final gap.
      await new Promise((resolve) => setTimeout(resolve, 25))
      clearInterval(timer)
      return longestGapMs
    },
  }
}

async function sessionFeedChanges(f: Fixture, after: number): Promise<number> {
  const changes = await f.store.sync.changesSince(after, 100_000)
  return changes.filter((change) => change.entity === 'session' && change.entityId === f.sessionId)
    .length
}

async function feedHead(f: Fixture): Promise<number> {
  return (await f.store.sync.changesSince(0, 1_000_000)).at(-1)?.seq ?? 0
}

async function turnEndArm() {
  const f = await fixture()
  try {
    const history = Array.from({ length: OLDER + RESET }, (_, n) => item(n))
    const emitted: RuntimeEvent[] = []
    const host = {
      send: (msg: DaemonMessage) => {
        if (msg.type === 'runtimeEvent') emitted.push(msg.event)
        f.deliver(msg.type === 'runtimeEvent' ? { ...msg, deliveryId: `d-${emitted.length}` } : msg)
      },
      now: () => Date.now(),
      trackedState: () => undefined,
      draftSyncing: () => false,
      readHistory: async (_session: unknown, range: Parameters<typeof pageHistory>[2]) =>
        pageHistory(history, 'history:bench', range),
      setTimer: (fn: () => void, delay: number) => setTimeout(fn, delay),
      clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    } as unknown as TerminalHostPorts
    const runtime = createTerminalRuntime(
      host,
      undefined,
      driverSlotsOver(new DaemonSessionRegistry()),
    )
    runtime.register(
      {
        sessionId: f.sessionId,
        agentKind: 'codex',
        cwd: '/project',
        resume: { kind: 'codex-session', value: 'native' },
        terminal: { live: true, writeBase64: () => {} },
      },
      terminalProfileFor('codex')!,
    )
    // The resume re-tails the newest 207 items.
    runtime.observe({
      type: 'transcriptDelta',
      sessionId: f.sessionId,
      items: history.slice(-RESET),
      reset: true,
    })
    const observation = (
      transitionKind: AgentObservation['transitionKind'],
      seq: number,
      nextPhase: 'working' | 'idle',
    ): AgentObservation => ({
      podiumSessionId: f.sessionId,
      provider: 'codex',
      providerSessionId: 'native',
      bindingVersion: 1,
      providerTurnId: null,
      providerPromptId: null,
      observerGeneration: 1,
      providerCursor: { segmentId: 'bench-observation', components: { seq } },
      providerAt: new Date(base + 3_000_000 + seq).toISOString(),
      receivedAt: new Date(base + 3_000_000 + seq).toISOString(),
      sourceEventKind: 'bench-observation',
      transitionKind,
      provenance: 'live',
      inputOrigin: 'human',
      turnEpoch: 1,
      priorPhase: nextPhase === 'idle' ? 'working' : 'idle',
      nextPhase,
      transitionId: `bench-${seq}`,
      state:
        nextPhase === 'idle'
          ? {
              phase: 'idle',
              since: new Date(base + 3_000_000 + seq).toISOString(),
              nativeSubagentCount: 0,
              idle: { kind: 'done' },
            }
          : {
              phase: 'working',
              since: new Date(base + 3_000_000 + seq).toISOString(),
              nativeSubagentCount: 0,
            },
    })
    runtime.observe({
      type: 'agentObservation',
      observation: observation('turn_opened', 1, 'working'),
    })
    // The turn's one new record, which the live tail delivered.
    history.push(item(OLDER + RESET))
    runtime.observe({ type: 'transcriptDelta', sessionId: f.sessionId, items: history.slice(-1) })
    // And its last record, which the tail had not delivered when the turn ended:
    // what the reconcile exists to pick up.
    history.push(item(OLDER + RESET + 1))
    await f.settled()
    const eventsBefore = (await f.store.events.listRuntimeEvents(f.sessionId, 10_000)).length
    const feedBefore = await feedHead(f)
    const emittedBefore = emitted.length
    f.acks.length = 0

    const beat = heartbeat()
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    runtime.observe({
      type: 'agentObservation',
      observation: observation('turn_terminal', 2, 'idle'),
    })
    // The reconcile runs on its own; it is done when no frame was added for a
    // while and every delivered frame settled.
    let quietSince = performance.now()
    let seen = emitted.length
    while (performance.now() - quietSince < 250) {
      await f.settled()
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (emitted.length !== seen) {
        seen = emitted.length
        quietSince = performance.now()
      }
    }
    const wallMs = performance.now() - start - 250
    const cpu = process.cpuUsage(cpuStart)
    const longestTimerGapMs = await beat.stop()

    const replayedItems = emitted
      .slice(emittedBefore)
      .filter((event) => event.t === 'item' && event.item.kind === 'complete').length
    const events = await f.store.events.listRuntimeEvents(f.sessionId, 10_000)
    const transcript = f.registry.modules.sessions.sessions
      .get(f.sessionId)!
      .terminal.transcriptItems()
    assert.ok(f.acks.every((ack) => ack.outcome === 'committed'))
    // Every item the server holds is in store order, the turn's record included.
    const ids = transcript.map((value) => value.id)
    assert.equal(ids.at(-1), `item-${OLDER + RESET + 1}`)
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))),
    )
    return {
      historyItems: history.length,
      resetItems: RESET,
      wallMs,
      processCpuMs: (cpu.user + cpu.system) / 1_000,
      longestTimerGapMs,
      replayedItems,
      committedAcks: f.acks.length,
      durableEvents: events.length - eventsBefore,
      sessionFeedChanges: await sessionFeedChanges(f, feedBefore),
      serverTranscriptItems: transcript.length,
    }
  } finally {
    await f.registry.dispose()
    await f.store.close()
  }
}

async function burstArm() {
  const f = await fixture()
  try {
    let seq = 0
    const envelope = () => ({
      at: new Date(base).toISOString(),
      provenance: 'live' as const,
      cursor: { segmentId: 'replay-fixture', components: { seq: ++seq } },
      observerGeneration: 1,
      turnEpoch: 1,
    })
    const send = (event: RuntimeEvent) =>
      f.deliver({
        type: 'runtimeEvent',
        sessionId: f.sessionId,
        deliveryId: `event-${event.cursor.components.seq}`,
        event,
      })
    send({
      ...envelope(),
      t: 'state',
      provenance: 'bootstrap',
      change: { kind: 'session_started' },
    })
    const reset = Array.from({ length: RESET }, (_, n) => item(n))
    send({ ...envelope(), t: 'transcript-reset', items: reset })
    send({ ...envelope(), t: 'turn', ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' } })
    await f.settled()
    const eventsBefore = (await f.store.events.listRuntimeEvents(f.sessionId, 10_000)).length
    const feedBefore = await feedHead(f)
    f.acks.length = 0
    const replay = Array.from({ length: BURST }, (_, n) => item(RESET + n))

    const beat = heartbeat()
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    for (const value of replay) {
      send({ ...envelope(), t: 'item', at: value.ts!, item: { kind: 'complete', item: value } })
    }
    await f.settled()
    const wallMs = performance.now() - start
    const cpu = process.cpuUsage(cpuStart)
    const longestTimerGapMs = await beat.stop()

    const events = await f.store.events.listRuntimeEvents(f.sessionId, 10_000)
    assert.equal(f.acks.length, BURST)
    assert.ok(f.acks.every((ack) => ack.outcome === 'committed'))
    assert.equal(events.length - eventsBefore, BURST)
    const transcript = await f.registry.modules.rpc.readTranscript(
      { sessionId: f.sessionId, direction: 'before', limit: 2_000 },
      { kind: 'user', id: firstAdminMemberId() },
    )
    assert.deepEqual(
      transcript.items.map((value) => value.id),
      [...reset, ...replay].map((value) => value.id),
    )
    return {
      burstItems: BURST,
      wallMs,
      processCpuMs: (cpu.user + cpu.system) / 1_000,
      longestTimerGapMs,
      committedAcks: f.acks.length,
      durableEvents: events.length - eventsBefore,
      sessionFeedChanges: await sessionFeedChanges(f, feedBefore),
      orderedTranscriptItems: transcript.items.length,
    }
  } finally {
    await f.registry.dispose()
    await f.store.close()
  }
}

const arm = process.argv[2]
const result =
  arm === 'turnEnd'
    ? { turnEnd: await turnEndArm() }
    : arm === 'burst'
      ? { burst: await burstArm() }
      : { turnEnd: await turnEndArm(), burst: await burstArm() }
console.log(JSON.stringify({ backgroundEvents: BACKGROUND, ...result }))
