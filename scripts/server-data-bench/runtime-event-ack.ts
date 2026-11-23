/**
 * Before/after runtime ACK timings on a disposable, generated outbox.
 * Run on a test VM, through its normal performance admission wrapper:
 * bun --conditions=@podium/source scripts/server-data-bench/runtime-event-ack.ts <baseline-commit> [result.json]
 * Both arms use the real ACK handler, synchronous journal and compaction.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  wallMs: number
  cpuMs: number
  fixedBacklogCheckNs: number
  verifiedRetired: number
  verifiedRecoveredPending: number
}

const checkout = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const [baselineRef, output = join(tmpdir(), 'runtime-event-ack-results.json')] =
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
const root = mkdtempSync(join(tmpdir(), 'podium-runtime-event-ack-'))
const sizes = [266, 1068, 1767] // POD-7414 section 3 ACK bursts, not measured pending counts.
const repeats = 9
const checks = 20_000
const samples: Sample[] = []

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
    // Only the two changed runtime files differ; dependencies stay identical.
    plugins:
      arm === 'before'
        ? [
            {
              name: 'baseline-source',
              setup(build) {
                build.onLoad(
                  { filter: /\/(connection-state|runtime-event-outbox)\.ts$/ },
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
  return import(pathToFileURL(path).href) as Promise<Api>
}

function event(index: number): DurableRuntimeEvent {
  return {
    type: 'runtimeEvent',
    deliveryId: `delivery-${index}`,
    sessionId: 'benchmark-session' as SessionId,
    event: {
      t: 'state',
      change: { kind: 'activity' },
      at: '2026-11-23T00:00:00.000Z',
      provenance: 'live',
      observerGeneration: 1,
      turnEpoch: 1,
      cursor: { segmentId: 'segment', components: { seq: index + 1 } },
    },
  }
}

async function sample(api: Api, arm: Arm, size: number, repeat: number): Promise<void> {
  const dir = join(root, `${repeat}-${size}-${arm}`)
  mkdirSync(dir)
  const events = Array.from({ length: size }, (_, i) => event(i))
  // Seed outside the timer, then exercise actual snapshot/journal recovery.
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
    assert.deepEqual(outbox.pending(), events)
    assert.equal('pendingCount' in outbox, arm === 'after')
    const isEmpty =
      arm === 'before' ? () => outbox.pending().length === 0 : () => outbox.pendingCount === 0
    let empty = 0
    for (let i = 0; i < 1_000; i++) empty += Number(isEmpty())
    Bun.gc(true)
    const checkStart = process.hrtime.bigint()
    for (let i = 0; i < checks; i++) empty += Number(isEmpty())
    const checkNs = Number(process.hrtime.bigint() - checkStart)
    assert.equal(empty, 0)

    Bun.gc(true)
    const cpuStart = process.cpuUsage()
    const start = process.hrtime.bigint()
    for (const event of events) conn.acknowledgeRuntimeEvent(event.deliveryId)
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6
    const cpu = process.cpuUsage(cpuStart)
    assert.equal(outbox.pending().length, 0)
    if (arm === 'after') assert.equal(outbox.pendingCount, 0)
    // Duplicate/unknown ACKs must leave the drained store empty across restart.
    conn.acknowledgeRuntimeEvent('unknown')
    const [first] = events
    assert(first)
    conn.acknowledgeRuntimeEvent(first.deliveryId)
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
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1_000,
      fixedBacklogCheckNs: checkNs / checks,
      verifiedRetired: size,
      verifiedRecoveredPending: 0,
    }
    if (repeat >= 0) samples.push(row)
    console.log(JSON.stringify(row))
  } finally {
    await conn.close()
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
    repeats,
    checks,
    fixture:
      'Generated state events. Backlog equals the reported ACK burst size, not a measured live pending count.',
    timed:
      'Actual connection ACK loop including durable append/fsync and compaction. No socket/transport or enqueue is timed. Separate emptiness checks use a fixed backlog.',
  }
  // Warm both bundled methods and journal paths; excluded from the summary.
  await sample(arms.before, 'before', 64, -2)
  await sample(arms.after, 'after', 64, -1)
  for (let repeat = 0; repeat < repeats; repeat++) {
    // Rotate sizes and alternate A/B then B/A to spread drift over both arms.
    const order: Arm[] = repeat % 2 === 0 ? ['before', 'after'] : ['after', 'before']
    for (let offset = 0; offset < sizes.length; offset++) {
      const size = sizes[(repeat + offset) % sizes.length]
      assert(size !== undefined)
      for (const arm of order) await sample(arms[arm], arm, size, repeat)
    }
  }
  const summary = sizes.map((size) => ({
    size,
    arms: Object.fromEntries(
      (['before', 'after'] as const).map((arm) => {
        const rows = samples.filter((row) => row.arm === arm && row.size === size)
        return [
          arm,
          {
            wallMs: stats(rows.map((row) => row.wallMs)),
            cpuMs: stats(rows.map((row) => row.cpuMs)),
            fixedBacklogCheckNs: stats(rows.map((row) => row.fixedBacklogCheckNs)),
          },
        ]
      }),
    ),
  }))
  const result = { metadata: { ...metadata, loadAfter: loadavg() }, summary, samples }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ metadata: result.metadata, summary }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
