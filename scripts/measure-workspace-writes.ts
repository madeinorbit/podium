/**
 * Workspace serialization, through the production tRPC caller, daemon gateway,
 * session persistence and effect runner. Each worker is a separate server/store
 * composition and pool in a separate process; they share ONE disposable Postgres
 * template clone. No live database URL is accepted. No agents or PTYs are launched.
 *
 * Run on the agent VM, for example:
 *   bun --conditions=@podium/source scripts/measure-workspace-writes.ts \
 *     --writers 16 --workspaces 1 --processes 2 --latency-ms 2.6 --seconds 15
 *
 * Matrix: writers 1/4/16/64, workspaces 1/4, processes 1/2, latency 0/2.6.
 * --matrix runs eight configurations for the selected latency/process count.
 * --recorder-cost also times the local bookkeeping with no metric readers.
 * --out saves the full report. Stdout always contains WORKSPACE-LOCK-RESULT JSON.
 * Setup, warming and shutdown are excluded; admitted operations and their effects
 * drain before the measurement closes. Duration includes that drain.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import type { StatementProbeHolder } from '../apps/server/src/store/executor/statement-probe'
import type { WorkspaceWriteObservation } from '../apps/server/src/store/executor/workspace-write-metrics'

interface Config {
  writers: number
  workspaces: number
  processes: number
  latencyMs: number
  seconds: number
}

interface WorkerReport {
  elapsedMs: number
  operations: Record<string, number>
  sourceWrites: Record<string, number>
  samples: WorkspaceWriteObservation[]
  roundTrips: number
  injectedInsideHoldMs: number
  captureDrainMs: number
  captureDrains: number
  metrics: unknown
}

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const exited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null
const waitForExit = (child: ChildProcess): Promise<void> =>
  exited(child) ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve()))
const integer = (name: string, fallback: number): number => {
  const value = Number(argument(name) ?? fallback)
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`)
  return value
}

function configuration(): Config {
  const config = {
    writers: integer('writers', 16),
    workspaces: integer('workspaces', 1),
    processes: integer('processes', 1),
    latencyMs: Number(argument('latency-ms') ?? 2.6),
    seconds: integer('seconds', 15),
  }
  if (![1, 4, 16, 64].includes(config.writers)) throw new Error('writers must be 1, 4, 16 or 64')
  if (![1, 4].includes(config.workspaces)) throw new Error('workspaces must be 1 or 4')
  if (![1, 2].includes(config.processes)) throw new Error('processes must be 1 or 2')
  if (!Number.isFinite(config.latencyMs) || config.latencyMs < 0) throw new Error('invalid latency')
  return config
}

/** Same fractional-millisecond injection as statement-probe's injectRoundTripLatency. */
async function latency(ms: number): Promise<void> {
  const until = performance.now() + ms
  const whole = Math.floor(ms) - 1
  if (whole > 0) await new Promise((resolve) => setTimeout(resolve, whole))
  while (performance.now() < until) await new Promise((resolve) => setImmediate(resolve))
}

async function serverModules() {
  const serverPath = join(import.meta.dir, '../apps/server/src')
  const model: typeof import('@podium/model') = await import(
    Bun.resolveSync('@podium/model', serverPath)
  )
  const { z } = await import(Bun.resolveSync('zod', serverPath))
  const { SessionStore } = await import('../apps/server/src/store')
  const { SessionRegistry } = await import('../apps/server/src/relay')
  const { appRouter } = await import('../apps/server/src/router')
  const { RepoRegistry } = await import('../apps/server/src/repo-registry')
  const { SuperagentService } = await import('../apps/server/src/modules/superagent')
  const { userCommandPrincipal } = await import('../apps/server/src/command-principal')
  const { attachHostDaemon } = await import('../apps/server/src/test-support/host-daemon')
  const { NO_TARGET } = await import('../apps/server/src/modules/sync-write/registry')
  const probes = await import('../apps/server/src/store/executor/statement-probe')
  const { workspaceWriteMetrics } = await import(
    '../apps/server/src/store/executor/workspace-write-metrics'
  )
  return {
    model,
    z,
    SessionStore,
    SessionRegistry,
    appRouter,
    RepoRegistry,
    SuperagentService,
    userCommandPrincipal,
    attachHostDaemon,
    NO_TARGET,
    probes,
    workspaceWriteMetrics,
  }
}

async function worker(config: Config, workerIndex: number): Promise<void> {
  const url = process.env.WORKSPACE_LOAD_TEST_URL
  if (!url) throw new Error('the parent must provide a disposable template clone')
  const modules = await serverModules()
  const {
    model,
    z,
    SessionStore,
    SessionRegistry,
    appRouter,
    RepoRegistry,
    SuperagentService,
    userCommandPrincipal,
    attachHostDaemon,
    NO_TARGET,
    probes,
    workspaceWriteMetrics,
  } = modules
  type Registry = Awaited<ReturnType<typeof SessionRegistry.create>>
  type Store = InstanceType<typeof SessionStore>
  const contexts: {
    store: Store
    registry: Registry
    call: ReturnType<typeof appRouter.createCaller>
  }[] = []
  const writers: {
    index: number
    sessionId: SessionId
    sequence: number
    context: (typeof contexts)[number]
  }[] = []
  const stops: (() => void)[] = []
  let measuring = false
  let roundTrips = 0
  let injectedInsideHoldMs = 0
  let captureDrainMs = 0
  let captureDrains = 0
  const sourceWrites: Record<string, number> = {
    podium_events: 0,
    runtime_event_checkpoints: 0,
    messages: 0,
    effects: 0,
    sessions: 0,
  }
  let base: Store | undefined

  const settle = async () => {
    for (const { registry } of contexts) {
      await registry.modules.effects?.runner.idle()
      await registry.changeLedger.authority.settled()
      await registry.modules.sessions.flushBroadcasts()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  try {
    const mine = Array.from({ length: config.writers }, (_, i) => i).filter(
      (i) => Math.floor(i / config.workspaces) % config.processes === workerIndex,
    )
    const workspaceIndices = [...new Set(mine.map((i) => i % config.workspaces))]
    const workspaceStores: { store: Store; workspaceIndex: number }[] = []
    for (const workspaceIndex of workspaceIndices) {
      const workspace = model.asWorkspaceId(`ws_load_${workspaceIndex}`)
      let store: Store
      if (!base) {
        base = await SessionStore.open(url, undefined, {
          workspace,
          poolSize: 10,
          changeCapture: 'whenLogAttaches',
        })
        store = base
      } else {
        await base.database.provisionWorkspace(workspace)
        store = await base.database.workspace(workspace)
      }
      // A new hosted workspace has no self-hosted template member. Provision its
      // operator through the real membership row port before composing services.
      await store.users.memberRows.write({
        memberId: 'measurement-owner',
        version: 1,
        state: 'active',
        role: 'admin',
        accountId: 'measurement-account',
        profile: { name: 'Measurement operator', image: null, email: 'load@example.test' },
        actor: { system: 'setup' },
      })
      workspaceStores.push({ store, workspaceIndex })
    }
    for (const { store, workspaceIndex } of workspaceStores) {
      const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
      await attachHostDaemon(registry)
      registry.shipping.dispose()
      await registry.shipping.reconcile()
      const owner = await model.firstAdminMemberId(store)
      const repos = new RepoRegistry(registry, store)
      const superagent = await SuperagentService.create(registry.modules, repos, store)
      const call = appRouter.createCaller({
        registry,
        repos,
        superagent,
        capability: {
          role: 'admin',
          scope: { kind: 'owned', userId: owner },
          actorUser: owner,
          onBehalfOf: owner,
        },
        principal: userCommandPrincipal(owner, 'admin'),
      } as never)
      const context = { store, registry, call }
      contexts.push(context)
      const effects = registry.modules.effects
      if (!effects) throw new Error('effects module was not composed')
      effects.executors.register({
        kind: 'measurement.write',
        input: z.object({ n: z.number() }),
        target: async () => NO_TARGET,
        deadlineMs: 600_000,
        run: async () => ({ status: 'succeeded' }),
      })

      // Capture drain wall time includes its injected round trip. It is a subset
      // of hold time, not an additional cost to add to the statement/RT breakdown.
      const drain = store.sync.drainCapture.bind(store.sync)
      store.sync.drainCapture = async (after) => {
        const started = performance.now()
        try {
          return await drain(after)
        } finally {
          if (measuring) {
            captureDrainMs += performance.now() - started
            captureDrains++
          }
        }
      }
      for (const index of mine.filter((i) => i % config.workspaces === workspaceIndex)) {
        const cwd = `/measurement/session-${index}`
        const { sessionId } = await registry.modules.sessions.createSession({
          agentKind: 'codex',
          cwd,
        })
        await registry.gateway.routeDaemonFrame(store.hostMachineId, {
          type: 'bind',
          sessionId,
          cmd: 'codex',
          cwd,
          agentKind: 'codex',
          driverId: 'codex-app-server',
          geometry: { cols: 80, rows: 24 },
        } as never)
        writers.push({ index, sessionId, sequence: 0, context })
      }
    }

    const operations = {
      runtimeEvent: 0,
      messages: 0,
      effects: 0,
      sessionUpserts: 0,
    }
    const cycle = async (writer: (typeof writers)[number]) => {
      const { store, registry, call } = writer.context
      const n = ++writer.sequence
      const unique = `${workerIndex}-${writer.index}-${n}`
      // A distinct assistant transcript item reaches runtime events, checkpoint,
      // session state and the change feed through the production daemon gateway.
      await registry.gateway.routeDaemonFrame(store.hostMachineId, {
        type: 'runtimeEvent',
        sessionId: writer.sessionId,
        deliveryId: `load-${unique}`,
        event: {
          t: 'item',
          item: {
            kind: 'complete',
            item: {
              id: `item-${unique}`,
              role: 'assistant',
              text: `work ${unique}`,
              ts: new Date().toISOString(),
            },
          },
          at: new Date().toISOString(),
          provenance: 'live',
          cursor: { segmentId: 'measurement', components: { seq: n } },
          observerGeneration: 1,
          turnEpoch: 0,
        },
      } as never)
      if (measuring) operations.runtimeEvent++
      await call.messages.send({ to: writer.sessionId, body: `message ${unique}` } as never)
      if (measuring) operations.messages++
      const effectId = model.mintDeviceId('eff_')
      const reply = await call.sync.submit({
        mutationId: model.asMutationId(`load-${unique}`),
        command: 'effects.create',
        version: 1,
        input: {
          id: effectId,
          kind: 'measurement.write',
          target: { kind: 'session', id: writer.sessionId },
          input: { n },
        },
      })
      if (reply.outcome !== 'applied')
        throw new Error(`effect command refused: ${JSON.stringify(reply)}`)
      if (measuring) operations.effects++
      // Output then the real coalesced activity path persists session upserts.
      await registry.gateway.routeDaemonFrame(store.hostMachineId, {
        type: 'agentFrame',
        sessionId: writer.sessionId,
        seq: n,
        data: 'd29yaw==',
      } as never)
      await registry.modules.sessions.flushActivity()
      if (measuring) operations.sessionUpserts++
    }

    // Warm the actual operation and all statement shapes, then settle setup.
    for (const writer of writers) await cycle(writer)
    await settle()
    if (base) {
      const sourcePatterns = Object.keys(sourceWrites).map(
        (table) =>
          [
            table,
            new RegExp(`\\b(?:insert into|update|delete from) "?${table}"?\\b`, 'i'),
          ] as const,
      )
      stops.push(
        probes.probeStatements(base as unknown as StatementProbeHolder, (statement) => {
          if (!measuring || statement.intent !== 'write') return
          for (const [table, pattern] of sourcePatterns) {
            if (pattern.test(statement.sql)) sourceWrites[table] = (sourceWrites[table] ?? 0) + 1
          }
        }),
      )
      stops.push(
        // Workspace handles on this database share one probe hub.
        probes.probeRoundTrips(base as unknown as StatementProbeHolder, (trip) => {
          if (measuring) roundTrips++
          if (config.latencyMs === 0) return
          const inHold = trip.lane === 'write' && !trip.root && trip.call !== 'begin'
          const started = performance.now()
          return latency(config.latencyMs).then(() => {
            if (measuring && inHold) injectedInsideHoldMs += performance.now() - started
          })
        }),
      )
    }
    process.send?.({ type: 'ready' })
    await new Promise<void>((resolve) => {
      const start = (message: unknown) => {
        if ((message as { type?: string }).type !== 'start') return
        process.off('message', start)
        resolve()
      }
      process.on('message', start)
    })
    const samples: WorkspaceWriteObservation[] = []
    stops.push(
      workspaceWriteMetrics.probe((sample) => {
        if (measuring) samples.push(sample)
      }),
    )
    const began = performance.now()
    const until = began + config.seconds * 1_000
    measuring = true
    await Promise.all(
      writers.map(async (writer) => {
        while (performance.now() < until) await cycle(writer)
      }),
    )
    await settle()
    await settle()
    measuring = false
    const report: WorkerReport = {
      elapsedMs: performance.now() - began,
      operations,
      sourceWrites,
      samples,
      roundTrips,
      injectedInsideHoldMs,
      captureDrainMs,
      captureDrains,
      metrics: workspaceWriteMetrics.snapshot(),
    }
    process.send?.({ type: 'result', report })
  } finally {
    for (const stop of stops) stop()
    for (const { registry } of contexts) await registry.dispose()
    await base?.close()
    process.disconnect?.()
  }
}

function quantiles(values: number[]) {
  values.sort((a, b) => a - b)
  const at = (q: number) => values[Math.max(0, Math.ceil(q * values.length) - 1)] ?? 0
  return { count: values.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) }
}

function summarize(reports: WorkerReport[], config: Config) {
  const samples = reports.flatMap((r) => r.samples)
  const committed = samples.filter((s) => s.outcome === 'committed')
  const elapsedMs = Math.max(...reports.map((r) => r.elapsedMs))
  const sum = (select: (s: WorkspaceWriteObservation) => number) =>
    committed.reduce((n, s) => n + select(s), 0)
  const total = (select: (r: WorkerReport) => number) => reports.reduce((n, r) => n + select(r), 0)
  const mean = (select: (s: WorkspaceWriteObservation) => number) => sum(select) / committed.length
  const waits = (which: readonly WorkspaceWriteObservation[]) => ({
    databaseWaitMs: quantiles(which.flatMap((s) => (s.waitMs === undefined ? [] : [s.waitMs]))),
    schedulerQueueMs: quantiles(which.map((s) => s.schedulerQueueMs)),
    workspaceWriteWaitMs: quantiles(
      which.flatMap((s) => (s.waitMs === undefined ? [] : [s.waitMs + s.schedulerQueueMs])),
    ),
    holdMs: quantiles(which.map((s) => s.holdMs)),
  })
  const operations: Record<string, number> = {}
  const sourceWrites: Record<string, number> = {}
  for (const r of reports)
    for (const [key, n] of Object.entries(r.operations))
      operations[key] = (operations[key] ?? 0) + n
  for (const r of reports)
    for (const [key, n] of Object.entries(r.sourceWrites))
      sourceWrites[key] = (sourceWrites[key] ?? 0) + n
  const byWorkspace = Object.fromEntries(
    [...new Set(committed.map((s) => s.workspaceId))].map((workspace) => {
      const writes = committed.filter((s) => s.workspaceId === workspace)
      return [
        workspace,
        {
          writes: writes.length,
          writesPerSecond: (writes.length * 1_000) / elapsedMs,
          ...waits(writes),
        },
      ]
    }),
  )
  if (committed.length === 0 || Object.values(operations).some((n) => n === 0))
    throw new Error('load did not exercise every operation')
  if (Object.values(sourceWrites).some((n) => n === 0))
    throw new Error(`load missed a source table: ${JSON.stringify(sourceWrites)}`)
  if (samples.some((s) => s.outcome !== 'committed'))
    throw new Error('load had an acquisition failure or a rollback')
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    at: new Date().toISOString(),
    config,
    elapsedMs,
    operations,
    sourceWrites,
    committed: committed.length,
    writesPerSecond: (committed.length * 1_000) / elapsedMs,
    ...waits(committed),
    byWorkspace,
    roundTripsPerWrite: mean((s) => s.roundTrips),
    statementsPerWrite: mean((s) => s.statements),
    allRoundTrips: total((r) => r.roundTrips),
    holdBreakdownMeanMs: {
      hold: mean((s) => s.holdMs),
      nativeDriver: mean((s) => s.driverMs),
      nativeStatements: mean((s) => s.statementMs),
      injectedRoundTrips: total((r) => r.injectedInsideHoldMs) / committed.length,
      captureDrain: total((r) => r.captureDrainMs) / committed.length,
      other:
        (sum((s) => s.holdMs - s.driverMs) - total((r) => r.injectedInsideHoldMs)) /
        committed.length,
    },
    captureDrains: total((r) => r.captureDrains),
    metrics: reports.map((r) => r.metrics),
  }
}

async function parent(config: Config) {
  const { bunPgTestDatabase } = await import('../apps/server/src/test-support/pg-test-host')
  const database = await bunPgTestDatabase()
  const scratch = mkdtempSync(join(tmpdir(), 'workspace-write-load-'))
  const children: ChildProcess[] = []
  try {
    const active: { child: ChildProcess; result: Promise<WorkerReport> }[] = []
    for (let index = 0; index < config.processes; index++) {
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.startsWith('PODIUM_')) delete env[key]
      Object.assign(env, {
        WORKSPACE_LOAD_TEST_URL: database.url,
        PODIUM_STATE_DIR: join(scratch, `worker-${index}`),
        PODIUM_MODE: 'all-in-one',
        NODE_ENV: 'test',
      })
      const child = spawn(
        process.execPath,
        [
          '--conditions=@podium/source',
          import.meta.path,
          '--writers',
          String(config.writers),
          '--workspaces',
          String(config.workspaces),
          '--processes',
          String(config.processes),
          '--latency-ms',
          String(config.latencyMs),
          '--seconds',
          String(config.seconds),
          '--worker',
          String(index),
        ],
        { env, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
      )
      children.push(child)
      let output = ''
      child.stdout?.on('data', (data) => {
        output = (output + String(data)).slice(-16_384)
      })
      let readyResolve: () => void = () => {}
      let readyReject: (error: Error) => void = () => {}
      let resultResolve: (value: WorkerReport) => void = () => {}
      let resultReject: (error: Error) => void = () => {}
      let gotReady = false
      let gotResult = false
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve
        readyReject = reject
      })
      const result = new Promise<WorkerReport>((resolve, reject) => {
        resultResolve = resolve
        resultReject = reject
      })
      // Consume early rejection while setup waits for this worker's ready message.
      void result.catch(() => {})
      child.on('message', (message) => {
        const msg = message as { type: string; report: WorkerReport }
        if (msg.type === 'ready') {
          gotReady = true
          readyResolve()
        }
        if (msg.type === 'result') {
          gotResult = true
          resultResolve(msg.report)
        }
      })
      child.on('error', (error) => {
        readyReject(error)
        resultReject(error)
      })
      child.on('exit', (code) => {
        if (code !== 0 || !gotReady || !gotResult) {
          const error = new Error(`worker ${index} exited ${code}: ${output}`)
          readyReject(error)
          resultReject(error)
        }
      })
      await ready
      active.push({ child, result })
    }
    for (const { child } of active) child.send({ type: 'start' })
    const result = summarize(await Promise.all(active.map((a) => a.result)), config)
    // A worker's result precedes its cleanup; do not drop its database underneath it.
    await Promise.all(children.map(waitForExit))
    if (children.some((child) => child.exitCode !== 0)) throw new Error('worker cleanup failed')
    console.log(`WORKSPACE-LOCK-RESULT ${JSON.stringify(result)}`)
    return result
  } finally {
    for (const child of children) if (!exited(child)) child.kill('SIGTERM')
    await Promise.all(children.map(waitForExit))
    await database.drop()
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function recorderCost(): Promise<void> {
  const {
    PlainRoundTripBaseline,
    WorkspaceWriteTiming,
    WorkspaceWriteMetrics,
    withWorkspaceWriteAdmission,
  } = await import('../apps/server/src/store/executor/workspace-write-metrics')
  const iterations = 100_000
  const rounds: number[] = []
  for (let round = 0; round < 5; round++) {
    const metrics = new WorkspaceWriteMetrics()
    const baseline = new PlainRoundTripBaseline()
    baseline.record(0.1)
    const started = performance.now()
    for (let i = 0; i < iterations; i++) {
      metrics.recordQueue('ws_cost', 0)
      withWorkspaceWriteAdmission(0, () => {
        const timing = new WorkspaceWriteTiming(baseline, metrics)
        timing.begin('ws_cost')
        timing.acquired()
        for (let trip = 0; trip < 4; trip++) {
          const at = performance.now()
          timing.pipeline(
            performance.now() - at,
            trip === 0 ? 3 : 1,
            trip === 1 || trip === 2 ? 1 : 0,
            true,
            trip === 0,
          )
        }
        timing.end('committed')
      })
    }
    rounds.push(((performance.now() - started) * 1_000) / iterations)
  }
  console.log(
    `WORKSPACE-RECORDER-COST ${JSON.stringify({ iterations, roundsUsPerWrite: rounds, medianUsPerWrite: quantiles(rounds).p50 })}`,
  )
}

if (import.meta.main) {
  const config = configuration()
  const index = argument('worker')
  if (index !== undefined) await worker(config, Number(index))
  else {
    if (process.argv.includes('--recorder-cost')) await recorderCost()
    const results: Awaited<ReturnType<typeof parent>>[] = []
    const configurations = process.argv.includes('--matrix')
      ? [1, 4, 16, 64].flatMap((writers) =>
          [1, 4].map((workspaces) => ({ ...config, writers, workspaces })),
        )
      : [config]
    for (const next of configurations) {
      console.error(
        `workspace load: ${next.writers} writers, ${next.workspaces} workspaces, ${next.processes} processes, ${next.latencyMs} ms`,
      )
      results.push(await parent(next))
      const out = argument('out')
      if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`)
    }
  }
}
