/**
 * Generated POD-7414 replay fixture, for an agent VM only:
 * bun --conditions=@podium/source scripts/server-data-bench/runtime-replay.ts
 *
 * Run this same script on the parent and candidate. Setup and verification are
 * outside the measured replay; no live server, daemon or provider is contacted.
 */
import '../../test-hermetic-env'
import assert from 'node:assert/strict'
import { firstAdminMemberId, type TranscriptItem } from '@podium/model'
import type { ControlMessage, RuntimeEvent } from '@podium/protocol/daemon'
import { SessionRegistry } from '../../apps/server/src/relay'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'

const BACKGROUND = 48_434
const RESET = 207
const REPLAY = 1_600
const base = Date.parse('2026-08-23T00:00:00.000Z')
const item = (n: number): TranscriptItem => ({
  id: `item-${n}`,
  cursor: `transcript:${n}`,
  role: n % 2 === 0 ? 'user' : 'assistant',
  text: `Generated message ${n}. ${'Transcript replay fixture. '.repeat(8)}`,
  ts: new Date(base + n * 1_000).toISOString(),
})

const store = await openTestStore(':memory:')
let registry: SessionRegistry | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined
try {
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
  registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const machineId = store.hostMachine!.id
  const acknowledgements: Extract<ControlMessage, { type: 'runtimeEventAck' }>[] = []
  await store.machines.upsertMachine({
    id: machineId,
    name: 'Replay fixture',
    hostname: 'test',
    tokenHash: 'test',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: true, agentExecution: true },
  })
  await registry.gateway.attachDaemon(machineId, (msg) => {
    if (msg.type === 'runtimeEventAck') acknowledgements.push(msg)
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
  let seq = 0
  const envelope = () => ({
    at: new Date(base).toISOString(),
    provenance: 'live' as const,
    cursor: { segmentId: 'replay-fixture', components: { seq: ++seq } },
    observerGeneration: 1,
    turnEpoch: 1,
  })
  const send = async (event: RuntimeEvent) => {
    await registry!.gateway.routeDaemonFrame(machineId, {
      type: 'runtimeEvent',
      sessionId,
      deliveryId: `event-${event.cursor.components.seq}`,
      event,
    })
  }
  await send({
    ...envelope(),
    t: 'state',
    provenance: 'bootstrap',
    change: { kind: 'session_started' },
  })
  const reset = Array.from({ length: RESET }, (_, n) => item(n))
  await send({ ...envelope(), t: 'transcript-reset', items: reset })
  await send({ ...envelope(), t: 'turn', ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' } })
  const beforeEvents = (await store.events.listRuntimeEvents(sessionId, 10_000)).length
  const beforeChanges = await store.sync.changesSince(0, 10_000)
  const beforeSeq = beforeChanges.at(-1)?.seq ?? 0
  acknowledgements.length = 0
  const replay = Array.from({ length: REPLAY }, (_, n) => item(RESET + n))
  let ticks = 0
  let longestTimerGapMs = 0
  let lastTick = performance.now()
  heartbeat = setInterval(() => {
    const now = performance.now()
    longestTimerGapMs = Math.max(longestTimerGapMs, now - lastTick)
    lastTick = now
    ticks++
  }, 20)
  const cpuStart = process.cpuUsage()
  const start = performance.now()
  for (const value of replay) {
    await send({ ...envelope(), t: 'item', at: value.ts!, item: { kind: 'complete', item: value } })
  }
  const replayWallMs = performance.now() - start
  const cpu = process.cpuUsage(cpuStart)
  // Let the pending timer observe the final gap even on the unpaced parent.
  await new Promise((resolve) => setTimeout(resolve, 25))
  clearInterval(heartbeat)
  heartbeat = undefined
  const events = await store.events.listRuntimeEvents(sessionId, 10_000)
  const changes = await store.sync.changesSince(beforeSeq, 10_000)
  const sessionChanges = changes.filter(
    (change) => change.entity === 'session' && change.entityId === sessionId,
  )
  assert.equal(acknowledgements.length, REPLAY)
  assert.ok(acknowledgements.every((ack) => ack.outcome === 'committed'))
  assert.equal(events.length - beforeEvents, REPLAY)
  assert.equal(sessionChanges.length, REPLAY)
  const expected = [...reset, ...replay]
  const transcript = await registry.modules.rpc.readTranscript(
    { sessionId, direction: 'before', limit: 2_000 },
    { kind: 'user', id: firstAdminMemberId() },
  )
  assert.deepEqual(
    transcript.items.map((value) => value.id),
    expected.map((value) => value.id),
  )
  console.log(
    JSON.stringify({
      backgroundEvents: BACKGROUND,
      resetItems: RESET,
      replayItems: REPLAY,
      replayWallMs,
      processCpuMs: (cpu.user + cpu.system) / 1_000,
      timerPeriodMs: 20,
      longestTimerGapMs,
      timerTicks: ticks,
      committedAcks: acknowledgements.length,
      durableEvents: events.length - beforeEvents,
      sessionFeedChanges: sessionChanges.length,
      orderedTranscriptItems: transcript.items.length,
    }),
  )
} finally {
  if (heartbeat) clearInterval(heartbeat)
  await registry?.dispose()
  await store.close()
}
