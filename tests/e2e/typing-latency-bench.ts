/**
 * Real-browser typing latency bench [POD-1784].
 *
 * Creates an idle shell through the live UI, presses/erases characters through
 * xterm's real keyboard path, reads the opt-in input-event→paint collector, and
 * exits the temporary shell even when the measurement fails.
 *
 * Usage:
 *   bun run perf:typing
 *   bun run perf:typing -- --samples=60 --out=.artifacts/typing.json
 *   bun run perf:typing -- --verify-off --out=.artifacts/typing-off.json
 *
 * Env:
 *   PODIUM_URL            defaults to http://localhost:18787
 *   PODIUM_BROWSER_TOKEN  optional; otherwise mints a 10-minute local session
 */

import { firefox, type Page } from '@playwright/test'

interface SessionSummary {
  sessionId: string
  agentKind: string
  status: string
  createdAt: string
  cwd: string
}

interface EchoSummary {
  count: number
  p50: number | null
  p90: number | null
  max: number | null
  lastMs: number | null
}

interface EchoStats extends EchoSummary {
  enabled: boolean
  toFrame: EchoSummary
  frameToPaint: EchoSummary
  last: { toFrameMs: number; frameToPaintMs: number; totalMs: number } | null
}

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=')
    return [key, rest.join('=')]
  }),
)
const sampleCount = Number(args.get('samples') || 40)
const verifyOff = args.has('verify-off')
const outPath = args.get('out') || null
const baseUrl = process.env.PODIUM_URL ?? 'http://localhost:18787'
if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 500) {
  throw new Error('--samples must be an integer between 2 and 500')
}

// Chromium/Firefox profiles are temporary and can be large. Linux always has
// tmpfs here; using it also keeps a full root filesystem from invalidating a run.
if (process.platform === 'linux' && !process.env.TMPDIR) process.env.TMPDIR = '/dev/shm'

async function browserToken(): Promise<string> {
  if (process.env.PODIUM_BROWSER_TOKEN) return process.env.PODIUM_BROWSER_TOKEN
  const proc = Bun.spawn(
    ['podium', 'auth', 'mint-session', '--print-only', '--ttl', '10m'],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const token = (await new Response(proc.stdout).text()).trim()
  if ((await proc.exited) !== 0 || !token) throw new Error('could not mint a browser session')
  return token
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function listSessions(page: Page): Promise<SessionSummary[]> {
  return withTimeout(
    page.evaluate(async () => {
      const response = await fetch('/trpc/sessions.list?input=%7B%7D')
      if (!response.ok) throw new Error(`sessions.list failed: HTTP ${response.status}`)
      const body = (await response.json()) as { result?: { data?: SessionSummary[] } }
      return body.result?.data ?? []
    }),
    'sessions.list',
  )
}

async function stopShell(page: Page, sessionId: string): Promise<void> {
  let sentInBrowser = false
  try {
    sentInBrowser = await withTimeout(
      page.evaluate(() => {
        const api = (window as unknown as { __podium?: { sendInput?(data: string): void } })
          .__podium
        if (typeof api?.sendInput !== 'function') return false
        api.sendInput('\x15exit\r')
        return true
      }),
      'browser shell cleanup',
    )
  } catch {
    // The CLI fallback below does not depend on a responsive page.
  }
  if (sentInBrowser) {
    await page.waitForTimeout(500)
    try {
      const session = (await listSessions(page)).find((item) => item.sessionId === sessionId)
      if (session?.status === 'exited') return
    } catch {
      // Fall through to the CLI cleanup.
    }
  }
  const proc = Bun.spawn(
    ['podium', 'session', 'send', sessionId, '--text', '\x15exit', '--outside-scope'],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  try {
    await withTimeout(proc.exited, 'CLI shell cleanup')
  } catch {
    proc.kill()
  }
}

const token = await browserToken()
const browser = await firefox.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
await context.addCookies([{ name: 'podium_session', value: token, url: baseUrl }])
const page = await context.newPage()
let createdSessionId: string | null = null

try {
  const url = new URL(baseUrl)
  url.searchParams.set('e2e', '1')
  url.searchParams.set('echoHud', verifyOff ? '0' : '1')
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.getByRole('button', { name: 'New panel' }).waitFor({ timeout: 180_000 })
  const beforeIds = new Set((await listSessions(page)).map((session) => session.sessionId))

  await page.getByRole('button', { name: 'New panel' }).click()
  await page.getByRole('menuitem', { name: 'New Shell' }).click()

  const creationDeadline = Date.now() + 30_000
  while (!createdSessionId && Date.now() < creationDeadline) {
    const created = (await listSessions(page))
      .filter((session) => !beforeIds.has(session.sessionId) && session.agentKind === 'shell')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    createdSessionId = created?.sessionId ?? null
    if (!createdSessionId) await page.waitForTimeout(100)
  }
  if (!createdSessionId) throw new Error('New Shell click produced no session within 30s')

  await page.waitForFunction(
    (expectedEnabled) => {
      const api = (window as unknown as { __podium?: { echoLatency?(): EchoStats } }).__podium
      return api?.echoLatency?.().enabled === expectedEnabled
    },
    !verifyOff,
    { timeout: 180_000 },
  )
  await page.locator('.xterm-helper-textarea').last().focus()

  const stats = (): Promise<EchoStats> =>
    page.evaluate(
      () =>
        (window as unknown as { __podium: { echoLatency(): EchoStats } }).__podium.echoLatency(),
    )
  const samples: Array<{
    key: string
    observedMs: number
    totalMs: number | null
    toFrameMs: number | null
    frameToPaintMs: number | null
  }> = []

  if (verifyOff) {
    await page.keyboard.press('x')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(250)
    const offStats = await stats()
    if (offStats.enabled || offStats.count !== 0) {
      throw new Error(`disabled probe collected ${offStats.count} sample(s)`)
    }
  } else {
    for (let index = 0; index < sampleCount; index += 1) {
      const key = index % 2 === 0 ? 'x' : 'Backspace'
      const before = await stats()
      const startedAt = performance.now()
      await page.keyboard.press(key)
      await page.waitForFunction(
        (count) =>
          (window as unknown as { __podium: { echoLatency(): EchoStats } }).__podium.echoLatency()
            .count > count,
        before.count,
        { timeout: 3_000 },
      )
      const after = await stats()
      samples.push({
        key,
        observedMs: performance.now() - startedAt,
        totalMs: after.last?.totalMs ?? null,
        toFrameMs: after.last?.toFrameMs ?? null,
        frameToPaintMs: after.last?.frameToPaintMs ?? null,
      })
      await page.waitForTimeout(100)
    }
  }

  const result = {
    measuredAt: new Date().toISOString(),
    url: baseUrl,
    browser: 'firefox',
    mode: verifyOff ? 'verify-off' : 'measure',
    sessionId: createdSessionId,
    samples: samples.length,
    stats: await stats(),
    observations: samples,
  }
  const encoded = `${JSON.stringify(result, null, 2)}\n`
  if (outPath) {
    await Bun.write(outPath, encoded)
    console.log(`typing latency report: ${outPath}`)
  } else {
    process.stdout.write(encoded)
  }
} finally {
  if (createdSessionId) await stopShell(page, createdSessionId)
  await browser.close()
}
