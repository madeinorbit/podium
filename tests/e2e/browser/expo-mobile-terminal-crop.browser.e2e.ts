import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { devices, expect, test } from '@playwright/test'
import { newSession, openApp, podium, RELAY } from './_harness'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium multi-viewer proof',
)
test.setTimeout(180_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-431')

test('phone crops and pans the desktop terminal grid without reflowing it', async ({
  browser,
  page: phone,
}) => {
  const desktopContext = await browser.newContext({
    ...devices['Desktop Chrome'],
    viewport: { width: 1600, height: 900 },
  })
  const desktop = await desktopContext.newPage()

  try {
    await openApp(desktop)
    await newSession(desktop, 'Claude')
    await expect.poll(() => podium.screen(desktop), { timeout: 30_000 }).toContain('keyecho')
    const desktopState = await desktop.evaluate(() =>
      (
        window as unknown as {
          __podium?: { state(): { sessionId: string; cols: number; rows: number; role: string } }
        }
      ).__podium?.state(),
    )
    if (!desktopState) throw new Error('desktop terminal did not expose its state')
    expect(desktopState.role).toBe('controller')
    expect(desktopState.cols).toBeGreaterThan(90)

    await phone.goto(`/mobile/session/${desktopState.sessionId}?server=${RELAY}&e2e=1`)
    await phone.getByRole('button', { name: 'Open terminal' }).click({ timeout: 30_000 })
    await phone.waitForFunction(
      () => !!(window as unknown as { __podium?: unknown }).__podium,
      undefined,
      { timeout: 30_000 },
    )

    await expect
      .poll(
        () =>
          phone.evaluate(() =>
            (
              window as unknown as {
                __podium?: { state(): { cols: number; rows: number; role: string } }
              }
            ).__podium?.state(),
          ),
        { timeout: 15_000 },
      )
      .toMatchObject({
        role: 'spectator',
        cols: desktopState.cols,
        rows: desktopState.rows,
      })

    // The phone rebuilt the running agent's frame at the same grid, rather than
    // reflowing it into the phone's roughly 50-column container.
    const phoneScreen = await phone.evaluate(() =>
      (
        window as unknown as {
          __podium?: { screenText(): string }
        }
      ).__podium?.screenText(),
    )
    const bufferLines = phoneScreen?.split('\n') ?? []
    if (bufferLines.at(-1) === '') bufferLines.pop()
    const visibleLines = bufferLines.slice(-desktopState.rows)
    expect(visibleLines.join('\n')).toContain('keyecho')
    const keyechoLine = visibleLines.findIndex((line) => line.includes('keyecho'))
    const keyechoColumn =
      keyechoLine >= 0 ? (visibleLines[keyechoLine]?.indexOf('keyecho') ?? -1) : -1
    expect(keyechoLine).toBeGreaterThanOrEqual(0)
    expect(keyechoColumn).toBeGreaterThanOrEqual(0)

    const geometry = await phone.locator('[data-terminal-crop-viewport]').evaluate((element) => {
      const viewport = element as HTMLElement
      const screen = viewport.querySelector<HTMLElement>('.xterm-screen')
      if (!screen) throw new Error('xterm screen is unavailable')
      return {
        clientWidth: viewport.clientWidth,
        clientHeight: viewport.clientHeight,
        scrollWidth: viewport.scrollWidth,
        scrollHeight: viewport.scrollHeight,
        screenWidth: screen.getBoundingClientRect().width,
        screenHeight: screen.getBoundingClientRect().height,
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      }
    })
    expect(geometry.screenWidth).toBeGreaterThan(geometry.clientWidth)
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth)
    expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight + 1)

    // Drive a real horizontal touch gesture through Chromium's input stack. The
    // terminal's vertical touch-scroll shim deliberately declines horizontal
    // intent, leaving the overflow viewport to pan natively.
    const cropBox = await phone.locator('[data-terminal-crop-viewport]').boundingBox()
    if (!cropBox) throw new Error('crop viewport is not visible')
    const cdp = await phone.context().newCDPSession(phone)
    const y = cropBox.y + Math.min(80, cropBox.height / 2)
    const startX = cropBox.x + cropBox.width - 24
    const endX = cropBox.x + 24
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y }],
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: endX, y }],
    })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect
      .poll(() =>
        phone
          .locator('[data-terminal-crop-viewport]')
          .evaluate((element) => (element as HTMLElement).scrollLeft),
      )
      .toBeGreaterThan(0)

    // Center the captured review frame on known live TUI content. The preceding
    // assertion is the real touch gesture; this deterministic positioning keeps
    // the evidence useful when keyecho centers itself differently at each grid.
    await phone.locator('[data-terminal-crop-viewport]').evaluate(
      (element, target) => {
        const viewport = element as HTMLElement
        const screen = viewport.querySelector<HTMLElement>('.xterm-screen')
        if (!screen) throw new Error('xterm screen is unavailable')
        viewport.scrollLeft =
          (target.column + 3) * (screen.getBoundingClientRect().width / target.cols) -
          viewport.clientWidth / 2
        viewport.scrollTop =
          (target.line + 0.5) * (screen.getBoundingClientRect().height / target.rows) -
          viewport.clientHeight / 2
      },
      {
        column: keyechoColumn,
        line: keyechoLine,
        cols: desktopState.cols,
        rows: desktopState.rows,
      },
    )
    await phone.waitForTimeout(100) // allow the deterministic review position to paint
    mkdirSync(ARTIFACTS, { recursive: true })
    await phone.screenshot({
      path: resolve(ARTIFACTS, 'mobile-terminal-server-grid.png'),
      fullPage: true,
    })

    // Attaching/looking from the phone did not silently take control or shrink
    // the desktop's PTY.
    await expect
      .poll(() =>
        desktop.evaluate(() =>
          (
            window as unknown as {
              __podium?: { state(): { cols: number; rows: number; role: string } }
            }
          ).__podium?.state(),
        ),
      )
      .toMatchObject({ role: 'controller', cols: desktopState.cols, rows: desktopState.rows })
  } finally {
    await desktopContext.close()
  }
})
