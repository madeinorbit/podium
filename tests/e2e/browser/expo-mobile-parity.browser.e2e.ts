import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(180_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1066')

const IME_ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1069')

async function eventCount(page: import('@playwright/test').Page): Promise<number> {
  const matches = Array.from((await screenText(page)).matchAll(/events=(\d+)/g))
  // The buffer can retain older Ink frames in scrollback; the final header is
  // current. Both mode logs each input once from raw and once from Ink.
  return Number(matches.at(-1)?.[1] ?? 0) / 2
}

async function screenText(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __podium?: { screenText(): string }
        }
      ).__podium?.screenText() ?? '',
  )
}
async function setVisualViewportHeight(
  page: import('@playwright/test').Page,
  height: number,
): Promise<void> {
  await page.evaluate((nextHeight) => {
    const viewport = window.visualViewport
    if (!viewport) throw new Error('visualViewport is unavailable')
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      value: nextHeight,
    })
    viewport.dispatchEvent(new Event('resize'))
  }, height)
}

test('Expo New Work, task agent creation, and full terminal keyboard work end to end', async ({
  page,
}) => {
  mkdirSync(ARTIFACTS, { recursive: true })
  mkdirSync(IME_ARTIFACTS, { recursive: true })

  // Chromium's headless build does not expose Web Speech. Supply the browser
  // contract so the real voice hook and its start/stop UI can be exercised.
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
  await expect(page.getByRole('button', { name: 'New work' })).toBeVisible({ timeout: 60_000 })

  // The root plus opens the compact launcher; Session options keeps the full form reachable.
  await page.getByRole('button', { name: 'New work' }).click()
  await expect(page.getByText('New work', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Session options…' }).click()
  await expect(page).toHaveURL(/\/mobile\/new-session(?:\?|$)/)
  await expect(page.getByText('New session', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Working directory')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Agent Default' })).toBeVisible()
  await page.screenshot({ path: resolve(ARTIFACTS, 'new-work-session-flow.png'), fullPage: true })
  await page.getByRole('button', { name: 'Back' }).click()

  // File a task without an initial agent, then add one from the task itself.
  await page.getByRole('button', { name: 'Tasks' }).click()
  await page.getByRole('button', { name: 'New task' }).click()
  await expect(page.getByLabel(/^Repository /).first()).toBeVisible({ timeout: 30_000 })
  const title = `Expo agent parity ${Date.now()}`
  await page.getByLabel('Task title').fill(title)
  await page.getByRole('button', { name: 'Agent will start now' }).click()
  await expect(page.getByRole('button', { name: 'File without starting' })).toBeVisible()
  await page.getByRole('button', { name: 'Create task' }).click()

  await expect(page.getByRole('button', { name: 'Add agent' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Add agent' }).click()
  await expect(page).toHaveURL(/\/mobile\/new-session\?.*issueId=/)
  await expect(page.getByText(new RegExp(`Attached to #\\d+ ${title}`))).toBeVisible()
  await expect(page.getByLabel('Working directory')).not.toHaveValue('')
  await page.screenshot({ path: resolve(ARTIFACTS, 'add-agent-to-task.png'), fullPage: true })

  await page.getByRole('button', { name: 'Agent Claude Code' }).click()
  await page.getByRole('button', { name: 'Add agent' }).click()
  await expect(page).toHaveURL(/\/mobile\/session\//, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: /Task POD-\d+ — peek/ })).toBeVisible()

  // Switch through the real UI to the terminal and wait for the real harness
  // PTY/keyecho process. The controls below are clicked, not invoked via APIs.
  // Expo navigation does not carry the root query onto pushed routes, so add
  // the documented diagnostic switch to this session URL before the pane mounts.
  await page.evaluate(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('e2e', '1')
    window.history.replaceState(window.history.state, '', url)
  })
  await page.getByRole('button', { name: 'Native agent view' }).click()
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __podium?: { screenText(): string } }).__podium
      return /keyecho/.test(api?.screenText() ?? '')
    },
    undefined,
    { timeout: 30_000 },
  )

  const actions = page.locator('.mobile-terminal-keyboard .key-actions:visible')
  const toolbar = page.locator('.mobile-terminal-keyboard .toolbar:visible')
  await expect(actions.getByRole('button', { name: /Submit/ })).toBeVisible()
  await expect(actions.getByRole('button', { name: /Newline/ })).toBeVisible()
  await expect(actions.getByRole('button', { name: /Paste/ })).toBeVisible()
  await expect(actions.getByRole('button', { name: /Arrow keys/ })).toBeVisible()
  await expect(actions.getByRole('button', { name: /Voice input/ })).toBeVisible()
  for (const key of [
    'Ctrl',
    'Esc',
    'Tab',
    '⇧Tab',
    '^C',
    '^D',
    '^R',
    '^L',
    '^Z',
    '~',
    '/',
    '|',
    '-',
  ]) {
    await expect(toolbar.locator(`button[data-key="${key}"]`)).toBeAttached()
  }

  const mic = actions.getByRole('button', { name: /Voice input/ })
  await mic.click()
  await expect(actions.getByRole('button', { name: 'Stop voice input' })).toBeVisible()
  await actions.getByRole('button', { name: 'Stop voice input' }).click()

  let seen = ''
  await toolbar.locator('button[data-key="Esc"]').click()
  await expect
    .poll(async () => {
      seen += await screenText(page)
      return /Escape|Esc|\b1b\b/i.test(seen)
    })
    .toBe(true)

  await actions.getByRole('button', { name: /Submit/ }).click()
  await expect
    .poll(async () => {
      seen += await screenText(page)
      return /Enter|Return|\b0d\b/i.test(seen)
    })
    .toBe(true)

  await actions.getByRole('button', { name: /Newline/ }).click()
  await expect
    .poll(async () => {
      seen += await screenText(page)
      return /Alt\+Enter|1b 0d|Escape.*(?:Enter|Return)/i.test(seen)
    })
    .toBe(true)

  const dpad = actions.getByRole('button', { name: /Arrow keys/ })
  await expect(dpad).toHaveCSS('background-color', 'rgb(22, 22, 28)')
  await expect(dpad).toHaveCSS('border-color', 'rgb(46, 46, 56)')
  await expect(dpad.locator('.ask-g')).toHaveCount(4)
  for (const glyph of await dpad.locator('.ask-g').all()) {
    await expect(glyph).toHaveCSS('color', 'rgb(154, 154, 168)')
  }

  const dpadBox = await dpad.boundingBox()
  expect(dpadBox).not.toBeNull()
  expect(dpadBox?.width).toBeCloseTo(40, 0)
  expect(dpadBox?.height).toBeCloseTo(30, 0)
  if (!dpadBox) throw new Error('D-pad has no browser geometry')

  const originX = dpadBox.x + dpadBox.width / 2
  const originY = dpadBox.y + dpadBox.height / 2

  // A short drag remains in the precision zone: immediate emit, slow repeat.
  const nearStart = await eventCount(page)
  await page.mouse.move(originX, originY)
  await page.mouse.down()
  await page.mouse.move(originX + 18, originY, { steps: 4 })
  await page.waitForTimeout(1_250)
  await page.mouse.up()
  let nearRepeats = 0
  await expect
    .poll(async () => {
      nearRepeats = (await eventCount(page)) - nearStart
      return nearRepeats
    })
    .toBeGreaterThanOrEqual(3)
  expect(nearRepeats).toBeLessThanOrEqual(6)

  // The same gesture at the constrained screen edge accelerates toward the
  // historical ~15 cps edge-hold rate. Keep the pointer down for visual proof.
  const edgeStart = await eventCount(page)
  await page.mouse.move(originX, originY)
  await page.mouse.down()
  const viewportWidth = page.viewportSize()?.width ?? 393
  await page.mouse.move(Math.min(viewportWidth - 11, originX + 76), originY, { steps: 6 })
  const overlay = page.locator('.ask-float.visible')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.ask-float-bubble')).toHaveCSS('border-color', 'rgb(42, 42, 52)')
  await expect(overlay.locator('.ask-float-bubble')).toHaveCSS('width', '68px')
  await expect(overlay.locator('.ask-float-bubble')).toHaveCSS('height', '68px')
  await page.waitForTimeout(1_250)
  await page.screenshot({
    path: resolve(ARTIFACTS, 'expo-terminal-dpad-drag.png'),
    fullPage: true,
  })
  await page.mouse.up()
  let edgeRepeats = 0
  await expect
    .poll(async () => {
      edgeRepeats = (await eventCount(page)) - edgeStart
      return edgeRepeats
    })
    .toBeGreaterThan(nearRepeats + 4)

  // Direction changes happen under one continuous finger drag after the
  // original 50 ms switch gate, rather than requiring separate taps.
  const switchStart = await eventCount(page)
  await page.mouse.move(originX, originY)
  await page.mouse.down()
  await page.mouse.move(originX + 42, originY, { steps: 3 })
  await page.mouse.move(originX, originY - 42, { steps: 3 })
  await page.waitForTimeout(70)
  await page.mouse.move(originX, originY - 44)
  await page.mouse.up()
  await expect.poll(async () => (await eventCount(page)) - switchStart).toBeGreaterThanOrEqual(2)
  await expect
    .poll(async () => {
      seen += await screenText(page)
      return /Right|1b 5b 43/i.test(seen) && /Up|1b 5b 41/i.test(seen)
    })
    .toBe(true)

  const pasteMarker = `expo-paste-${Date.now()}`
  await actions.getByRole('button', { name: /Paste/ }).click()
  const pasteTarget = page.getByRole('textbox', { name: 'Paste target' })
  await expect(pasteTarget).toBeVisible()
  await pasteTarget.evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }))
  }, pasteMarker)
  await expect
    .poll(async () => {
      seen += await screenText(page)
      return seen.includes(pasteMarker)
    })
    .toBe(true)

  // One-shot Ctrl remains armed through the click, transforms one soft-keyboard
  // letter, and automatically releases after the terminal receives it.
  const ctrl = toolbar.locator('button[data-key="Ctrl"]')
  await ctrl.click()
  await expect(ctrl).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.type('a')
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => {
      seen += await screenText(page)
      return /Ctrl\+A|\b01\b/i.test(seen)
    })
    .toBe(true)

  // iOS keeps innerHeight at the layout viewport while the OS keyboard shrinks
  // visualViewport. The whole Expo root must follow that visible height so the
  // terminal refits and the accessory sits directly on top of the IME.
  const layoutHeight = await page.evaluate(() => window.innerHeight)
  const visibleHeight = layoutHeight - 340
  await setVisualViewportHeight(page, visibleHeight)

  const viewportRoot = page.locator('[data-mobile-visual-viewport-root]')
  await expect
    .poll(() =>
      viewportRoot.evaluate((element) => Math.round(element.getBoundingClientRect().height)),
    )
    .toBe(visibleHeight)
  await expect
    .poll(() => toolbar.evaluate((element) => Math.round(element.getBoundingClientRect().bottom)))
    .toBe(visibleHeight)
  const actionTop = await actions.evaluate((element) => element.getBoundingClientRect().top)
  await expect
    .poll(() =>
      page
        .locator('.xterm-screen:visible')
        .evaluate((element) => Math.round(element.getBoundingClientRect().bottom)),
    )
    .toBeLessThanOrEqual(Math.round(actionTop + 1))

  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Pixel project has no viewport')
  await page.screenshot({
    path: resolve(IME_ARTIFACTS, 'expo-keyboard-above-ime.png'),
    clip: { x: 0, y: 0, width: viewport.width, height: visibleHeight },
  })

  await setVisualViewportHeight(page, layoutHeight)
  await expect
    .poll(() => toolbar.evaluate((element) => Math.round(element.getBoundingClientRect().bottom)))
    .toBe(layoutHeight)

  await page.screenshot({ path: resolve(ARTIFACTS, 'expo-terminal-keyboard.png'), fullPage: true })
})
