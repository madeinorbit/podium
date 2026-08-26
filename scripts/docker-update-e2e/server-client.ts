import { writeFileSync } from 'node:fs'
import { chromium, type WebSocket } from '@playwright/test'

const origin = process.env.PODIUM_UPDATE_E2E_ORIGIN
const session = process.env.PODIUM_UPDATE_E2E_SESSION
const target = process.env.PODIUM_UPDATE_E2E_TARGET
const readyFile = process.env.PODIUM_UPDATE_E2E_READY_FILE
const resultFile = process.env.PODIUM_UPDATE_E2E_RESULT_FILE
const breakClient = process.env.PODIUM_UPDATE_E2E_BREAK_CLIENT === '1'
if (!origin || !session || !target || !readyFile || !resultFile) {
  throw new Error('ORIGIN, SESSION, TARGET, READY_FILE, and RESULT_FILE are required')
}

const browser = await chromium.launch()
const context = await browser.newContext()
// The cookie is minted by a real /auth/login request in the shell harness. Put
// it into the browser context before navigation so the first `/client` upgrade,
// not merely later API fetches, crosses the authenticated boundary.
await context.addCookies([{ name: 'podium_session', value: session, url: origin }])
const page = await context.newPage()
page.setDefaultTimeout(120_000)
const sockets: WebSocket[] = []
let closed = 0
let postReconnectFrames = 0

page.on('websocket', (socket) => {
  sockets.push(socket)
  const ordinal = sockets.length
  socket.on('close', () => {
    closed += 1
  })
  socket.on('framereceived', () => {
    if (ordinal > 1) postReconnectFrames += 1
  })
})

async function json(path: string): Promise<Record<string, unknown>> {
  const response = await page.request.get(`${origin}${path}`)
  if (!response.ok()) throw new Error(`${path} returned ${response.status()}`)
  return response.json()
}

try {
  await page.goto(`${origin}?e2e=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  const setup = page.locator('.desktop-shell[data-setup-only="true"]')
  const settings = page.getByRole('button', { name: 'Settings' }).first()
  const first = await Promise.race([
    setup.waitFor().then(() => 'setup' as const),
    settings.waitFor().then(() => 'ready' as const),
  ])
  if (first === 'setup') {
    await page.goto(`${origin}?e2e=1&activation=first-task`, {
      waitUntil: 'domcontentloaded',
      timeout: 180_000,
    })
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await settings.waitFor()
  }
  await page.waitForFunction(() => document.readyState === 'complete')
  const baselineVersion = await json('/version')
  const baselineWeb = await json('/podium-build.json')
  const initialSockets = sockets.length
  const initialClosed = closed
  if (initialSockets < 1) throw new Error('the connected browser opened no WebSocket')
  writeFileSync(
    readyFile,
    JSON.stringify({ initialSockets, initialClosed, baselineVersion, baselineWeb }) + '\n',
  )
  if (breakClient) {
    await page.close()
    throw new Error('deliberate server-client control closed the connected browser')
  }

  const deadline = Date.now() + 300_000
  let current: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    try {
      current = await json('/version')
      if (
        current.appVersion === target &&
        closed > initialClosed &&
        sockets.length >= initialSockets + 1 &&
        postReconnectFrames >= 1
      ) {
        const web = await json('/podium-build.json')
        const mobile = await json('/mobile/podium-build.json')
        writeFileSync(
          resultFile,
          JSON.stringify({
            initialSockets,
            initialClosed,
            sockets: sockets.length,
            closed,
            postReconnectFrames,
            current,
            web,
            mobile,
          }) + '\n',
        )
        process.exitCode = 0
        break
      }
    } catch {
      // Expected while the packaged server hands itself over.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (
    current.appVersion !== target ||
    closed <= initialClosed ||
    sockets.length < initialSockets + 1 ||
    postReconnectFrames < 1 ||
    !(await Bun.file(resultFile).exists())
  ) {
    throw new Error(
      `client did not reconnect to ${target}: initial=${initialSockets} sockets=${sockets.length} closed=${closed} frames=${postReconnectFrames} current=${JSON.stringify(current)}`,
    )
  }
} finally {
  await browser.close()
}
