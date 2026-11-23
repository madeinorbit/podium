import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const out = resolve(process.argv[2] ?? '/tmp/phone-agent-setup')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  for (const [state, appearance] of [
    ['panel', 'light'],
    ['harness', 'light'],
    ['picker', 'light'],
    ['signin', 'light'],
    ['login', 'light'],
    ['failed', 'light'],
    ['panel', 'dark'],
  ]) {
    await page.goto(
      `http://127.0.0.1:8097/agent-setup-harness.html?state=${state}&appearance=${appearance}`,
      { waitUntil: 'networkidle' },
    )
    await page
      .getByText(
        state === 'login'
          ? 'Finish agent sign-in'
          : state === 'picker'
            ? 'Agent'
            : state === 'harness'
              ? 'Claude Code'
              : state === 'signin'
                ? 'Pi'
                : 'Set up agents',
        { exact: true },
      )
      .first()
      .waitFor()
    if (state === 'login') await page.getByRole('button', { name: 'Open login page' }).waitFor()
    await page.evaluate(async () => {
      await document.fonts.ready
      if (!document.fonts.check('17px Geist_400Regular')) throw new Error('Phone font did not load')
    })
    await page.screenshot({ path: `${out}/phone-${state}-${appearance}.png` })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('http://127.0.0.1:8097/agent-setup-harness.html?state=panel&appearance=light', {
    waitUntil: 'networkidle',
  })
  await page.screenshot({ path: `${out}/phone-panel-desktop.png` })
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Phone setup screenshots saved to ${out}`)
} finally {
  await browser.close()
}
