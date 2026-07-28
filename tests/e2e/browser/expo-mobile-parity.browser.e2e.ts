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

test('Expo New Work, task agent creation, and full terminal keyboard work end to end', async ({
  page,
}) => {
  mkdirSync(ARTIFACTS, { recursive: true })

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

  // The root header shortcut enters the canonical full New Session flow.
  await page.getByRole('button', { name: 'New work' }).click()
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
  const dpadBox = await dpad.boundingBox()
  expect(dpadBox).not.toBeNull()
  if (dpadBox) {
    await page.mouse.move(dpadBox.x + dpadBox.width / 2, dpadBox.y + dpadBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(dpadBox.x + dpadBox.width + 24, dpadBox.y + dpadBox.height / 2, {
      steps: 4,
    })
    await page.mouse.up()
  }
  await expect
    .poll(async () => {
      seen += await screenText(page)
      return /Right|1b 5b 43/i.test(seen)
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

  await page.screenshot({ path: resolve(ARTIFACTS, 'expo-terminal-keyboard.png'), fullPage: true })
})
