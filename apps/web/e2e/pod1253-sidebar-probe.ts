/**
 * POD-1253: read the live sidebar's geometry against the numbers the 3a artboard
 * fixes. Prints a table so the comparison is measured, not eyeballed.
 *
 *   P1253_ORIGIN=… PODIUM_SESSION_COOKIE=… bun apps/web/e2e/pod1253-sidebar-probe.ts [outDir]
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1253_ORIGIN ?? 'http://127.0.0.1:55741'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''
const OUT = process.argv[2] ?? ''

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1500, height: 950 },
  deviceScaleFactor: 2,
})
if (COOKIE) {
  await ctx.addCookies([
    { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/', secure: false },
  ])
}
const page = await ctx.newPage()
page.setDefaultTimeout(120_000)
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 180_000 })
await page.waitForSelector('[data-testid="work-scroll"]', { timeout: 180_000 })
await page.waitForTimeout(4000)

const probe = await page.evaluate(() => {
  const m = (sel: string, root: ParentNode = document) => {
    const el = root.querySelector(sel)
    if (!el) return { missing: sel }
    const b = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      h: Math.round(b.height * 10) / 10,
      w: Math.round(b.width * 10) / 10,
      pad: cs.padding,
      gap: cs.gap,
      bg: cs.backgroundColor,
      color: cs.color,
      font: `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight}`,
      border: `${cs.borderWidth} ${cs.borderColor}`,
      radius: cs.borderRadius,
    }
  }
  const rows = [...document.querySelectorAll('[data-testid="work-scroll"] .shell-work-row')]
  const rowInfo = rows.slice(0, 40).map((r) => ({
    h: Math.round(r.getBoundingClientRect().height * 10) / 10,
    meter: !!r.querySelector('[data-testid="row-progress"]'),
    title: (r.querySelector('.shell-work-row-title')?.textContent ?? '').slice(0, 22),
  }))
  return {
    sidebarRoot: m('[data-testid="work-sidebar"]') ?? null,
    spawnBlock: m('[data-testid="new-agent-button"]'),
    spawnBlockParent: (() => {
      const el = document.querySelector('[data-testid="new-agent-button"]')?.parentElement
      if (!el) return null
      const cs = getComputedStyle(el)
      return { pad: cs.padding, border: cs.borderBottomWidth, h: el.getBoundingClientRect().height }
    })(),
    spawnBtn: m('[data-testid="new-agent-button"] button'),
    search: m('[data-testid="work-search"]'),
    band: m('[data-testid="project-group-label"]'),
    bandLabel: m('[data-testid="project-group-label"] .label-mono'),
    bandCount: m('[data-testid="project-group-count"]'),
    scroller: m('[data-testid="work-scroll"]'),
    closedFold: m('[data-testid="closed-fold-toggle"]'),
    footerHint: m('[data-testid="palette-hint"]'),
    meterCount: document.querySelectorAll('[data-testid="row-progress"]').length,
    meter: m('[data-testid="row-progress"]'),
    rowRule: (() => {
      const r = document.querySelector('.shell-work-row')
      if (!r) return null
      const cs = getComputedStyle(r)
      return { pad: cs.padding, minH: cs.minHeight, border: cs.borderBottomColor }
    })(),
    rows: rowInfo,
  }
})
console.log(JSON.stringify(probe, null, 1))
if (OUT) await page.screenshot({ path: `${OUT}/full-window.png` })
await browser.close()
