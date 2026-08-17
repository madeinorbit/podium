/**
 * SHOOT THE COLD-START COMPOSER'S ATTACH AFFORDANCE (POD-1203).
 *
 * Drives harness/coldstart-entry.tsx, which renders the SHIPPING composer
 * against the SHIPPING stylesheet with only the store stubbed.
 *
 * Each shot is an assertion as well as a picture: the run FAILS if the thing it
 * claims to show is not on screen, so a broken build cannot quietly produce
 * three plausible screenshots of nothing.
 *
 *   bunx vite --config vite.coldstart.config.ts   # in apps/web
 *   bunx tsx apps/web/e2e/pod1203-coldstart-shots.ts
 */
import { chromium } from 'playwright'

const URL_ = 'http://localhost:55598/coldstart-harness.html'
const OUT = 'docs/shots'

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 } })
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(URL_, { waitUntil: 'networkidle' })
  await page.waitForSelector('textarea')

  const box = page.locator('.cold-start-body')

  // 1 — the affordance at rest. The clip has to be visible without hovering:
  // an attach button nobody can see is the bug this issue is about.
  await page.getByRole('button', { name: 'Attach a file' }).waitFor({ state: 'visible' })
  await box.screenshot({ path: `${OUT}/pod1203-1-attach-button.png` })

  // 2 — a screenshot and a document attached together, both chips ready. The
  // document is the half that did not exist before this issue.
  await page.fill('textarea', 'Make the empty state match this mock, using the spec attached.')
  await page.setInputFiles('input[type=file]', [
    { name: 'empty-state.png', mimeType: 'image/png', buffer: pngBytes() },
    { name: 'onboarding-spec.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
  ])
  await page.waitForFunction(() => !document.body.textContent?.includes('Uploading'), undefined, {
    timeout: 15_000,
  })
  for (const name of ['empty-state.png', 'onboarding-spec.pdf']) {
    if (!(await page.getByText(name).count())) throw new Error(`no chip for ${name}`)
  }
  await box.screenshot({ path: `${OUT}/pod1203-2-attached.png` })

  // 3 — the drop target. A dragover with a file item is what the composer keys
  // its overlay off, so the event has to carry one.
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'dropped.png', { type: 'image/png' }))
    document
      .querySelector('textarea')
      ?.closest('div.relative')
      ?.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }))
  })
  await page.getByText('Drop files to attach').waitFor({ state: 'visible' })
  await box.screenshot({ path: `${OUT}/pod1203-3-drop-target.png` })

  // 4 — the same box with chips in it on a SHORT pane. The strip adds height
  // below a field that is already shrinking to fit, and POD-1184's rule is that
  // the deck's top must stay reachable by scrolling — a chip row that pushed the
  // headline out of the scroller's start edge would undo that fix silently.
  await page.setViewportSize({ width: 1200, height: 300 })
  await page.waitForTimeout(300)
  const reach = await page.evaluate(() => {
    const deck = document.querySelector('.cold-start') as HTMLElement
    const body = document.querySelector('.cold-start-body') as HTMLElement
    return { deck: deck.getBoundingClientRect().top, body: body.getBoundingClientRect().top }
  })
  if (reach.body < reach.deck - 1) throw new Error('deck top is out of scroll reach with chips')
  await page.screenshot({ path: `${OUT}/pod1203-4-short-pane.png` })

  await browser.close()
  if (errs.length) throw new Error(`page errors: ${errs.join(' | ')}`)
  console.log('4 shots written to', OUT)
}

/** The smallest valid PNG, so the chip renders a real thumbnail. */
function pngBytes(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
}

await main()
