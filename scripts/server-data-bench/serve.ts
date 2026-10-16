/**
 * The bench server process (POD-6146): boots the ARM checkout's `startServer` on an
 * isolated state directory and prints its log records as NDJSON on stdout.
 *
 * Spawned by `run.ts` with a whitelisted environment (`benchEnvironment`), never on
 * a live instance's state. It also answers two commands on stdin, so the
 * orchestrator can read the lifetime statement and task totals at the start and end
 * of the load window without a profiler (SIGUSR2 also starts a CPU profile):
 *
 *   `totals <label>` → one stdout line `{"benchTotals": <label>, queries, tasks, rssBytes, heapUsedBytes}`
 *                      (plus `stacks`, caller stacks per statement, under `PODIUM_LOOP_PROFILE=full`)
 *   `stop`           → closes the server and exits 0
 *
 * Usage: bun --conditions=@podium/source <harness>/scripts/server-data-bench/serve.ts --checkout=<arm>
 */
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from './seed'

const args = parseArgs(process.argv.slice(2))
const checkout = args.checkout
if (!checkout) throw new Error('serve.ts: --checkout is required')
if (!process.env.PODIUM_STATE_DIR?.includes('server-data-bench')) {
  throw new Error('serve.ts: refusing a state directory outside a server-data-bench root')
}

const startedAt = performance.now()
const { addSink } = await import(join(checkout, 'packages/logger/src/index.ts'))
addSink({ name: 'server-data-bench', minLevel: 'info', write: (record: unknown) => console.log(JSON.stringify(record)) })
const { startServer } = await import(join(checkout, 'apps/server/src/server.ts'))
const queries = await import(join(checkout, 'packages/runtime/src/query-attribution.ts'))
const tasks = await import(join(checkout, 'packages/runtime/src/task-attribution.ts'))
const server = await startServer({ port: Number(args.port ?? 0), host: '127.0.0.1', transcriptLake: 'off' })
const memory = process.memoryUsage()
console.log(JSON.stringify({
  benchReady: true,
  port: server.port,
  pid: process.pid,
  bootMs: performance.now() - startedAt,
  rssBytes: memory.rss,
  heapUsedBytes: memory.heapUsed,
}))

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const [command, label] = line.trim().split(/\s+/, 2)
  if (command === 'totals') {
    const now = process.memoryUsage()
    console.log(JSON.stringify({
      benchTotals: label ?? '',
      queries: Object.fromEntries(queries.queryAttributionTotals()),
      tasks: Object.fromEntries(tasks.taskAttributionTotals()),
      // Caller stacks per statement key: recorded only under PODIUM_LOOP_PROFILE=full.
      ...(queries.queryCallerStacksEnabled ? { stacks: Object.fromEntries(queries.queryCallerStacks()) } : {}),
      rssBytes: now.rss,
      heapUsedBytes: now.heapUsed,
    }))
  } else if (command === 'stop') {
    await server.close()
    process.exit(0)
  }
}
