import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const out = process.env.REFRESHING_SHOTS_OUT ?? '/tmp/pod-7166-shots'
await mkdir(out, { recursive: true })
await writeFile(`${out}/vite.log`, '')
await writeFile(`${out}/vite-errors.log`, '')
const server = Bun.spawn(
  [
    'bunx',
    'vite',
    '--config',
    'vite.refreshing-harness.config.ts',
    '--host',
    '127.0.0.1',
    '--force',
  ],
  {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: Bun.file(`${out}/vite.log`),
    stderr: Bun.file(`${out}/vite-errors.log`),
  },
)
const origin = 'http://127.0.0.1:55616'
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const evidence: unknown[] = []
try {
  let serving = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      serving = (await fetch(`${origin}/harness/refreshing.html`)).ok
    } catch {}
    if (serving) break
    await Bun.sleep(200)
  }
  if (!serving) throw new Error('Refreshing harness did not start')
  const browserEnv = { ...process.env }
  const userLib = `${process.env.HOME}/.cache/podium-chromium-deps/root/usr/lib/x86_64-linux-gnu`
  if (existsSync(userLib)) browserEnv.LD_LIBRARY_PATH = userLib
  else delete browserEnv.LD_LIBRARY_PATH
  browser = await chromium.launch({ headless: true, env: browserEnv, args: ['--no-sandbox'] })
  for (const platform of ['web', 'phone'])
    for (const screen of ['deck', 'board']) {
      const page = await browser.newPage({
        viewport: {
          width: platform === 'phone' ? 390 : screen === 'deck' ? 480 : 1140,
          height: 844,
        },
        deviceScaleFactor: 1,
      })
      const errors: string[] = []
      const pending = new Set<string>()
      const completed: string[] = []
      page.on('request', (request) => pending.add(request.url()))
      page.on('requestfinished', (request) => {
        pending.delete(request.url())
        completed.push(request.url())
      })
      page.on('pageerror', (error) => {
        errors.push(error.message)
        console.error(error.stack)
      })
      page.on('console', (message) => {
        if (message.type() === 'error') console.error(message.text())
      })
      page.on('requestfailed', (request) => {
        if (request.failure()?.errorText !== 'net::ERR_ABORTED')
          console.error(request.url(), request.failure()?.errorText)
      })
      await page.goto(`${origin}/harness/refreshing.html?platform=${platform}&screen=${screen}`)
      try {
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="Refreshing"]') ||
            (window as unknown as { refreshingFailure?: string }).refreshingFailure,
          undefined,
          { timeout: 60_000 },
        )
        const failure = await page.evaluate(
          () => (window as unknown as { refreshingFailure?: string }).refreshingFailure,
        )
        if (failure) throw new Error(failure)
        await page.getByLabel('Refreshing', { exact: true }).waitFor({ timeout: 60_000 })
      } catch (error) {
        await writeFile(`${out}/${platform}-${screen}-blocked.html`, await page.content())
        console.error(
          await page.evaluate(() => ({
            initialized: 'refreshing' in window,
            stage: (window as unknown as { refreshingStage?: string }).refreshingStage,
            content: document.getElementById('root')?.innerHTML,
          })),
        )
        console.error({
          pending: [...pending],
          completed: completed.length,
          lastModules: completed.slice(-12),
        })
        throw error
      }
      const marks = page.getByLabel('Refreshing', { exact: true })
      if ((await marks.count()) !== 1) throw new Error(`${platform} ${screen}: expected one mark`)
      if (await page.getByLabel(/Loading task|Loading mission/).count())
        throw new Error(`${platform} ${screen}: loading state`)
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      await page.screenshot({ path: `${out}/${platform}-${screen}-refreshing.png` })
      const before = await page.locator('[data-refreshing-layout]').boundingBox()
      await page.evaluate(() =>
        (window as unknown as { refreshing: { land(): void } }).refreshing.land(),
      )
      await marks.waitFor({ state: 'detached' })
      await page.screenshot({ path: `${out}/${platform}-${screen}-here.png` })
      const after = await page.locator('[data-refreshing-layout]').boundingBox()
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error(`${platform} ${screen}: frame moved`)
      if (errors.length) throw new Error(`${platform} ${screen}: ${errors.join('\n')}`)
      evidence.push({ platform, screen, readings: ['refreshing', 'here'], marks: 1, errors })
      await page.close()
    }
  await writeFile(`${out}/evidence.json`, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} finally {
  await browser?.close()
  server.kill()
  await server.exited
}
