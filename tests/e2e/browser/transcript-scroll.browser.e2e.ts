import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import type { ScrollSnapshot } from '../fixtures/transcript-scroll'

// The real production controller, in the smallest DOM that exercises compositor
// input + React commits + ResizeObserver. No operator sessions or live server
// state are used. Data/window retention has exact hook/controller unit coverage.
let fixtureDir: string
let fixtureScript: string

test.beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'podium-scroll-'))
  const output = join(fixtureDir, 'fixture.js')
  execFileSync(
    'bun',
    [fileURLToPath(new URL('../fixtures/build-transcript-scroll.ts', import.meta.url)), output],
    { stdio: 'pipe' },
  )
  fixtureScript = await readFile(output, 'utf8')
})
test.afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
})

const snapshot = (page: Page): Promise<ScrollSnapshot> =>
  page.evaluate(() => window.__transcriptScrollFixture.snapshot())

async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let previous = -1
        let frames = 0
        const tick = () => {
          const top = window.__transcriptScrollFixture.snapshot().top
          frames = Math.abs(top - previous) < 0.5 ? frames + 1 : 0
          previous = top
          if (frames >= 8) resolve()
          else requestAnimationFrame(tick)
        }
        tick()
      }),
  )
}

async function scrollBack(page: Page, input: 'wheel' | 'touch' | 'keyboard'): Promise<void> {
  const box = (await page.locator('[data-feed-scroller]').boundingBox())!
  const x = Math.round(box.x + box.width / 2)
  const y = Math.round(box.y + box.height / 2 - 80)
  if (input === 'touch') {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let step = 1; step <= 10; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y + step * 18 }],
      })
      await page.waitForTimeout(20)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  } else if (input === 'keyboard') {
    // Playwright cannot dispatch wheel or compositor drags to mobile WebKit.
    // Exercise its real keyboard/default-scroll path instead.
    await page.locator('[data-feed-scroller]').focus()
    await page.keyboard.press('PageUp')
  } else {
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, -280)
  }
  await expect.poll(async () => (await snapshot(page)).following).toBe(false)
  await settled(page)
}

async function openFixture(page: Page, viewport: string): Promise<void> {
  await page.route('**/transcript-scroll-fixture.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fixtureScript }),
  )
  await page.route(
    (url) => url.pathname === '/transcript-scroll-fixture',
    (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/transcript-scroll-fixture.js"></script>',
      }),
  )
  await page.goto(`/transcript-scroll-fixture?viewport=${viewport}`)
  await page.waitForFunction(() => Boolean(window.__transcriptScrollFixture))
  await settled(page)
}

async function changeRowHeights(
  page: Page,
  viewport: string,
  first: number,
  last?: number,
  pendingMovement = 0,
): Promise<{ top: number; maximum: number }> {
  return page.evaluate(
    ({ viewport, first, last, pendingMovement }) => {
      const scroller = document.querySelector<HTMLElement>('[data-feed-scroller]')!
      scroller.scrollTop += pendingMovement
      const size = (index: number, height: number) => {
        const row = scroller.querySelector<HTMLElement>(`[data-block="${index}"]`)!
        const content = viewport === 'phone' ? (row.firstElementChild as HTMLElement) : row
        content.style.height = `${height}px`
      }
      // The fixture starts with forty 72px rows. Mutate before scroll/resize
      // delivery to cover compositor input coalescing with a layout change.
      size(0, first)
      if (last !== undefined) size(39, last)
      return { top: scroller.scrollTop, maximum: scroller.scrollHeight - scroller.clientHeight }
    },
    { viewport, first, last, pendingMovement },
  )
}

const rowOffset = (page: Page, key: string): Promise<number> =>
  page.evaluate((key) => {
    const scroller = document.querySelector<HTMLElement>('[data-feed-scroller]')!
    const row = [...scroller.querySelectorAll<HTMLElement>('[data-row-key]')].find(
      (row) => row.dataset.rowKey === key,
    )!
    return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, key)

for (const viewport of ['desktop', 'phone']) {
  test(`${viewport}: reading stays anchored through live growth, asynchronous history and real scroll input`, async ({
    page,
    isMobile,
    browserName,
  }) => {
    await openFixture(page, viewport)
    await expect.poll(async () => (await snapshot(page)).gap).toBeLessThanOrEqual(2)
    const opened = await snapshot(page)
    const input = isMobile ? (browserName === 'chromium' ? 'touch' : 'keyboard') : 'wheel'

    await scrollBack(page, input)
    const reading = await snapshot(page)
    expect(reading.top).toBeLessThan(opened.top - 50)
    await page.evaluate(() => {
      window.__transcriptScrollFixture.append()
      window.__transcriptScrollFixture.growAbove()
    })
    await settled(page)
    const grown = await snapshot(page)
    expect(grown.following).toBe(false)
    expect(grown.key).toBe(reading.key)
    expect(Math.abs(grown.offset - reading.offset)).toBeLessThanOrEqual(1)
    await page.evaluate(() => window.__transcriptScrollFixture.reflowAboveAndBelow())
    await settled(page)
    const reflowed = await snapshot(page)
    expect(reflowed.key).toBe(reading.key)
    expect(Math.abs(reflowed.offset - reading.offset)).toBeLessThanOrEqual(1)

    await page.locator('[data-feed-scroller]').focus()
    await page.keyboard.press('End')
    await expect.poll(async () => (await snapshot(page)).following).toBe(true)

    // Home uses the browser's own keyboard routing. Its scroll requests history;
    // the loading-only commit is deliberately separated from the page commit.
    await page.locator('[data-feed-scroller]').focus()
    await page.keyboard.press('Home')
    await expect.poll(async () => (await snapshot(page)).loading).toBe(true)
    await settled(page)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await settled(page)
    const paging = await snapshot(page)
    await page.evaluate(() => window.__transcriptScrollFixture.completePage())
    await settled(page)
    const paged = await snapshot(page)
    expect(paged.key).toBe(paging.key)
    expect(Math.abs(paged.offset - paging.offset)).toBeLessThanOrEqual(1)
    expect(paged.top).toBeGreaterThan(paging.top + 500)
    expect(paged.following).toBe(false)

    // Observe successive frames as well as the final position: an oscillation
    // can have a correct final offset while still making the transcript unreadable.
    const offsets = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const values: number[] = []
          const tick = () =>
            requestAnimationFrame(() => {
              values.push(window.__transcriptScrollFixture.snapshot().top)
              if (values.length === 12) resolve(values)
              else tick()
            })
          tick()
        }),
    )
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1)

    await page.evaluate(() => window.__transcriptScrollFixture.search())
    await settled(page)
    expect((await snapshot(page)).following).toBe(false)
    await page.getByRole('button', { name: 'Jump to bottom' }).click()
    await page.evaluate(() => window.__transcriptScrollFixture.append())
    await expect.poll(async () => (await snapshot(page)).gap).toBeLessThanOrEqual(2)
    await scrollBack(page, input)
    const escaped = await snapshot(page)
    await page.evaluate(() => window.__transcriptScrollFixture.append())
    await settled(page)
    expect((await snapshot(page)).key).toBe(escaped.key)
    expect((await snapshot(page)).following).toBe(false)

    // A collapsed page can be shorter than the viewport. Upward input at its
    // top must request history even though the browser cannot change scrollTop.
    await page.evaluate(() => window.__transcriptScrollFixture.shortPage())
    await settled(page)
    await page.getByRole('button', { name: 'Jump to bottom' }).click()
    expect((await snapshot(page)).top).toBe(0)
    expect((await snapshot(page)).loading).toBe(false)
    await scrollBack(page, input)
    expect((await snapshot(page)).loading).toBe(true)
  })

  test(`${viewport}: shrinking the scroll range preserves reading and pending input`, async ({
    page,
    isMobile,
    browserName,
  }) => {
    const input = isMobile ? (browserName === 'chromium' ? 'touch' : 'keyboard') : 'wheel'
    for (const movement of [0, -100]) {
      await openFixture(page, viewport)
      await scrollBack(page, input)
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-feed-scroller]')!
        el.scrollTop = el.scrollHeight - el.clientHeight - 20
      })
      await settled(page)
      const before = await snapshot(page)
      expect(before.following).toBe(false)
      const immediate = await changeRowHeights(page, viewport, 22, undefined, movement)
      if (movement === 0) expect(Math.abs(immediate.top - immediate.maximum)).toBeLessThanOrEqual(1)
      else expect(immediate.top).toBeLessThan(immediate.maximum - 30)
      await settled(page)
      const after = await snapshot(page)
      expect(
        Math.abs((await rowOffset(page, before.key)) - before.offset + movement),
      ).toBeLessThanOrEqual(1)
      expect(Math.abs(after.top - (before.top + movement - 50))).toBeLessThanOrEqual(1)
      expect(after.following).toBe(false)
      expect(after.loading).toBe(false)
      // A later frame must not apply the same layout correction again.
      await settled(page)
      expect(Math.abs((await snapshot(page)).top - after.top)).toBeLessThanOrEqual(1)
    }
  })

  test(`${viewport}: fractional reflows stay bounded through rounded own scroll events`, async ({
    page,
    isMobile,
    browserName,
  }) => {
    const input = isMobile ? (browserName === 'chromium' ? 'touch' : 'keyboard') : 'wheel'
    for (const step of [0.4, -0.4]) {
      await openFixture(page, viewport)
      await scrollBack(page, input)
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-feed-scroller]')!
        el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2) + 13
      })
      await settled(page)
      const before = await snapshot(page)
      for (let index = 1; index <= 30; index++) {
        await changeRowHeights(page, viewport, 72 + index * step, 72 - index * step)
        await settled(page)
        await page.evaluate(() =>
          document
            .querySelector('[data-feed-scroller]')!
            .dispatchEvent(new Event('scroll', { bubbles: true })),
        )
        expect(Math.abs((await rowOffset(page, before.key)) - before.offset)).toBeLessThanOrEqual(1)
      }
      expect((await snapshot(page)).following).toBe(false)
      await page.evaluate(() => window.__transcriptScrollFixture.jump())
      await page.evaluate(() => window.__transcriptScrollFixture.append())
      await settled(page)
      expect((await snapshot(page)).following).toBe(true)
      expect((await snapshot(page)).gap).toBeLessThanOrEqual(1)
    }
  })
}
