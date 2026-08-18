/**
 * THE PROMPT BOX TAKES MEDIA, AND ENTER MAKES A LINE [POD-1354].
 *
 * Both are event-routing facts a unit test cannot establish. The paste handler
 * is bound to react-native-web's real `<textarea>` node and has to intercept a
 * genuine `ClipboardEvent` carrying a File; the upload then has to reach the
 * harness daemon and come back as an absolute path the prompt can carry. And
 * the return key has to reach the field as a newline on a touch device rather
 * than firing the message — which is what it used to do.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(120_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1354')

/** One opaque pixel — the smallest thing that is honestly a PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function launchSession(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/mobile?server=${RELAY}&e2e=1`)
  await expect(page.getByRole('button', { name: 'New work' })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'New work' }).click()
  await page.getByRole('button', { name: /^Start in / }).click()
  await expect(page).toHaveURL(/\/mobile\/session\//, { timeout: 30_000 })
  await expect(page.getByLabel(/^Message/)).toBeVisible({ timeout: 30_000 })
}

test('a pasted image becomes an attachment the prompt can send', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })
  await launchSession(page)

  // The composer's own node, not the document: the handler is bound there so a
  // paste into the PROMPT is distinguishable from a paste anywhere else.
  await page.evaluate((base64) => {
    const field = document.querySelector('textarea')
    if (!field) throw new Error('composer textarea not found')
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const file = new File([bytes], 'pasted.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    field.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, PIXEL)

  const chip = page.getByTestId('composer-attachment')
  await expect(chip).toHaveCount(1, { timeout: 20_000 })
  // Send unlocks only once the bytes are on the session's machine: an attachment
  // still uploading would put a path in the prompt that does not exist yet.
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await page.screenshot({ path: resolve(ARTIFACTS, 'composer-pasted-image.png'), fullPage: true })

  await page.getByLabel(/^Message/).fill('what is this?')
  await send.click()

  // The optimistic row carries the words and the picture, not the raw path the
  // agent receives.
  await expect(page.getByText('what is this?')).toBeVisible({ timeout: 20_000 })
  await expect(chip).toHaveCount(0)
  await page.screenshot({
    path: resolve(ARTIFACTS, 'composer-sent-with-image.png'),
    fullPage: true,
  })
})

test('Enter makes a newline on a touch keyboard instead of sending', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })
  // The demo store is enough here and costs no daemon: this is a keyboard-routing
  // fact about the field, not about delivery.
  await page.goto('/mobile/session/demo-perf?demo=1')
  const field = page.getByLabel('Message the agent…')
  await expect(field).toBeVisible({ timeout: 60_000 })

  await field.click()
  await field.pressSequentially('first line')
  await page.keyboard.press('Enter')
  await field.pressSequentially('second line')

  // Still in the field, both lines intact — the whole point: a soft keyboard has
  // no Shift to reach for, and the message used to fire half-written.
  await expect(field).toHaveValue('first line\nsecond line')
  await page.screenshot({ path: resolve(ARTIFACTS, 'composer-enter-newline.png'), fullPage: true })
})
