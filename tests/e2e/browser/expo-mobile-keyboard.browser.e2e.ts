import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(120_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-432')

test('Expo terminal keyboard is compact, mono, and visibly scrollable', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })

  await page.addInitScript(() => {
    class SpeechRecognitionFake {
      lang = ''
      continuous = false
      interimResults = false
      onresult: ((event: unknown) => void) | null = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      start() {}
      stop() {
        this.onend?.()
      }
    }
    ;(
      globalThis as unknown as { SpeechRecognition: typeof SpeechRecognitionFake }
    ).SpeechRecognition = SpeechRecognitionFake
  })

  await page.goto(`/mobile?server=${RELAY}&e2e=1`)
  await page.getByRole('button', { name: 'New work' }).click()
  const launcher = page.getByRole('dialog')
  await launcher.getByRole('button', { name: 'Claude Code' }).click()
  await launcher.getByRole('button', { name: 'podium', exact: true }).click()
  await expect(page).toHaveURL(/\/mobile\/session\//, { timeout: 30_000 })

  const sessionUrl = new URL(page.url())
  sessionUrl.searchParams.set('e2e', '1')
  await page.goto(sessionUrl.href)
  await page.getByRole('button', { name: 'Native agent view' }).click()
  await page.waitForFunction(
    () =>
      /keyecho/.test(
        (
          window as unknown as {
            __podium?: { screenText(): string }
          }
        ).__podium?.screenText() ?? '',
      ),
    undefined,
    { timeout: 30_000 },
  )

  await page.setViewportSize({ width: 390, height: 659 })
  const keyboard = page.locator('.mobile-terminal-keyboard')
  const actions = keyboard.locator('.key-actions:visible')
  const toolbarFrame = keyboard.locator('.toolbar-frame:visible')
  const toolbar = keyboard.locator('.toolbar:visible')

  const controlKeyFont = await toolbar
    .locator('button[data-key="Ctrl"]')
    .evaluate((element) => getComputedStyle(element).fontFamily)
  expect(controlKeyFont).toContain('GeistMono_400Regular')
  for (const label of [/Submit/, /Newline/, /Paste/]) {
    await expect(actions.getByRole('button', { name: label })).toHaveCSS(
      'font-family',
      controlKeyFont,
    )
  }

  await expect
    .poll(() => keyboard.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThanOrEqual(84)
  const toolbarMetrics = await toolbar.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(toolbarMetrics.scrollWidth).toBeGreaterThan(toolbarMetrics.clientWidth)
  await expect(toolbarFrame).toHaveClass(/can-scroll-right/)
  await expect
    .poll(() => toolbarFrame.evaluate((element) => getComputedStyle(element, '::after').opacity))
    .toBe('1')

  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-terminal-keyboard.png') })

  const toolbarBox = await toolbar.boundingBox()
  if (!toolbarBox) throw new Error('Terminal toolbar has no browser geometry')
  const touch = await page.context().newCDPSession(page)
  const touchY = toolbarBox.y + toolbarBox.height / 2
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: toolbarBox.x + toolbarBox.width - 30, y: touchY }],
  })
  for (const x of [toolbarBox.x + 250, toolbarBox.x + 160, toolbarBox.x + 30]) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: touchY }],
    })
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  await expect.poll(() => toolbar.evaluate((element) => element.scrollLeft)).toBeGreaterThan(20)
  await expect(toolbarFrame).toHaveClass(/can-scroll-left/)
  await expect
    .poll(() => toolbarFrame.evaluate((element) => getComputedStyle(element, '::before').opacity))
    .toBe('1')
  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-terminal-keyboard-scrolled.png') })

  await actions.getByRole('button', { name: /Submit/ }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __podium?: { screenText(): string }
            }
          ).__podium?.screenText() ?? '',
      ),
    )
    .toMatch(/Enter|Return|\b0d\b/i)
})
