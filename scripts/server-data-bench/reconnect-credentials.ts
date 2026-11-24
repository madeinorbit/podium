/**
 * POD-7414 section 6: 197 audited credential deliveries on a daemon reconnect.
 * Run on an agent VM:
 * bun --conditions=@podium/source scripts/server-data-bench/reconnect-credentials.ts
 *
 * Five alternating before/after pairs share one generated disposable on-disk
 * SQLite store. Only probeEach is replaced in the before arm, with its original
 * sequential loop; authorization, vault reads and durable audits remain real.
 * Setup, warm-up, verification and the final heartbeat drain are not timed.
 */
import '../../test-hermetic-env'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId, type MachineId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { sealCredentialSecret } from '../../apps/server/src/modules/credentials/vault'
import {
  isRefreshRefused,
  type MachineReconcilerPorts,
  type ParkedOnMachine,
  SessionMachineReconciler,
} from '../../apps/server/src/modules/sessions/machine-reconciler'
import type { Session } from '../../apps/server/src/modules/sessions/session'
import { SessionRegistry } from '../../apps/server/src/relay'
import {
  probeStatements,
  type StatementProbeHolder,
} from '../../apps/server/src/store/executor/statement-probe'
import { attachHostDaemon } from '../../apps/server/src/test-support/host-daemon'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'

const SESSIONS = 197
const PAIRS = 5
const HEARTBEAT_MS = 20
const FAKE_SECRET = 'sk-FAKE-reconnect-benchmark'

// Benchmark-only access to the old loop's private ports. No alternate policy,
// authorization implementation, audit implementation or product switch exists.
interface ProbeLoop {
  ports: MachineReconcilerPorts
  withSession(
    id: SessionId,
    reason: string,
    fn: (session: Session | undefined) => Promise<void>,
  ): Promise<void>
  probeEach(probes: readonly ParkedOnMachine[], machineId: MachineId): Promise<void>
}
const prototype = SessionMachineReconciler.prototype as unknown as ProbeLoop
const paced = prototype.probeEach
const unpaced: ProbeLoop['probeEach'] = async function (this: ProbeLoop, probes, machineId) {
  for (const candidate of probes) {
    await this.withSession(candidate.sessionId, 'reattachProbe', async (s) => {
      if (!s) return
      const message = await this.ports.reattachMessage(s, machineId)
      const refresh = await this.ports.accessRefresh?.(s, machineId)
      const awaiting = s.awaitingRebind === true && (s.status === 'live' || s.status === 'starting')
      if (s.machineId !== machineId || s.archived || (!awaiting && s.status !== 'exited')) return
      if (refresh && !isRefreshRefused(refresh)) this.ports.toMachine(machineId, refresh)
      this.ports.toMachine(machineId, message)
    })
  }
}

interface Sample {
  arm: 'before' | 'after'
  wallMs: number
  processCpuMs: number
  longestTimerGapMs: number
  ticksDuringReconnect: number
  statements: number
  auditInserts: number
  durableDeliveryAudits: number
  refreshes: number
  reattaches: number
}

const directory = mkdtempSync(join(tmpdir(), 'reconnect-credentials-'))
let store: Awaited<ReturnType<typeof openTestStore>> | undefined
let registry: SessionRegistry | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined
let detachProbe: (() => void) | undefined
let detachAuditProbe: (() => void) | undefined
try {
  store = await openTestStore(join(directory, 'reconnect.db'))
  const credential = await store.credentials.insert({
    ownerUserId: await firstAdminMemberId(store),
    label: 'Generated reconnect credential',
    type: 'anthropic.api-key',
  })
  assert.equal(await sealCredentialSecret(store, credential, FAKE_SECRET, 0), 1)
  registry = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    sessionResidency: { evictParked: true, sweepIntervalMs: 0 },
  })
  const reg = registry
  const database = store
  await attachHostDaemon(reg)
  const machine = store.hostMachine!.id
  const ids: SessionId[] = []
  for (let n = 0; n < SESSIONS; n++) {
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/project',
      credentialId: credential.id,
    })
    await reg.gateway.routeDaemonFrame(machine, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/project',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    await reg.gateway.routeDaemonFrame(machine, { type: 'agentExit', sessionId, code: 0 })
    ids.push(sessionId)
  }
  await reg.modules.sessions.flushActivity()
  reg.modules.sessions.residency.sweep()
  for (const id of ids) assert.equal(reg.modules.sessions.sessions.has(id), false)

  const rows = () => database.settingsAudit.list(100_000)
  const auditIds = (audits: Awaited<ReturnType<typeof rows>>) =>
    audits
      .filter((row) => row.command === 'credentials.deliver')
      .map((row) => (row.detail as { sessionId: SessionId }).sessionId)
  let committedDeliveries = auditIds(await rows()).length
  // Observe actual durable INSERT completions without adding reads to the
  // timed path. No statement is skipped, delayed, injected or batched.
  detachAuditProbe = probeStatements(database as unknown as StatementProbeHolder, (observation) => {
    if (/^insert into "settings_audit_events"/i.test(observation.sql)) {
      committedDeliveries++
    }
  })
  let expectedOrder: SessionId[] | undefined
  async function sample(arm: Sample['arm']): Promise<Sample> {
    prototype.probeEach = arm === 'before' ? unpaced : paced
    reg.gateway.detachDaemon(machine)
    const auditBefore = (await rows()).length
    const committedBefore = committedDeliveries
    const frames: ControlMessage[] = []
    let statements = 0
    let auditInserts = 0
    detachProbe = probeStatements(database as unknown as StatementProbeHolder, (observation) => {
      statements++
      if (/^insert into "settings_audit_events"/i.test(observation.sql)) auditInserts++
    })
    let ticks = 0
    let longestTimerGapMs = 0
    let lastTick = performance.now()
    heartbeat = setInterval(() => {
      const now = performance.now()
      longestTimerGapMs = Math.max(longestTimerGapMs, now - lastTick)
      lastTick = now
      ticks++
    }, HEARTBEAT_MS)
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    await attachHostDaemon(reg, (message) => {
      if (message.type !== 'sessionAccessRefresh' && message.type !== 'reattach') return
      if (message.type === 'sessionAccessRefresh') {
        assert.equal(committedDeliveries - committedBefore, frames.length / 2 + 1)
      }
      frames.push(message)
    })
    const wallMs = performance.now() - start
    const cpu = process.cpuUsage(cpuStart)
    const ticksDuringReconnect = ticks
    detachProbe()
    detachProbe = undefined
    // Even the fully blocked arm must let the timer report its final gap.
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS + 5))
    clearInterval(heartbeat)
    heartbeat = undefined

    const refreshes = frames.filter((frame) => frame.type === 'sessionAccessRefresh')
    const reattaches = frames.filter((frame) => frame.type === 'reattach')
    const order = reattaches.map((frame) => frame.sessionId)
    expectedOrder ??= order
    assert.deepEqual(order, expectedOrder)
    assert.deepEqual([...order].sort(), [...ids].sort())
    assert.equal(frames.length, SESSIONS * 2)
    for (let n = 0; n < frames.length; n += 2) {
      assert.equal(frames[n]!.type, 'sessionAccessRefresh')
      assert.equal(frames[n + 1]!.type, 'reattach')
      assert.equal(
        (frames[n] as { sessionId: SessionId }).sessionId,
        (frames[n + 1] as { sessionId: SessionId }).sessionId,
      )
    }
    const added = (await rows()).slice(auditBefore)
    const delivered = auditIds(added)
    assert.deepEqual(delivered, order)
    assert.equal(auditInserts, SESSIONS)
    return {
      arm,
      wallMs,
      processCpuMs: (cpu.user + cpu.system) / 1_000,
      longestTimerGapMs,
      ticksDuringReconnect,
      statements,
      auditInserts,
      durableDeliveryAudits: delivered.length,
      refreshes: refreshes.length,
      reattaches: reattaches.length,
    }
  }

  await sample('before')
  await sample('after')
  const samples: Sample[] = []
  for (let pair = 0; pair < PAIRS; pair++) {
    for (const arm of pair % 2 === 0
      ? (['before', 'after'] as const)
      : (['after', 'before'] as const)) {
      const result = await sample(arm)
      samples.push(result)
      console.log(JSON.stringify({ pair, ...result }))
    }
  }
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
  const summary = (arm: Sample['arm']) => {
    const group = samples.filter((sample) => sample.arm === arm)
    return {
      medianWallMs: median(group.map((sample) => sample.wallMs)),
      medianProcessCpuMs: median(group.map((sample) => sample.processCpuMs)),
      medianLongestTimerGapMs: median(group.map((sample) => sample.longestTimerGapMs)),
      worstTimerGapMs: Math.max(...group.map((sample) => sample.longestTimerGapMs)),
      statements: group.map((sample) => sample.statements),
      auditInsertsPerReconnect: SESSIONS,
    }
  }
  console.log(
    'RECONNECT-CREDENTIALS-RESULT',
    JSON.stringify({
      sessions: SESSIONS,
      pairs: PAIRS,
      timerPeriodMs: HEARTBEAT_MS,
      bunVersion: Bun.version,
      engine: 'sqlite',
      storage: 'disposable on-disk database',
      before: summary('before'),
      after: summary('after'),
      samples,
    }),
  )
} finally {
  prototype.probeEach = paced
  if (heartbeat) clearInterval(heartbeat)
  detachProbe?.()
  detachAuditProbe?.()
  await registry?.dispose()
  await store?.close()
  rmSync(directory, { recursive: true, force: true })
}
