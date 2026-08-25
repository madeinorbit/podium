/**
 * MEASURE WHAT THE APP BURNS WHILE NOBODY TOUCHES IT (POD-1607).
 *
 * Drives harness/idle-cost-entry.tsx in a HEADED WebKit (under Xvfb) and reads
 * the CPU actually consumed by the WebKit process tree over a fixed window.
 * Headed matters: a headless browser can skip the compositing and rasterisation
 * that is the whole question here, so a headless number would be an answer to a
 * different question.
 *
 * WHAT THIS RIG CAN AND CANNOT SAY. Playwright's `webkit` on Linux is WebKitGTK
 * under Xvfb, where there is NO GPU: every layer is rastered on the CPU. So it
 * reads how much work an animation makes the engine do, and the ranking between
 * mechanisms transfers — but it CANNOT tell a compositor-accelerated animation
 * from a main-thread one, because here both are paid for in CPU. Any fix whose
 * argument is "this version gets its own layer" has to be verified on the
 * operator's Mac (`sample <WebContent pid>`), not here. A first attempt at a
 * main-thread probe was cut for exactly this reason: it read the same 27% on a
 * blank page as it did on the positive control, which is a broken instrument,
 * not a finding.
 *
 * `blank` is the floor and `hog` is the positive control. If `hog` does not come
 * back far above `blank`, the instrument is blind and every other row in the
 * table is noise — the run fails rather than reporting.
 *
 *   bunx vite --config vite.idle-cost.config.ts    # in apps/web
 *   bun run e2e/pod1607-idle-cost.ts [--n 24] [--window 10]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { webkit } from 'playwright'

const BASE = 'http://localhost:55611/idle-cost-harness.html'
const CLOCK_HZ = 100

const argv = process.argv.slice(2)
const arg = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback
}
const N = arg('n', 24)
const WINDOW_S = arg('window', 10)
const WARMUP_MS = 3_000
/**
 * One variant per invocation. A headed browser per variant in a single process
 * is enough peak load for the shared host to reap the run (exit 144), which
 * looks exactly like a crash and is not one — so the caller loops instead.
 */
const ONLY = ((): string | null => {
  const i = argv.indexOf('--only')
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
})()

/**
 * CPU is charged to a FIXED SET OF PIDS, resolved once and reused at both ends
 * of the window. The first cut of this rig summed every live WebKit process
 * instead, and reported the positive control at MINUS 2262% — a browser from the
 * previous variant exited mid-window and took its accumulated jiffies out of the
 * total. A set that can shrink under the measurement is not a measurement.
 */
const WEBKIT_MARK = 'ms-playwright/webkit-'

/** Every live process belonging to a Playwright WebKit install. */
function webkitPids(): number[] {
  const found: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(WEBKIT_MARK)) {
        found.push(Number(entry))
      }
    } catch {
      // Exited between readdir and read; it is not ours to charge either way.
    }
  }
  return found
}

/** utime+stime in seconds for exactly these pids; a pid that died reads 0. */
function cpuSeconds(pids: readonly number[]): { seconds: number; alive: number } {
  let jiffies = 0
  let alive = 0
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // Fields after the (comm) parenthesis: state is 0, utime is 11, stime 12.
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      jiffies += Number(tail[11]) + Number(tail[12])
      alive++
    } catch {
      // Counted as 0 — and the caller fails the row if the set shrank at all.
    }
  }
  return { seconds: jiffies / CLOCK_HZ, alive }
}

type Row = { variant: string; n: number; cpuPct: number }

async function measure(variant: string, n: number, stopAnimations = false): Promise<Row> {
  // Playwright's public `launch()` does not hand out the browser pid, and
  // `launchServer()` + `connect()` cannot be reached from Bun (its websocket
  // client fails on the server's IPv6 endpoint). So the browser's processes are
  // identified by difference: whatever WebKit processes appear after launch that
  // were not there before.
  const foreign = new Set(webkitPids())
  const browser = await webkit.launch({ headless: false })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${BASE}?variant=${variant}&n=${n}`, { waitUntil: 'networkidle' })
    await page.waitForFunction('window.idleCost?.ready === true', undefined, { timeout: 30_000 })
    if (stopAnimations) await page.evaluate('window.idleCost.stopAnimations()')
    if (errors.length > 0) throw new Error(`page errors in ${variant}: ${errors.join('; ')}`)

    await page.waitForTimeout(WARMUP_MS)
    // Resolved AFTER warm-up so the render processes exist and the set is stable.
    const pids = webkitPids().filter((pid) => !foreign.has(pid))
    if (pids.length === 0) throw new Error(`${variant}: found no WebKit process to charge`)
    const before = cpuSeconds(pids)
    const startedAt = process.hrtime.bigint()
    await page.waitForTimeout(WINDOW_S * 1_000)
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e9
    const after = cpuSeconds(pids)
    if (after.alive < before.alive) {
      throw new Error(
        `${variant}: ${before.alive - after.alive} of ${pids.length} processes exited during ` +
          `the window — the total went backwards and the reading is void`,
      )
    }

    return {
      variant: stopAnimations ? `${variant} (animations off)` : variant,
      n,
      cpuPct: ((after.seconds - before.seconds) / elapsed) * 100,
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

const rows: Row[] = []
const push = async (variant: string, n: number, stop = false): Promise<void> => {
  const row = await measure(variant, n, stop)
  rows.push(row)
  console.log(`  ${row.variant.padEnd(26)} n=${String(row.n).padEnd(4)} ${row.cpuPct.toFixed(1)}%`)
}

if (ONLY === null) {
  console.error('[idle-cost] pass --only <variant>[:off]; see e2e/pod1607-sweep.sh')
  process.exit(2)
}
const [variant, mode] = ONLY.split(':')
// Variants that render exactly one thing regardless of `n`.
const countless = ['blank', 'hog', 'gauge', 'gauge-nomask'].includes(variant)
await push(variant, countless ? 0 : N, mode === 'off')
console.log(`[idle-cost-json] ${JSON.stringify({ windowSeconds: WINDOW_S, ...rows[0] })}`)
