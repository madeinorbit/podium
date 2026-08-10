import { firefox } from '@playwright/test'

const baseUrl = process.env.PODIUM_URL ?? 'http://localhost:18787'
const durationMs = Number(process.argv[2] ?? 60_000)
const outPath = process.argv[3] ?? '.artifacts/POD-1790/peer-lifecycle.json'

const tokenProc = Bun.spawn(
  ['podium', 'auth', 'mint-session', '--print-only', '--ttl', '10m'],
  { stdout: 'pipe', stderr: 'ignore' },
)
const token = (await new Response(tokenProc.stdout).text()).trim()
if ((await tokenProc.exited) !== 0 || !token) throw new Error('could not mint browser session')

const events: Array<Record<string, unknown>> = []
const record = (event: Record<string, unknown>) =>
  events.push({ at: new Date().toISOString(), elapsedMs: performance.now() - startedAt, ...event })
const describeFrame = (payload: string | Buffer) => {
  const text = String(payload)
  try {
    const message = JSON.parse(text) as { type?: string; clientId?: string; wireVersion?: number }
    return {
      type: message.type ?? 'json',
      ...(message.clientId ? { clientId: message.clientId } : {}),
      ...(message.wireVersion ? { wireVersion: message.wireVersion } : {}),
      bytes: Buffer.byteLength(text),
    }
  } catch {
    return { type: 'non-json', bytes: Buffer.byteLength(text) }
  }
}

const startedAt = performance.now()
const browser = await firefox.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
await context.addCookies([{ name: 'podium_session', value: token, url: baseUrl }])
const page = await context.newPage()
page.on('websocket', (socket) => {
  record({ event: 'socket-open', url: socket.url() })
  socket.on('framesent', ({ payload }) => record({ event: 'frame-sent', ...describeFrame(payload) }))
  socket.on('framereceived', ({ payload }) =>
    record({ event: 'frame-received', ...describeFrame(payload) }),
  )
  socket.on('close', () => record({ event: 'socket-close', url: socket.url() }))
  socket.on('socketerror', (error) => record({ event: 'socket-error', error }))
})
page.on('console', (message) => {
  if (message.type() === 'warning' || message.type() === 'error') {
    record({ event: 'console', level: message.type(), text: message.text() })
  }
})

try {
  const url = new URL(baseUrl)
  url.searchParams.set('e2e', '1')
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.getByRole('button', { name: 'New panel' }).waitFor({ timeout: 180_000 })
  record({ event: 'app-ready' })
  await page.waitForTimeout(durationMs)
} finally {
  await browser.close()
  await Bun.write(
    outPath,
    `${JSON.stringify({ measuredAt: new Date().toISOString(), baseUrl, durationMs, events }, null, 2)}\n`,
  )
}

console.log(`peer lifecycle trace: ${outPath}`)
