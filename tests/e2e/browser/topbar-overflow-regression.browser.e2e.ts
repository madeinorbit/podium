/**
 * #63 preview regressions on the desktop shell:
 *  1. the Podium wordmark must render at its handoff size (~15px tall in the
 *     44px top bar, proportional width) — not the SVG's fallback intrinsic box
 *     (Tailwind preflight `img { height: auto }` beats the HTML height attribute).
 *  2. the authenticated desktop document must not scroll vertically: shell and
 *     sidebar end exactly at the viewport, while the sidebar's own work list
 *     keeps its inner scrolling.
 */
import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop shell geometry coverage')

/** viewBox of .design/podium-logo.svg — 290.9 225.3 826.4 317.7 */
const LOGO_ASPECT = 826.4 / 317.7

const DESKTOP_SIZES = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]

test('top bar matches the handoff: 44px bar, ~15px proportional logo, exact controls', async ({
  page,
}) => {
  await openApp(page)

  const header = page.getByTestId('desktop-topbar')
  await expect(header).toBeVisible()
  const headerBox = await header.boundingBox()
  expect(Math.round(headerBox?.height ?? 0)).toBe(44)

  // The wordmark: computed CSS height ~15px (the preflight `img { height: auto }`
  // must not win), width proportional to the SVG viewBox, box contained in the bar.
  const logo = header.locator('img[alt="Podium"]')
  await expect(logo).toBeVisible()
  const logoMetrics = await logo.evaluate((el) => {
    const cs = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return { cssHeight: cs.height, w: box.width, h: box.height, top: box.top, bottom: box.bottom }
  })
  expect(logoMetrics.h).toBeGreaterThan(13)
  expect(logoMetrics.h).toBeLessThan(17)
  expect(logoMetrics.w / logoMetrics.h).toBeGreaterThan(LOGO_ASPECT - 0.1)
  expect(logoMetrics.w / logoMetrics.h).toBeLessThan(LOGO_ASPECT + 0.1)
  // No overlay: fully inside the 44px bar.
  expect(logoMetrics.top).toBeGreaterThanOrEqual(headerBox?.y ?? 0)
  expect(logoMetrics.bottom).toBeLessThanOrEqual((headerBox?.y ?? 0) + (headerBox?.height ?? 0))

  // Exact intended controls (handoff v2 desktop anatomy, shell-layout.md §2.1):
  // logo · text nav Home/Issues/Specs/Automations · right-aligned host chips.
  const nav = header.getByRole('navigation', { name: 'Primary' })
  const navLabels = await nav
    .locator('button')
    .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim().replace(/\d+$/, '')))
  expect(navLabels).toEqual(['Home', 'Issues', 'Workflows', 'Specs', 'Automations'])
  // The mobile-header anatomy must NOT leak into the desktop bar.
  for (const name of ['Superagent', 'Issue context', 'New agent']) {
    await expect(header.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  await expect(header.locator('.header-host-indicators')).toBeAttached()

  // Handoff geometry: 0 14px padding, 10px gap, 11.5px nav type, logo leftmost.
  const barMetrics = await header.evaluate((el) => {
    const cs = getComputedStyle(el)
    const navItem = el.querySelector('nav button')
    return {
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      gap: cs.gap,
      navFontSize: navItem ? getComputedStyle(navItem).fontSize : '',
    }
  })
  expect(barMetrics.paddingLeft).toBe('14px')
  expect(barMetrics.paddingRight).toBe('14px')
  expect(barMetrics.gap).toBe('10px')
  expect(barMetrics.navFontSize).toBe('11.5px')
  const logoBox = await logo.boundingBox()
  const firstNavBox = await nav.locator('button').first().boundingBox()
  expect(firstNavBox?.x ?? 0).toBeGreaterThan((logoBox?.x ?? 0) + (logoBox?.width ?? 0))
})

test('desktop document never scrolls; shell and sidebar end at the viewport', async ({ page }) => {
  await openApp(page)

  for (const size of DESKTOP_SIZES) {
    await page.setViewportSize(size)
    // Give layout a frame to settle after the resize.
    await page.evaluate(() => new Promise(requestAnimationFrame))

    const geom = await page.evaluate(() => {
      const doc = document.documentElement
      const shell = document.querySelector('.desktop-shell')
      const row = document.querySelector('.desktop-shell-row')
      const sidebar = document.querySelector('[data-resizable-column="podium:sidebar:width"]')
      const rect = (el: Element | null) => el?.getBoundingClientRect() ?? null
      const shellCs = shell ? getComputedStyle(shell) : null
      return {
        scrollHeight: doc.scrollHeight,
        clientHeight: doc.clientHeight,
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        innerHeight: window.innerHeight,
        shell: rect(shell),
        row: rect(row),
        sidebar: rect(sidebar),
        shellPosition: shellCs?.position,
        shellOverflow: shellCs?.overflow,
      }
    })

    // No page-level scrollbar in either axis: nothing extends past the viewport.
    expect(geom.scrollHeight, `document overflows at ${size.width}x${size.height}`).toBe(
      geom.clientHeight,
    )
    expect(geom.scrollWidth, `document overflows horizontally at ${size.width}`).toBe(
      geom.clientWidth,
    )
    // The shell must stay a positioned clip: without position, absolutely
    // positioned descendants (sr-only labels) escape overflow:hidden and grow
    // the document's scrollable overflow (#63 blank-space-below-sidebar chain).
    expect(geom.shellPosition).toBe('relative')
    expect(geom.shellOverflow).toBe('hidden')
    // Shell, column row, and sidebar all end exactly at the viewport bottom.
    expect(Math.round(geom.shell?.bottom ?? 0)).toBe(size.height)
    expect(Math.round(geom.row?.bottom ?? 0)).toBe(size.height)
    expect(Math.round(geom.sidebar?.bottom ?? 0)).toBe(size.height)
    expect(Math.round(geom.shell?.top ?? -1)).toBe(0)
  }

  // The fix must not kill legitimate inner sidebar scrolling: the work list
  // remains a scroll container (overflow-y auto/scroll with bounded height).
  const sidebarScroller = await page.evaluate(() => {
    const aside = document.querySelector('[data-resizable-column="podium:sidebar:width"]')
    if (!aside) return null
    for (const el of aside.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
        return { found: true, clientHeight: el.clientHeight }
      }
    }
    return { found: false, clientHeight: 0 }
  })
  expect(sidebarScroller?.found).toBe(true)
  expect(sidebarScroller?.clientHeight ?? 0).toBeGreaterThan(0)
})
