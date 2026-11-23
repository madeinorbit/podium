/**
 * Before/after daemon-loop blocking of a runtime ACK drain (POD-7438), on a
 * disposable generated outbox. Run on a test VM:
 * bun --conditions=@podium/source scripts/server-data-bench/runtime-event-ack-drain.ts <baseline-commit> [result.json]
 *
 * Both arms use the real connection ACK handler and the arm's own outbox
 * source. ACKs arrive in batches, one batch per macrotask, the way a reconnect
 * replay delivers WebSocket frames; a 1 ms interval timer measures how long
 * the loop was unable to run it. Each arm is then killed with SIGKILL in the
 * middle of a drain and reopened, to show the recovered pending set is exact.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { MachineId, SessionId } from '@podium/model'
import type { DurableRuntimeEvent } from '../../apps/daemon/src/runtime-event-outbox'

type Arm = 'before' | 'after'
type Api = typeof import('../../apps/daemon/src/runtime-event-outbox') &
  typeof import('../../apps/daemon/src/connection-state') &
  typeof import('../../apps/daemon/src/build-report') &
  typeof import('../../apps/daemon/src/queue-drain-outbox')
type Sample = {
  arm: Arm
  size: number
  repeat: number
  /** Longest interval between two runs of the 1 ms probe timer during the drain. */
  maxTimerGapMs: number
  /** Longest single ACK batch, measured around the handler calls. */
  maxBatchMs: number
  /** Sum of the batch times: daemon-thread time the drain consumed. */
  loopBusyMs: number
  /** First ACK to last ACK handled. */
  drainWallMs: number
  /** First ACK until every ACK record and compaction is durable. */
  durableWallMs: number
}

const checkout = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const [baselineRef, output = join(tmpdir(), 'runtime-event-ack-drain-results.json')] =
  process.argv.slice(2)
if (!baselineRef) throw new Error('Pass the baseline commit as the first argument')
function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: checkout })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trimEnd()
}
const baseline = git('rev-parse', '--verify', `${baselineRef}^{commit}`)
const candidate = git('rev-parse', 'HEAD')
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Commit the candidate first')
const root = mkdtempSync(join(tmpdir(), 'podium-runtime-event-ack-drain-'))
const sizes = [266, 1068, 1767] // POD-7414 section 3 ACK bursts.
const batch = 16
const repeats = 5
const killPoints = [0.2, 0.5, 0.85]
const samples: Sample[] = []
const bundles: Record<Arm, string> = { before: '', after: '' }

async function bundle(arm: Arm): Promise<Api> {
  const entry = join(root, `${arm}-entry.ts`)
  writeFileSync(
    entry,
    ['runtime-event-outbox', 'connection-state', 'build-report', 'queue-drain-outbox']
      .map(
        (name) =>
          `export * from ${JSON.stringify(resolve(checkout, 'apps/daemon/src', `${name}.ts`))}`,
      )
      .join('\n'),
  )
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    conditions: ['@podium/source'],
    // Only the outbox differs between the arms; everything else is the candidate's.
    plugins:
      arm === 'before'
        ? [
            {
              name: 'baseline-source',
              setup(build) {
                build.onLoad(
                  { filter: /\/apps\/daemon\/src\/runtime-event-outbox\.ts$/ },
                  ({ path }) => ({
                    contents: git('show', `${baseline}:${path.slice(checkout.length + 1)}`),
                    loader: 'ts',
                  }),
                )
              },
            },
          ]
        : [],
  })
  if (!result.success) throw new AggregateError(result.logs, 'Benchmark source bundle failed')
  assert.equal(result.outputs.length, 1)
  const [bundled] = result.outputs
  assert(bundled)
  const path = join(root, `${arm}.mjs`)
  await Bun.write(path, bundled)
  bundles[arm] = path
  return import(pathToFileURL(path).href) as Promise<Api>
}

function event(id: string, seq: number): DurableRuntimeEvent {
  return {
    type: 'runtimeEvent',
    deliveryId: id,
    sessionId: 'benchmark-session' as SessionId,
    event: {
      t: 'state',
      change: { kind: 'activity' },
      at: '2026-11-23T00:00:00.000Z',
      provenance: 'live',
      observerGeneration: 1,
      turnEpoch: 1,
      cursor: { segmentId: 'segment', components: { seq } },
    },
  }
}

const settledOf = (outbox: object): Promise<void> =>
  'settled' in outbox && typeof outbox.settled === 'function'
    ? (outbox.settled as () => Promise<void>)()
    : Promise.resolve()

async function sample(api: Api, arm: Arm, size: number, repeat: number): Promise<void> {
  const dir = join(root, `${repeat}-${size}-${arm}`)
  mkdirSync(dir)
  const events = Array.from({ length: size }, (_, i) => event(`delivery-${i}`, i + 1))
  writeFileSync(join(dir, 'runtime-event-outbox.json'), JSON.stringify({ version: 1, events }))
  const outbox = api.createRuntimeEventOutbox(dir)
  const conn = api.createDaemonConnection({
    options: { identityDir: join(dir, 'identity'), serverUrl: 'ws://unused' },
    build: api.buildReport({}, undefined, 'benchmark'),
    machineId: '11111111-1111-4111-8111-111111111111' as MachineId,
    identity: {},
    receiveApplicationFrame() {},
    sendApplicationFrame: () => true,
    queueDrainOutbox: api.createQueueDrainOutbox(join(dir, 'queue')),
    runtimeEventOutbox: outbox,
    onConnected() {},
    onTerminal() {},
  })
  try {
    assert.equal(outbox.pending().length, size)
    Bun.gc(true)
    let maxTimerGapMs = 0
    let maxBatchMs = 0
    let loopBusyMs = 0
    let last = performance.now()
    const probe = setInterval(() => {
      const now = performance.now()
      maxTimerGapMs = Math.max(maxTimerGapMs, now - last)
      last = now
    }, 1)
    // Let the probe establish its cadence before the first ACK.
    await Bun.sleep(20)
    const start = performance.now()
    last = start
    await new Promise<void>((done) => {
      let next = 0
      const step = (): void => {
        const batchStart = performance.now()
        const end = Math.min(size, next + batch)
        for (; next < end; next++) conn.acknowledgeRuntimeEvent(`delivery-${next}`)
        const took = performance.now() - batchStart
        loopBusyMs += took
        maxBatchMs = Math.max(maxBatchMs, took)
        if (next < size) setImmediate(step)
        else done()
      }
      setImmediate(step)
    })
    const drainWallMs = performance.now() - start
    await settledOf(outbox)
    const durableWallMs = performance.now() - start
    // Count a final gap that the drain's last batch may have left open.
    await Bun.sleep(5)
    clearInterval(probe)
    assert.equal(outbox.pending().length, 0)
    outbox.close()
    const recovered = api.createRuntimeEventOutbox(dir)
    try {
      assert.deepEqual(recovered.pending(), [])
    } finally {
      recovered.close()
    }
    const row: Sample = {
      arm,
      size,
      repeat,
      maxTimerGapMs,
      maxBatchMs,
      loopBusyMs,
      drainWallMs,
      durableWallMs,
    }
    if (repeat >= 0) samples.push(row)
    console.log(JSON.stringify(row))
  } finally {
    await conn.close()
    outbox.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The drain loop for the SIGKILL check, run in a child against one arm's bundle. */
const childSource = `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const [bundlePath, dir, totalArg] = process.argv.slice(2)
const total = Number(totalArg)
const api = await import(bundlePath)
const event = ${event.toString()}
const outbox = api.createRuntimeEventOutbox(dir)
for (let i = 0; i < total; i++) outbox.enqueue(event('backlog-' + i, i + 1))
const progress = join(dir, 'progress.log')
appendFileSync(progress, 'seeded\\n')
let next = 0
const step = () => {
  const end = Math.min(total, next + ${batch})
  for (; next < end; next++) outbox.acknowledge('backlog-' + next)
  appendFileSync(progress, 'acked ' + next + '\\n')
  outbox.enqueue(event('live-' + next, total + next + 1))
  appendFileSync(progress, 'added live-' + next + '\\n')
  if (next < total) setImmediate(step)
}
setImmediate(step)
`

async function killCheck(api: Api, arm: Arm, size: number, point: number) {
  const dir = join(root, `kill-${arm}-${size}-${point}`)
  mkdirSync(dir)
  const script = join(root, 'drain-child.ts')
  if (!existsSync(script)) writeFileSync(script, childSource)
  const child = spawn(
    process.execPath,
    [script, pathToFileURL(bundles[arm]).href, dir, String(size)],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const progress = () => {
    const path = join(dir, 'progress.log')
    const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
    let acked = 0
    const added: string[] = []
    for (const line of lines) {
      const [verb, value] = line.split(' ')
      if (verb === 'acked') acked = Number(value)
      if (verb === 'added' && value) added.push(value)
    }
    return { acked, added }
  }
  const target = Math.floor(size * point)
  const deadline = Date.now() + 120_000
  while (progress().acked < target) {
    if (child.exitCode !== null) throw new Error(`drain child exited early: ${stderr}`)
    if (Date.now() > deadline) throw new Error(`drain child stalled: ${stderr}`)
    await Bun.sleep(1)
  }
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  assert.deepEqual(await closed, [null, 'SIGKILL'])
  const { acked, added } = progress()
  const outbox = api.createRuntimeEventOutbox(dir)
  try {
    const pending = new Set(outbox.pending().map((entry) => entry.deliveryId))
    const known = new Set([
      ...Array.from({ length: size }, (_, i) => `backlog-${i}`),
      ...added,
      `live-${acked}`,
    ])
    for (const id of pending) assert(known.has(id), `${arm}: ${id} was never enqueued`)
    for (let i = 0; i < acked; i++)
      assert(!pending.has(`backlog-${i}`), `${arm}: returned ACK backlog-${i} was lost`)
    for (let i = Math.min(size, acked + batch); i < size; i++)
      assert(pending.has(`backlog-${i}`), `${arm}: unacknowledged backlog-${i} was lost`)
    for (const id of added) assert(pending.has(id), `${arm}: enqueued ${id} was lost`)
    return { arm, size, killAfterAcks: acked, recoveredPending: pending.size, exact: true }
  } finally {
    outbox.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function stats(values: number[]) {
  values.sort((a, b) => a - b)
  const median = values[Math.floor(values.length / 2)]
  const min = values[0]
  const max = values.at(-1)
  assert(median !== undefined && min !== undefined && max !== undefined)
  return { median, min, max }
}

try {
  const arms = { before: await bundle('before'), after: await bundle('after') }
  const metadata = {
    baseline,
    candidate,
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    virtualization: Bun.spawnSync(['systemd-detect-virt']).stdout.toString().trim(),
    filesystem: Bun.spawnSync(['findmnt', '-T', root, '-n', '-o', 'FSTYPE'])
      .stdout.toString()
      .trim(),
    loadBefore: loadavg(),
    sizes,
    batch,
    repeats,
    fixture: 'Generated state events; backlog equals the reported ACK burst size.',
    timed:
      'Connection ACK handler, one batch per macrotask, with a 1 ms probe timer. No socket or enqueue is timed.',
  }
  await sample(arms.before, 'before', 64, -2)
  await sample(arms.after, 'after', 64, -1)
  for (let repeat = 0; repeat < repeats; repeat++) {
    const order: Arm[] = repeat % 2 === 0 ? ['before', 'after'] : ['after', 'before']
    for (let offset = 0; offset < sizes.length; offset++) {
      const size = sizes[(repeat + offset) % sizes.length]
      assert(size !== undefined)
      for (const arm of order) await sample(arms[arm], arm, size, repeat)
    }
  }
  const kills = []
  const largest = sizes.at(-1)
  assert(largest !== undefined)
  for (const point of killPoints)
    for (const arm of ['before', 'after'] as const) {
      const row = await killCheck(arms[arm], arm, largest, point)
      console.log(JSON.stringify(row))
      kills.push(row)
    }
  const summary = sizes.map((size) => ({
    size,
    arms: Object.fromEntries(
      (['before', 'after'] as const).map((arm) => {
        const rows = samples.filter((row) => row.arm === arm && row.size === size)
        return [
          arm,
          Object.fromEntries(
            (
              ['maxTimerGapMs', 'maxBatchMs', 'loopBusyMs', 'drainWallMs', 'durableWallMs'] as const
            ).map((key) => [key, stats(rows.map((row) => row[key]))]),
          ),
        ]
      }),
    ),
  }))
  const result = { metadata: { ...metadata, loadAfter: loadavg() }, summary, kills, samples }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ metadata: result.metadata, summary, kills }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
