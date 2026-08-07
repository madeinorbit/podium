import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * The floating composer's geometry proof [POD-502].
 *
 * The defect this guards is invisible to the unit lane: happy-dom has no layout
 * engine, so a composer that measures its own content can only be proved in a
 * real one. The old field stayed 276x45 for a long wrapped prompt (POD-497's
 * runtime evidence) because react-native-web renders `multiline` as a
 * `<textarea>`, which never grows.
 */
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'phone composer geometry proof',
)
test.use({ viewport: { width: 393, height: 659 } })
// The Expo bundle's first paint plus four settled spring animations and three
// screenshots do not fit the 30s default.
test.setTimeout(120_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-502')

/** One body line at the composer's leading — apps/mobile/src/components/composer-height.ts. */
const LINE = 22
const MAX_LINES = 6
/** The spring has to settle before a height is worth reading. */
const SETTLE = { timeout: 5_000 }

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

test('the composer floats, grows through six lines, then scrolls', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })

  await page.goto('/mobile/session/demo-perf?demo=1')
  const field = page.getByLabel('Message the agent…')
  await expect(field).toBeVisible({ timeout: 60_000 })

  const bar = page.getByTestId('composer-bar')
  const barBox = () =>
    bar.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
    })
  const fieldHeight = () => field.evaluate((element) => element.clientHeight)
  // Scoped to the bar: the session's inline action card offers "Send back…".
  const sendBottom = async () =>
    Math.round(
      await bar
        .getByRole('button', { name: 'Send', exact: true })
        .evaluate((element) => element.getBoundingClientRect().bottom),
    )

  // It floats: inset from both edges and clear of the bottom of the screen.
  const resting = await barBox()
  expect(resting.left).toBeGreaterThanOrEqual(12)
  expect(resting.right).toBeLessThanOrEqual(393 - 12)
  expect(Math.round(resting.bottom)).toBeLessThan(659)
  // A one-line composer rests in the 50-56pt band, not the old 45px slab plus
  // full-width chrome. The activity caption shares the surface on this screen.
  const restingHeight = Math.round(resting.bottom - resting.top)
  expect(restingHeight).toBeGreaterThanOrEqual(46)
  expect(restingHeight).toBeLessThanOrEqual(80)
  await expect.poll(fieldHeight, SETTLE).toBe(LINE)
  const restingSendToBottom = Math.round(resting.bottom) - (await sendBottom())

  await page.screenshot({ path: resolve(ARTIFACTS, 'composer-resting.png') })

  // Growth: the field is worth one line per line, and the send control does not
  // move away from the bottom edge of the surface while the text grows above it.
  await field.fill(lines(4))
  await expect.poll(fieldHeight, SETTLE).toBe(4 * LINE)

  const grown = await barBox()
  expect(Math.round(grown.bottom)).toBe(Math.round(resting.bottom)) // grows upward only
  expect(Math.round(grown.bottom - grown.top)).toBeGreaterThan(restingHeight)
  expect(Math.round(grown.bottom) - (await sendBottom())).toBe(restingSendToBottom)
  await page.screenshot({ path: resolve(ARTIFACTS, 'composer-four-lines.png') })

  // The cap: past six lines the surface stops and the field scrolls inside it.
  await field.fill(lines(14))
  await expect.poll(fieldHeight, SETTLE).toBe(MAX_LINES * LINE)

  const capped = await barBox()
  expect(Math.round(capped.bottom)).toBe(Math.round(resting.bottom))
  expect(Math.round(capped.bottom) - (await sendBottom())).toBe(restingSendToBottom)
  expect(
    await field.evaluate((element) => (element as HTMLTextAreaElement).scrollHeight),
  ).toBeGreaterThan(MAX_LINES * LINE)

  // The caret stays visible: typing at the end scrolls the field to it rather
  // than leaving the operator looking at line one.
  await field.press('End')
  await field.pressSequentially(' tail')
  await expect
    .poll(() =>
      field.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement
        return textarea.scrollHeight - textarea.scrollTop - textarea.clientHeight
      }),
    )
    .toBeLessThanOrEqual(LINE)
  await page.screenshot({ path: resolve(ARTIFACTS, 'composer-capped.png') })

  // Shrinking back: deleting the content returns the field to one line. The old
  // measurement could only ever grow — react-native-web's `scrollHeight` is
  // floored at the element's own height.
  await field.fill('')
  await expect.poll(fieldHeight, SETTLE).toBe(LINE)
  await expect
    .poll(async () => Math.round((await barBox()).bottom - (await barBox()).top), SETTLE)
    // The activity caption is live copy on this screen and can rewrap by a pixel.
    .toBeLessThanOrEqual(restingHeight + 2)
})
