/** Real message menu → scoped composer focus regression. Run against the Vite
 * harness through scripts/validation-admission.ts heavy; all sends stay offline. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

if (process.env.PODIUM_VALIDATION_RESOURCE_HELD !== 'heavy') {
  throw new Error('Run through scripts/validation-admission.ts heavy')
}
const arg = (key: string) =>
  process.argv
    .find((value) => value.startsWith(`--${key}=`))
    ?.split('=')
    .slice(1)
    .join('=')
const origin = arg('origin') ?? 'http://127.0.0.1:55991'
const out = resolve(arg('out') ?? '/tmp/message-quote-focus')
const quick = process.argv.includes('--quick')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  executablePath: arg('executable'),
})
const records: unknown[] = []
let failures = 0
const source = 'The third result is ready for review.'
try {
  for (const theme of quick ? ['dark'] : ['dark', 'light']) {
    for (const [width, compact] of quick
      ? ([
          [400, false],
          [720, false],
        ] as const)
      : ([
          [400, false],
          [375, true],
          [720, false],
        ] as const)) {
      for (const reply of quick ? [false] : [false, true]) {
        for (const activation of ['keyboard', 'pointer']) {
          const page = await browser.newPage({
            viewport: { width: 1100, height: 900 },
            hasTouch: compact,
          })
          page.setDefaultTimeout(15_000)
          const errors: string[] = []
          page.on('pageerror', (error) => errors.push(error.message))
          await page.addInitScript(() => {
            const trace: { tag: string; label: string | null; role: string | null }[] = []
            Object.assign(window, { messageFocusTrace: trace })
            document.addEventListener('focusin', (event) => {
              const el = event.target as HTMLElement
              trace.push({
                tag: el.tagName,
                label: el.getAttribute('aria-label'),
                role: el.getAttribute('role'),
              })
            })
          })
          await page.goto(
            `${origin}/harness/mail-reply.html?state=message-quote&width=${width}&theme=${theme}${compact ? '&compact' : ''}`,
          )
          const fonts = await page.evaluate(async () => {
            const faces = await Promise.all([
              document.fonts.load('15px "Geist Variable"', 'Podium 123'),
              document.fonts.load('12px "Geist Mono Variable"', 'Podium 123'),
            ])
            return faces.every(
              (list) => list.length && list.every((face) => face.status === 'loaded'),
            )
          })
          assert.equal(fonts, true)
          const pane = page.locator('[data-reply-pane]')
          const textarea = pane.locator('textarea')
          await textarea.fill('Normal draft to retain.')
          if (reply) {
            await pane.getByRole('button', { name: 'Reply', exact: true }).click()
            await pane.getByRole('button', { name: 'Cancel mail reply' }).waitFor()
            await textarea.fill('Reply draft to retain.')
          }
          await textarea.press('End')
          const row = pane.locator('[data-row-key="quote-2"]')
          if (width < 520) {
            await row.getByRole('button', { name: 'Message actions' }).focus()
            await page.keyboard.press('Enter')
            const quote = page.getByRole('menuitem', { name: 'Add to chat', exact: true })
            await quote.waitFor()
            if (activation === 'keyboard') {
              await page.keyboard.press('ArrowDown')
              await quote.press('Enter')
            } else if (compact) await quote.tap()
            else await quote.click()
          } else {
            const quote = row.getByRole('button', { name: 'Add to chat', exact: true })
            if (activation === 'keyboard') {
              await quote.focus()
              await quote.press('Enter')
            } else await quote.click()
          }
          await page.getByRole('menu').waitFor({ state: 'detached' })
          // Observe after close animation and focus cleanup, not just the first
          // synchronous textarea focus (the inherited failure briefly did that).
          await page.waitForTimeout(250)
          const focused = await textarea.evaluate((node) => node === document.activeElement)
          const inserted = (await textarea.inputValue()).includes('❝')
          const trace = await page.evaluate(() => Reflect.get(window, 'messageFocusTrace'))
          let passed = focused && inserted
          let routing: unknown = null
          if (focused) {
            await page.keyboard.type(' Typed after quote.')
            assert.match(await textarea.inputValue(), /Typed after quote\.$/)
            if (activation === 'keyboard') {
              await pane.screenshot({
                path: `${out}/quote-${reply ? 'reply' : 'prompt'}-${width}-${theme}.png`,
              })
            }
            // Focus already given to the composer must survive either layout.
            for (const resized of width < 520 ? [720, width] : [400, 720]) {
              await pane.evaluate((node, next) => {
                node.style.width = `${next}px`
              }, resized)
              await page.waitForTimeout(80)
              assert.equal(await textarea.evaluate((node) => node === document.activeElement), true)
            }
            await pane
              .getByRole('button', { name: reply ? 'Send reply' : 'Send', exact: true })
              .click()
            await page.waitForFunction((isReply) => {
              const read = Reflect.get(window, 'mailReplyHarness').read()
              return (isReply ? read.mail : read.prompts).length === 1
            }, reply)
            const read = await page.evaluate(() => Reflect.get(window, 'mailReplyHarness').read())
            const sent = reply ? read.mail[0].body : read.prompts[0]
            assert.equal(sent.split(source).length - 1, 1)
            assert.match(sent, /Typed after quote\./)
            assert.equal(read.mail.length, reply ? 1 : 0)
            assert.equal(read.prompts.length, reply ? 0 : 1)
            if (reply) {
              assert.equal(read.mail[0].id, 'msg_ask')
              assert.equal(read.normalDraft, 'Normal draft to retain.')
            }
            routing = read
          }
          const overflow = await pane.evaluate((node) => node.scrollWidth - node.clientWidth)
          passed &&= errors.length === 0 && overflow === 0
          if (!passed) failures++
          const record = {
            theme,
            width,
            compact,
            reply,
            activation: compact && activation === 'pointer' ? 'touch' : activation,
            fonts,
            focused,
            inserted,
            passed,
            errors,
            overflow,
            trace,
            routing,
          }
          records.push(record)
          console.log(JSON.stringify(record))
          await page.close()
        }
      }
    }
  }
} finally {
  await writeFile(`${out}/message-quote-focus.json`, `${JSON.stringify(records, null, 2)}\n`)
  await browser.close()
}
assert.equal(
  failures,
  0,
  `${failures} quote focus cases failed; see ${out}/message-quote-focus.json`,
)
