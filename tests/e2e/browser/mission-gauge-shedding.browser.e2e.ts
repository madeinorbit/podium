import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * THE GAUGE MUST SHED, NEVER CLIP (POD-710 / POD-725).
 *
 * The mission gauge writes words INSIDE a meter — `4 DONE`, `2 RUNNING` — and the
 * deck column it lives in is resizable from 300px, so a band running out of room
 * is routine rather than an edge case. Its answer is a ladder of `@container`
 * queries that shed the noun, then the digits, then down to bare material. The
 * whole premise is that nothing is ever cut off mid-word.
 *
 * That premise is invisible to unit tests. The rungs are container queries
 * resolved against a band's inline size, and the thing they are calibrated
 * against is the TEXT'S OWN MEASURE at 9px Geist Mono — so the failure mode is a
 * band revealing a word one step longer than it has room for, which needs a real
 * engine, real fonts, real `scrollWidth`. happy-dom has none of those.
 *
 * WHAT THIS ASSERTS IS THE INVARIANT, not the numbers: at every deck width the
 * column can take, nothing a rung has revealed exceeds the band containing it.
 * Deliberately NOT "done's word appears at 52px" — that would fail the next time
 * someone legitimately changes the font, the padding or a threshold, which is
 * noise rather than a regression. The rungs may move; the promise may not.
 *
 * Prior art on why it exists: POD-725 remetered the gauge's track while bringing
 * the paper shell over, and the only record that the rungs had been re-checked
 * was a pair of agent mails. The next person to touch the track should get a red
 * test instead of a question to rediscover.
 */

/** The deck column's real range — AppShell's ResizableColumn min/max. */
const DECK_MIN = 300
const DECK_MAX = 620

/** The class names the fixture below stands in for. Asserted against the real
 *  component so this test fails loudly if the markup is renamed out from under
 *  it, rather than quietly measuring a fixture nothing renders any more. */
const GAUGE_CLASSES = ['gauge-band', 'gauge-band-text', 'gauge-band-count', 'gauge-band-word']

test.skip(({ isMobile }) => isMobile, 'the flight deck is a desktop column')

test('the mission gauge sheds its words rather than clipping them, at every deck width', async ({
  page,
}) => {
  // Guard against the fixture drifting away from the component it models.
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../apps/web/src/app/MissionGauge.tsx'),
    'utf8',
  )
  for (const cls of GAUGE_CLASSES) {
    expect(source, `MissionGauge.tsx no longer renders .${cls} — update this fixture`).toContain(
      cls,
    )
  }

  await page.goto(`/?server=${RELAY}&e2e=1`)
  await expect(page.getByTestId('desktop-topbar')).toBeVisible({ timeout: 45_000 })

  // The rungs are calibrated to Geist Mono's measure. Measuring against a
  // fallback face would give confident, meaningless numbers.
  const monoReady = await page.evaluate(async () => {
    await document.fonts.load('9px "Geist Mono Variable"')
    await document.fonts.ready
    return document.fonts.check('9px "Geist Mono Variable"')
  })
  expect(monoReady, 'Geist Mono must be loaded before measuring the rungs').toBe(true)

  const result = await page.evaluate(
    ({ min, max }) => {
      // The worst case the component can render: every state at once, so the
      // bands are as crowded as they can get. Counts are the flex-grow weights,
      // exactly as MissionGauge sizes them.
      const SHAPE = [
        { s: 'done', word: 'done', count: 4 },
        { s: 'run', word: 'running', count: 2 },
        { s: 'block', word: 'blocked', count: 1 },
        { s: 'wait', word: 'to go', count: 12 },
      ]
      // And the other end: one band takes the whole track, so it is the count
      // rung rather than the word rung that does the work — with three digits,
      // the widest the count can be.
      const SOLO = [{ s: 'run', word: 'running', count: 128 }]

      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:-4000px;top:0'
      document.body.appendChild(host)

      const build = (shape: typeof SHAPE) => {
        const track = document.createElement('span')
        // The track's own geometry does not calibrate anything (see the docblock
        // — height is not an inline axis), but the padding and gap do share out
        // inline space, so they are modelled as the component sets them.
        track.style.cssText =
          'display:flex;align-items:center;gap:2px;height:24px;padding:2px;overflow:hidden;min-width:0'
        for (const b of shape) {
          const band = document.createElement('span')
          band.className = b.s === 'block' ? 'gauge-band gauge-hatch' : 'gauge-band'
          band.dataset.s = b.s
          band.style.flexGrow = String(b.count)
          const text = document.createElement('span')
          text.className = 'gauge-band-text'
          const count = document.createElement('b')
          count.className = 'gauge-band-count'
          count.dataset.w = String(Math.min(3, String(b.count).length))
          count.textContent = String(b.count)
          const word = document.createElement('span')
          word.className = 'gauge-band-word'
          word.textContent = ` ${b.word}`
          text.append(count, word)
          band.append(text)
          track.append(band)
        }
        host.append(track)
        return track
      }

      const sweep = (track: HTMLElement, label: string) => {
        const clipped: string[] = []
        let samples = 0
        for (let deck = min; deck <= max; deck += 2) {
          // The track is the deck minus the column gutters and the fleet chip
          // beside it; 112px is that overhead measured at the column's minimum.
          track.style.width = `${deck - 112}px`
          track.getBoundingClientRect()
          for (const band of Array.from(track.children) as HTMLElement[]) {
            const text = band.querySelector('.gauge-band-text') as HTMLElement
            const count = band.querySelector('.gauge-band-count') as HTMLElement
            const word = band.querySelector('.gauge-band-word') as HTMLElement
            const revealed =
              getComputedStyle(count).display !== 'none' ||
              getComputedStyle(word).display !== 'none'
            samples += 1
            if (!revealed) continue
            const overflow = text.scrollWidth - band.clientWidth
            if (overflow > 0)
              clipped.push(
                `${label}/${band.dataset.s} deck=${deck} band=${Math.round(
                  band.clientWidth,
                )}px clipped by ${overflow}px`,
              )
          }
        }
        return { clipped, samples }
      }

      const crowded = sweep(build(SHAPE), 'four-band')
      const solo = sweep(build(SOLO), 'solo-3-digit')
      host.remove()
      return {
        clipped: [...crowded.clipped, ...solo.clipped],
        samples: crowded.samples + solo.samples,
      }
    },
    { min: DECK_MIN, max: DECK_MAX },
  )

  // A sweep that measured nothing would pass vacuously.
  expect(result.samples).toBeGreaterThan(400)
  expect(result.clipped, 'revealed gauge text must never exceed its band').toEqual([])
})
