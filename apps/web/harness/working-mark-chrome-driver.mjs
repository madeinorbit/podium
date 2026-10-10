/**
 * Small WebDriver transport for the same collector on the existing Chromium.
 * Keyboard input uses Chromium's trusted CDP key path. Safari MUST use Apple's
 * safaridriver, not this adapter or Playwright WebKit. Own directory/profile,
 * loopback only; recorded process cohort; graceful owned-browser cleanup.
 *
 * Foreground: bun apps/web/harness/working-mark-chrome-driver.mjs \
 *   --root /path/to/issue/captures --chrome /path/to/chrome --port 19658
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    chrome: { type: 'string' },
    port: { type: 'string', default: '19658' },
    headed: { type: 'boolean', default: false },
  },
})
if (!values.root) throw Error('An issue-owned --root is required')
const root = resolve(values.root)
await mkdir(root, { recursive: true })
await writeFile(resolve(root, 'driver.pid'), String(process.pid))
const context = await chromium.launchPersistentContext(resolve(root, 'chrome-profile'), {
  executablePath: values.chrome,
  headless: !values.headed,
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 2,
  reducedMotion: 'no-preference',
})
const page = context.pages()[0] ?? (await context.newPage())
const browserCdp = await context.browser().newBrowserCDPSession()
const processes = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo
await writeFile(
  resolve(root, 'chrome-processes.json'),
  JSON.stringify(
    {
      driverPid: process.pid,
      headless: !values.headed,
      version: context.browser().version(),
      processes,
    },
    null,
    2,
  ),
)

const sessionId = 'working-mark-owned'
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  await context.close()
  server.close()
}
const server = createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const route = req.url
    let value
    if (route === '/status') {
      value = {
        ready: true,
        sessionId,
        version: context.browser().version(),
        headless: !values.headed,
        processes,
      }
    } else if (!route.startsWith(`/session/${sessionId}`)) {
      throw Error('Only the explicitly owned session is accessible')
    } else {
      const path = route.slice(`/session/${sessionId}`.length)
      if (path === '/url' && req.method === 'POST') {
        const url = new URL(body.url)
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
          throw Error('Only an owned loopback fixture is allowed')
        await page.goto(body.url, { waitUntil: 'load' })
        value = null
      } else if (path === '/execute/sync') {
        value = await page.evaluate(
          ({ script, args }) => new Function(script).apply(null, args),
          body,
        )
      } else if (path === '/motion' && req.method === 'POST') {
        if (!['reduce', 'no-preference'].includes(body.value))
          throw Error('Expected a reduced-motion media preference')
        await page.emulateMedia({ reducedMotion: body.value })
        value = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
      } else if (path === '/window/rect') {
        if (req.method === 'POST')
          await page.setViewportSize({ width: body.width, height: body.height })
        value = { ...page.viewportSize(), x: 0, y: 0 }
      } else if (path === '/element') {
        if (body.using !== 'css selector') throw Error('Only CSS selectors are supported')
        await page.locator(body.value).first().waitFor()
        value = { 'element-6066-11e4-a52e-4f735466cecf': encodeURIComponent(body.value) }
      } else if (path.startsWith('/element/') && path.endsWith('/screenshot')) {
        const selector = decodeURIComponent(path.slice('/element/'.length, -'/screenshot'.length))
        value = (await page.locator(selector).first().screenshot({ type: 'png' })).toString(
          'base64',
        )
      } else if (path.startsWith('/element/') && path.endsWith('/value')) {
        const selector = decodeURIComponent(path.slice('/element/'.length, -'/value'.length))
        if (selector !== '#composer')
          throw Error('Only the isolated composer can receive native keys')
        await page.locator(selector).press(body.text)
        value = null
      } else if (path === '/screenshot') {
        value = (await page.screenshot({ type: 'png' })).toString('base64')
      } else if (path === '/processes') {
        value = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo
        await writeFile(
          resolve(root, 'chrome-processes.json'),
          JSON.stringify(
            {
              driverPid: process.pid,
              headless: !values.headed,
              version: context.browser().version(),
              processes: value,
            },
            null,
            2,
          ),
        )
      } else if (path === '' && req.method === 'DELETE') {
        value = null
        setImmediate(close)
      } else throw Error(`Unsupported owned-driver route: ${path}`)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ value: value ?? null }))
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ value: { error: 'unknown error', message: String(error) } }))
  }
})
server.on('error', async (error) => {
  await context.close()
  throw error
})
server.listen(Number(values.port), '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, sessionId, port: Number(values.port), processes }))
})
process.on('SIGINT', close)
process.on('SIGTERM', close)
