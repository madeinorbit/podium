/**
 * Switch-latency bench server [POD-701].
 *
 * Boots ONLY the Podium server (no daemon) against a copied state dir so
 * session-switch costs can be measured at real dataset scale without touching
 * the live instance. With no daemon connected, transcriptRead serves from the
 * lake copy in <state>/transcripts — the same bytes the daemon would read.
 *
 * Run: BENCH_STATE=/path/to/state-copy [PORT=8877] \
 *        bun --conditions=@podium/source scripts/switch-bench-serve.ts
 *
 * The server serves the built web UI same-origin (build first:
 * `bun run --filter @podium/protocol build && bun run --filter @podium/web build`).
 * Open http://localhost:<port>/?e2e=1&switchTrace=1
 */
const benchState = process.env.BENCH_STATE
if (!benchState) {
  console.error('BENCH_STATE must point at a copied state dir (never ~/.podium)')
  process.exit(1)
}
if (benchState.replace(/\/$/, '').endsWith('/.podium')) {
  console.error('refusing to run against what looks like the live state dir')
  process.exit(1)
}
process.env.PODIUM_STATE_DIR = benchState
process.env.PODIUM_NO_SCOPE = '1'

const { startServer } = await import('../apps/server/src/server')
// Both imports are dynamic and both happen AFTER PODIUM_STATE_DIR is set above:
// `defaultDbPath()` reads that variable, so the bench opens the copied state dir's
// database and naming it here is what keeps this file's refusals above meaningful.
const { defaultDbPath } = await import('../apps/server/src/store')
const server = await startServer({
  dbPath: defaultDbPath(),
  port: Number(process.env.PORT ?? 8877),
})
console.log(`switch-bench server on http://localhost:${server.port} state=${benchState}`)
await new Promise(() => {})

// Only a dynamic import above, so nothing marks this file as a module and its
// top-level `await` would be a syntax error under `isolatedModules`.
export {}
