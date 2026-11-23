/**
 * POD-7292 workspace wake-up measurement, for an agent VM with the Postgres test server:
 * bun --conditions=@podium/source scripts/server-data-bench/workspace-wake-up.ts
 *
 * On a disposable clone of the Postgres test template it measures:
 *
 * 1. Publish-to-callback latency: one hub publishes, a second hub (its own LISTEN
 *    connection, as another process would have) receives. Sequential, idle database.
 * 2. Write throughput of N writers (1, 8, 32), each in its own workspace, each write one
 *    workspace write transaction appending one change row (the smallest synced write,
 *    so the notify's share is the largest it gets), in three modes:
 *    - `none`: no notify at all (the "before");
 *    - `each`: one NOTIFY statement after every commit, from a notifier per writer (each
 *      writer stands for a process of its own);
 *    - `tick`: what ships, one hub per process batching the ids of a tick into one
 *      statement.
 *    A cell's time runs until its last write committed AND its last notify was sent.
 *    Modes interleave over three rounds; the table shows the median round.
 */
import '../../test-hermetic-env'
import { asWorkspaceId, type WorkspaceId } from '@podium/model'
import { SessionStore } from '../../apps/server/src/store'
import { fleetDb } from '../../apps/server/src/store/executor/sync-drizzle'
import { feedHeadsOf } from '../../apps/server/src/store/wake-up-reads'
import { WakeUpHub, type WakeUpTransport } from '../../apps/server/src/store/workspace-wake-up'
import { pgWakeUpTransport } from '../../apps/server/src/store/workspace-wake-up-pg'
import { bunPgTestDatabase } from '../../apps/server/src/test-support/pg-test-host'

const WRITERS = [1, 8, 32] as const
const MODES = ['none', 'each', 'tick'] as const
type Mode = (typeof MODES)[number]
const ROUNDS = 3
const CELL_MS = 2_000
const LATENCY_SAMPLES = 400

/** A transport that counts its sends and can wait for those in flight. */
function counted(inner: WakeUpTransport) {
  const inFlight = new Set<Promise<void>>()
  const stats = { statements: 0, ids: 0 }
  const transport: WakeUpTransport = {
    kind: inner.kind,
    listen: (receive, onReady) => inner.listen(receive, onReady),
    send(ids) {
      stats.statements++
      stats.ids += ids.length
      const sending = inner.send(ids)
      inFlight.add(sending)
      void sending.finally(() => inFlight.delete(sending)).catch(() => undefined)
      return sending
    },
    close: () => inner.close(),
  }
  return {
    transport,
    stats,
    async drained() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
  }
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN
const median = (values: readonly number[]): number =>
  percentile(
    [...values].sort((a, b) => a - b),
    50,
  )

const database = await bunPgTestDatabase()
const closers: Array<() => Promise<void>> = []
try {
  const url = database.url
  const ids: WorkspaceId[] = WRITERS.at(-1)
    ? Array.from({ length: 32 }, (_, i) => asWorkspaceId(`bench-ws-${i}`))
    : []
  const first = await SessionStore.open(url, undefined, {
    workspace: ids[0] as WorkspaceId,
    poolSize: 72,
    wakeUp: { pollIntervalMs: 0 },
  })
  closers.push(async () => await first.close())
  const stores: SessionStore[] = [first]
  for (const id of ids.slice(1)) {
    await first.database.provisionWorkspace(id)
    stores.push(await first.database.workspace(id))
  }
  const readHeads = async (list: readonly WorkspaceId[]) =>
    await feedHeadsOf(fleetDb(first.database.queries), list)
  const hub = (transport: WakeUpTransport, batching: 'tick' | 'each') => {
    const made = new WakeUpHub({ transport, readHeads, pollIntervalMs: 0, batching })
    closers.push(async () => await made.close())
    return made
  }
  const pg = () => pgWakeUpTransport({ listenUrl: url, notifyUrl: url })

  // The receiving "process": subscribed to every workspace, so every notify is delivered.
  const listener = hub(pg(), 'tick')
  const received = new Map<WorkspaceId, Array<() => void>>()
  let receivedTotal = 0
  for (const id of ids) {
    listener.subscribe(id, () => {
      receivedTotal++
      for (const wake of received.get(id)?.splice(0) ?? []) wake()
    })
  }
  await listener.poll()

  // ---- 1. latency ----
  const tick = counted(pg())
  const tickHub = hub(tick.transport, 'tick')
  const latencies: number[] = []
  /** Publish `id` and wait for the listening hub's callback; false after two seconds. */
  const roundTrip = async (id: WorkspaceId): Promise<number | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const arrived = new Promise<boolean>((resolve) => {
      const waiting = received.get(id) ?? []
      waiting.push(() => resolve(true))
      received.set(id, waiting)
      timer = setTimeout(() => resolve(false), 2_000)
    })
    const started = performance.now()
    tickHub.publish(id)
    const ok = await arrived
    clearTimeout(timer)
    received.delete(id)
    return ok ? performance.now() - started : undefined
  }
  // Until the listener's LISTEN is in place, a signal can be missed: warm up until one lands.
  for (let tries = 0; (await roundTrip(ids[0] as WorkspaceId)) === undefined; tries++) {
    if (tries >= 10) throw new Error('the listening hub never received a notification')
  }
  let lost = 0
  for (let n = 0; n < LATENCY_SAMPLES + 20; n++) {
    const took = await roundTrip(ids[n % ids.length] as WorkspaceId)
    if (took === undefined) lost++
    else if (n >= 20) latencies.push(took)
  }
  if (lost > 0) throw new Error(`${lost} notifications were lost on an idle database`)
  latencies.sort((a, b) => a - b)

  // ---- 2. throughput ----
  const perWriter = ids.map(() => counted(pg()))
  const eachHubs = perWriter.map((writer) => hub(writer.transport, 'each'))
  let mode: Mode = 'none'
  // Route the stores' post-commit publish to the mode under test.
  first.database.wakeUps.publish = (id: WorkspaceId) => {
    if (mode === 'tick') tickHub.publish(id)
    else if (mode === 'each') eachHubs[ids.indexOf(id)]?.publish(id)
  }

  let entity = 0
  async function cell(writers: number, cellMode: Mode) {
    mode = cellMode
    const statementsBefore =
      cellMode === 'tick'
        ? tick.stats.statements
        : perWriter.reduce((sum, writer) => sum + writer.stats.statements, 0)
    const deadline = performance.now() + CELL_MS
    const started = performance.now()
    let writes = 0
    await Promise.all(
      stores.slice(0, writers).map(async (store) => {
        while (performance.now() < deadline) {
          await store.transact(async () => {
            await store.sync.appendChanges(
              [
                {
                  entity: 'agentProfile',
                  entityId: `bench-${entity++}`,
                  op: 'upsert',
                  payload: '{}',
                },
              ],
              Date.now(),
            )
          })
          writes++
        }
      }),
    )
    await tickHub.settled()
    await tick.drained()
    await Promise.all(perWriter.map(async (writer) => await writer.drained()))
    const elapsed = performance.now() - started
    const statementsAfter =
      cellMode === 'tick'
        ? tick.stats.statements
        : perWriter.reduce((sum, writer) => sum + writer.stats.statements, 0)
    return {
      perSecond: (writes / elapsed) * 1000,
      statements: cellMode === 'none' ? 0 : statementsAfter - statementsBefore,
      writes,
    }
  }

  const results = new Map<string, Array<Awaited<ReturnType<typeof cell>>>>()
  for (let round = 0; round < ROUNDS; round++) {
    for (const writers of WRITERS) {
      for (const cellMode of MODES) {
        const result = await cell(writers, cellMode)
        const key = `${writers}:${cellMode}`
        results.set(key, [...(results.get(key) ?? []), result])
      }
    }
  }

  console.log('\n## Publish-to-callback latency (Postgres, idle, two connections)\n')
  console.log(`| samples | p50 ms | p95 ms | p99 ms |`)
  console.log(`|---:|---:|---:|---:|`)
  console.log(
    `| ${latencies.length} | ${percentile(latencies, 50).toFixed(2)} | ${percentile(latencies, 95).toFixed(2)} | ${percentile(latencies, 99).toFixed(2)} |`,
  )
  console.log(
    `\n## Write throughput, writes/s (median of ${ROUNDS} rounds of ${CELL_MS} ms; one change row per write, one workspace per writer)\n`,
  )
  console.log(
    '| writers | no notify | notify each commit | change | batched per tick | change | notify statements per write (tick) |',
  )
  console.log('|---:|---:|---:|---:|---:|---:|---:|')
  for (const writers of WRITERS) {
    const rate = (cellMode: Mode) =>
      median((results.get(`${writers}:${cellMode}`) ?? []).map((r) => r.perSecond))
    const none = rate('none')
    const each = rate('each')
    const batched = rate('tick')
    const tickCells = results.get(`${writers}:tick`) ?? []
    const ratio =
      tickCells.reduce((sum, r) => sum + r.statements, 0) /
      Math.max(
        1,
        tickCells.reduce((sum, r) => sum + r.writes, 0),
      )
    const change = (value: number) => `${(((value - none) / none) * 100).toFixed(1)} %`
    console.log(
      `| ${writers} | ${none.toFixed(0)} | ${each.toFixed(0)} | ${change(each)} | ${batched.toFixed(0)} | ${change(batched)} | ${ratio.toFixed(2)} |`,
    )
  }
  console.log(`\nnotifications received by the listening hub: ${receivedTotal}`)
} finally {
  for (const close of closers.reverse()) await close().catch((error) => console.error(error))
  await database.drop()
}
