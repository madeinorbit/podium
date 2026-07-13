import { expect, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

// Copy OUT of a native terminal pane (#24). Two paths, both must land in the
// system clipboard:
//   1. selection copy — drag-select in the xterm grid, then the copy chord
//      (Ctrl/Cmd+Shift+C or Cmd+C); select-alone also copies (PRIMARY-style);
//   2. OSC 52 — the agent writes ESC ] 52 ; c ; <base64> BEL and it must travel
//      the whole PTY → abduco → daemon → relay → browser chain into the
//      terminal, which forwards the decoded payload to navigator.clipboard.
// Desktop Chromium only: clipboard permission grants + mouse drag are desktop
// Chromium semantics (Playwright WebKit has no clipboard-read grant).
test.skip(
  ({ isMobile, browserName }) => isMobile || browserName !== 'chromium',
  'desktop chromium clipboard semantics',
)

/** Bounding box of the VISIBLE terminal screen (hidden panes stay in the DOM). */
async function screenBox(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.xterm-screen')) as HTMLElement[]
    const el =
      els.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ?? els[0]
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
}

test('drag-select + copy chord puts the selection on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await newSession(page, 'Claude')
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __podium?: { screenText(): string } }
      return /keyecho/.test(w.__podium?.screenText() ?? '')
    },
    undefined,
    { timeout: 15_000 },
  )

  // Seed the clipboard so we can tell "copied nothing" from "copied empty".
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'))

  // Drag-select across the keyecho banner row.
  const box = await screenBox(page)
  const rowY = Math.round(box.y + 8)
  await page.mouse.move(Math.round(box.x + 4), rowY)
  await page.mouse.down()
  await page.mouse.move(Math.round(box.x + box.w * 0.6), rowY, { steps: 8 })
  await page.mouse.up()

  // Select-alone should already have copied (PRIMARY-style)…
  const afterSelect = await page.evaluate(() => navigator.clipboard.readText())
  // …and the explicit chord must work regardless.
  await page.keyboard.press('Control+Shift+C')
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 })
    .toContain('keyecho')
  expect(afterSelect, 'mouse-selection alone should copy').toContain('keyecho')

  // The Mac chord: Cmd+C (metaKey). The selection survives the earlier copies,
  // so reset the clipboard and prove the chord repopulates it by itself.
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL-META'))
  await page.keyboard.press('Meta+c')
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 })
    .toContain('keyecho')
})

test('selection copy still works with NO async Clipboard API (plain-http origins)', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  // Over a non-secure origin (LAN IP / tailnet plain http) navigator.clipboard is
  // simply absent — the copy path must fall back to execCommand('copy').
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await newSession(page, 'Claude')
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __podium?: { screenText(): string } }
      return /keyecho/.test(w.__podium?.screenText() ?? '')
    },
    undefined,
    { timeout: 15_000 },
  )

  const box = await screenBox(page)
  const rowY = Math.round(box.y + 8)
  await page.mouse.move(Math.round(box.x + 4), rowY)
  await page.mouse.down()
  await page.mouse.move(Math.round(box.x + box.w * 0.6), rowY, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.press('Control+Shift+C')

  // This page has no clipboard API by construction — read from a sibling page.
  const reader = await context.newPage()
  await reader.goto('/health')
  await reader.bringToFront()
  await expect
    .poll(async () => reader.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 })
    .toContain('keyecho')
  await reader.close()
})

test('OSC 52 from the PTY lands on the system clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await newSession(page, 'Claude') // keyecho jig; Ctrl+Y makes it emit OSC 52
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __podium?: { screenText(): string } }
      return /keyecho/.test(w.__podium?.screenText() ?? '')
    },
    undefined,
    { timeout: 15_000 },
  )
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'))

  // Ctrl+Y (0x19) → keyecho answers with ESC ] 52 ; c ; <base64> BEL, which must
  // survive PTY → abduco → daemon → relay → xterm and land on the clipboard.
  await podium.send(page, '\x19')

  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
    .toBe('keyecho osc52 payload')
})
