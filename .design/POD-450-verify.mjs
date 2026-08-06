import { chromium } from '@playwright/test'

const auth = Bun.spawnSync(['podium', 'auth', 'mint-session', '--print-only', '--ttl', '10m'])
const token = new TextDecoder().decode(auth.stdout).trim()
if (!token) throw new Error('Could not mint a Podium browser session')
const origin = 'http://localhost:4318'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
await context.addCookies([{ name: 'podium_session', value: token, url: origin }])
await context.addInitScript(() => {
  localStorage.setItem('podium.theme.preset', 'superade')
  localStorage.setItem('podium.theme.mode', 'dark')
  localStorage.setItem('podium.shell.density', 'balanced')
  localStorage.removeItem('podium:sidebar:width')
  localStorage.removeItem('podium:superagent:width')
  window.__PODIUM_DESKTOP__ = Object.freeze({ platform: 'macos', launchMode: 'all-in-one' })
})

const page = await context.newPage()
await page.goto(`${origin}/?e2e=1`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.desktop-shell', { timeout: 30_000 })
await page.waitForTimeout(1800)

const metrics = await page.evaluate(() => {
  const root = document.documentElement
  const css = getComputedStyle(root)
  const row = document.querySelector('.shell-work-row')
  const title = row?.querySelector('.shell-type-primary')
  const status = row?.querySelector('.shell-type-secondary')
  const sidebar = document.querySelector('[data-resizable-column="podium:sidebar:width"]')
  const topbar = document.querySelector('.desktop-topbar')
  const auxiliary = document.querySelector('[data-resizable-column="podium:superagent:width"]')
  const rect = (el) => {
    if (!(el instanceof Element)) return null
    const r = el.getBoundingClientRect()
    return { width: r.width, height: r.height }
  }
  return {
    density: root.dataset.density,
    tokens: {
      reading: css.getPropertyValue('--shell-type-reading').trim(),
      primary: css.getPropertyValue('--shell-type-primary').trim(),
      secondary: css.getPropertyValue('--shell-type-secondary').trim(),
      micro: css.getPropertyValue('--shell-type-micro').trim(),
    },
    geometry: {
      sidebar: rect(sidebar),
      topbar: rect(topbar),
      row: rect(row),
      auxiliary: rect(auxiliary),
    },
    rowType: {
      title: title ? getComputedStyle(title).fontSize : null,
      status: status ? getComputedStyle(status).fontSize : null,
    },
    colors: {
      faint: css.getPropertyValue('--text-faint').trim(),
      dim: css.getPropertyValue('--text-dim').trim(),
      label: css.getPropertyValue('--label').trim(),
    },
  }
})

if (metrics.density !== 'balanced' || metrics.tokens.primary !== '13px') {
  throw new Error(`The running app did not load the balanced shell: ${JSON.stringify(metrics)}`)
}

await page.screenshot({ path: '.design/POD-450-balanced-shell.png', fullPage: true })

await page
  .getByTestId('desktop-topbar')
  .getByRole('button', { name: 'Settings', exact: true })
  .click()
await page.getByRole('button', { name: 'Appearance', exact: true }).click()
const compact = page.getByRole('button', { name: 'Compact', exact: true })
await compact.click()
await page.waitForFunction(() => document.documentElement.dataset.density === 'compact')
const compactPrimary = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--shell-type-primary').trim(),
)
if (compactPrimary !== '12.5px') throw new Error(`Compact did not apply: ${compactPrimary}`)
await page.getByRole('button', { name: 'Balanced', exact: true }).click()
await page.waitForFunction(() => document.documentElement.dataset.density === 'balanced')

await Bun.write('.design/POD-450-balanced-shell-metrics.json', JSON.stringify(metrics, null, 2))
await browser.close()
