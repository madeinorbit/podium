/**
 * Switch-latency benchmark driver [POD-701].
 *
 * Drives a running switch-bench server (scripts/switch-bench-serve.ts) with a
 * real browser: round-robin clicks across sidebar issue rows, then dumps the
 * client switch traces (__podiumSwitchTraces) and the server perf snapshot.
 *
 * Run (after building web and booting the bench server):
 *   cd tests/e2e && bun switch-bench.ts
 * Env: BENCH_URL (default http://localhost:8877), BENCH_MODE chat|native,
 *      BENCH_SWITCHES (default 40), BENCH_DWELL ms between clicks (2500),
 *      BENCH_OUT (JSON results path).
 */
import { chromium } from '@playwright/test'

const BASE = process.env.BENCH_URL ?? 'http://localhost:8877'
const MODE = process.env.BENCH_MODE === 'native' ? 'native' : 'chat'
const SWITCHES = Number(process.env.BENCH_SWITCHES ?? 40)
const DWELL_MS = Number(process.env.BENCH_DWELL ?? 2500)
const OUT = process.env.BENCH_OUT ?? `switch-bench-${MODE}.json`

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('pageerror', (err) => console.error('[page error]', err.message))
await page.addInitScript((mode) => {
  localStorage.setItem('podium.panelMode', mode)
}, MODE)
await page.goto(`${BASE}/?e2e=1&switchTrace=1`)
// The bench server has no daemon, so no repo scan → the onboarding wizard
// covers the app. Dismissing it reveals the normal sidebar (issues/sessions
// come from the DB, not the repo scan).
const closeOnboarding = page.getByRole('button', { name: 'Close' })
try {
  await closeOnboarding.click({ timeout: 15_000 })
} catch {
  // Onboarding did not show — repos resolved; proceed.
}
await page.waitForSelector('[data-testid="unified-issue-row"]', { timeout: 60_000 })
// Let the initial session list + first panel settle before measuring.
await page.waitForTimeout(4000)

const rows = page.locator('[data-testid="unified-issue-row"]')
// Default 6 keeps the rotation inside the warm-set cap (8 on desktop) so warm
// re-activations are actually exercised; raise via BENCH_ROWS to force cold churn.
const rowCount = Math.min(await rows.count(), Number(process.env.BENCH_ROWS ?? 6))
if (rowCount < 2) {
  console.error(`only ${rowCount} issue rows visible — nothing to switch between`)
  process.exit(1)
}
console.log(`driving ${SWITCHES} switches (mode=${MODE}) across ${rowCount} issue rows`)

for (let i = 0; i < SWITCHES; i++) {
  const row = rows.nth(i % rowCount)
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await page.waitForTimeout(DWELL_MS)
}
// Give the last trace time to quiesce or time out before reading the ring.
await page.waitForTimeout(1500)

const traces = await page.evaluate(() => globalThis.__podiumSwitchTraces?.recent() ?? [])
const snapshotRes = await fetch(`${BASE}/trpc/perf.snapshot`)
const snapshot = ((await snapshotRes.json()) as { result?: { data?: unknown } }).result?.data

await Bun.write(OUT, JSON.stringify({ mode: MODE, base: BASE, traces, snapshot }, null, 2))

const done = traces.filter((t) => !t.timedOut)
const timedOut = traces.length - done.length
const totals = done.map((t) => t.totalMs).sort((a, b) => a - b)
const pct = (q: number): number =>
  totals.length === 0 ? 0 : Math.round(totals[Math.min(totals.length - 1, Math.floor(q * totals.length))]!)
console.log(
  `traces=${traces.length} quiesced=${done.length} timedOut=${timedOut} ` +
    `p50=${pct(0.5)}ms p90=${pct(0.9)}ms max=${Math.round(totals[totals.length - 1] ?? 0)}ms → ${OUT}`,
)
await browser.close()
