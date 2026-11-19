/** Review the shipping Credentials page with found logins; isolated fixtures only. */
import { mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const output = resolve(process.argv[2] ?? '/tmp/found-login-shots')
mkdirSync(output, { recursive: true })
const cache = `${process.env.HOME}/.cache/ms-playwright`
const shell = readdirSync(cache)
  .filter((name) => name.startsWith('chromium_headless_shell-'))
  .sort()
  .at(-1)
const server = Bun.spawn(
  [
    'bun',
    'x',
    '--bun',
    'vite',
    '--config',
    'vite.settings-frame-harness.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    '55765',
  ],
  {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'ignore',
    stderr: 'inherit',
  },
)
const url = 'http://127.0.0.1:55765/harness/settings-frame.html?page=credentials&populated=1'
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Settings harness exited before becoming ready')
    if (
      await fetch(url)
        .then((response) => response.ok)
        .catch(() => false)
    ) {
      ready = true
      break
    }
    await Bun.sleep(200)
  }
  if (!ready) throw new Error('Settings harness did not start')
  const browser = await chromium.launch({
    executablePath: shell
      ? `${cache}/${shell}/chrome-headless-shell-linux64/chrome-headless-shell`
      : undefined,
  })
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: width === 390 ? 1000 : 920 },
        deviceScaleFactor: 1,
      })
      page.setDefaultTimeout(90_000)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.stack ?? String(error)))
      await page.goto(url)
      await page.getByRole('heading', { name: 'Your credentials', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Log in', exact: true }).waitFor()
      if ((await page.getByRole('switch', { name: /Use on all my machines/ }).count()) !== 2)
        throw new Error('Expected both found-login choices')
      if (await page.getByText('Subscription logins on your machines', { exact: true }).count())
        throw new Error('Retired section is still present')
      if (errors.length) {
        await page.screenshot({ path: `${output}/found-logins-error-${width}.png`, fullPage: true })
        throw new Error(errors.join('\n'))
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      if (overflow) throw new Error(`Page overflows at ${width}px`)
      await page.screenshot({ path: `${output}/found-logins-${width}.png`, fullPage: true })
      if (width === 1280) {
        // Exercise the label's real pointer target, which sits beside the row's stretched button.
        await page.getByText('Use on all my machines', { exact: true }).first().click()
        await page.waitForFunction(() => {
          const harness = (
            window as unknown as {
              settingsHarness: { calls: { key: string; input?: { enabled?: boolean } }[] }
            }
          ).settingsHarness
          return harness.calls.some(
            (call) =>
              call.key === 'credentials.useOnMyMachines.mutate' && call.input?.enabled === false,
          )
        })
        await page.getByRole('heading', { name: 'Your credentials', exact: true }).waitFor()
        const receipt = page.locator('.cn-toast-receipt').filter({ hasText: 'Saved' })
        await receipt.waitFor()
        await page.screenshot({
          path: `${output}/found-logins-receipt.png`,
          fullPage: true,
          animations: 'disabled',
        })
        await receipt.getByRole('button', { name: 'Undo', exact: true }).click()
        await page.waitForFunction(() => {
          const harness = (
            window as unknown as {
              settingsHarness: { calls: { key: string; input?: { enabled?: boolean } }[] }
            }
          ).settingsHarness
          return (
            harness.calls.filter((call) => call.key === 'credentials.useOnMyMachines.mutate').at(-1)
              ?.input?.enabled === true
          )
        })
      }
      if (errors.length) throw new Error(errors.join('\n'))
      await page.close()
    }
  } finally {
    await browser.close()
  }
} finally {
  server.kill()
  await server.exited
}
