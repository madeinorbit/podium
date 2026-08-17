/**
 * DOES THE UNROLL ACTUALLY ANIMATE, IN THE ENGINE THAT MATTERS (POD-1158)?
 *
 * The arrival's keyframe animates `height` and the block padding to a measured
 * pixel value, deliberately rather than through `0fr`/`1fr` or
 * `interpolate-size`, both of which say it far more neatly and both of which
 * are recent enough in WebKit that this feed — the one with POD-1160 open
 * against it — is the wrong place to find out. This asserts the choice rather
 * than trusting it: same markup, same real rule, sampled mid-flight in both
 * engines.
 *
 * It also checks the two things that would bite later: that the row is NOT left
 * clipped once the animation ends (a persisted `overflow: hidden` would trap
 * the per-message hover actions), and that reduced motion resolves straight to
 * the resting height with no intermediate frame.
 *
 *   bunx tsx apps/web/e2e/pod1158-unroll-engine.ts
 */
import { chromium, webkit } from 'playwright'

const CSS = `
  * { box-sizing: border-box; }          /* as Tailwind preflight sets it */
  .feed { height: 240px; overflow-y: auto; }
  .transcript-row { display: flex; padding-top: 11px; padding-bottom: 11px; }
  @media (prefers-reduced-motion: no-preference) {
    .transcript-row[data-unroll] {
      box-sizing: border-box;
      overflow: hidden;
      animation: transcript-unroll 260ms cubic-bezier(0.4, 0, 0.2, 1);
    }
  }
  @keyframes transcript-unroll {
    from { height: 0; padding-top: 0; padding-bottom: 0; opacity: 0.6; }
    to   { height: var(--arrive-h); padding-top: 11px; padding-bottom: 11px; opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .transcript-row[data-unroll] { overflow: visible; animation: none; }
  }
`

const PAGE = `<style>${CSS}</style>
  <div class="feed" id="feed">
    <div class="transcript-row"><div>a settled row</div></div>
  </div>`

/** Insert a row the way TranscriptFeed does: measure, stamp, let CSS run it. */
const LAND = `() => {
  const feed = document.getElementById('feed')
  const row = document.createElement('div')
  row.className = 'transcript-row'
  row.innerHTML = '<div>a message that just landed, long enough to wrap onto a second line in this box</div>'
  feed.appendChild(row)
  const rest = row.offsetHeight
  row.style.setProperty('--arrive-h', rest + 'px')
  row.dataset.unroll = ''
  row.id = 'landed'
  // Mirrors useArrivalUnroll: the clip and the custom property come OFF once
  // the row is simply a row, so nothing is left holding a containing block.
  row.addEventListener('animationend', function done(e) {
    if (e.target !== row || e.animationName !== 'transcript-unroll') return
    row.removeEventListener('animationend', done)
    delete row.dataset.unroll
    row.style.removeProperty('--arrive-h')
  })
  return rest
}`

const SAMPLE = `() => {
  const row = document.getElementById('landed')
  const cs = getComputedStyle(row)
  return { h: row.offsetHeight, css: parseFloat(cs.height), pad: parseFloat(cs.paddingTop), overflow: cs.overflow, unroll: row.hasAttribute('data-unroll') }
}`

async function run(name: string, launch: typeof chromium, reduced: boolean): Promise<void> {
  const browser = await launch.launch()
  const page = await browser.newPage({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
  await page.setContent(PAGE)
  const rest = (await page.evaluate(`(${LAND})()`)) as number
  const samples: number[] = []
  for (let i = 0; i < 5; i++) {
    const s = (await page.evaluate(`(${SAMPLE})()`)) as { h: number }
    samples.push(Math.round(s.h))
    await page.waitForTimeout(55)
  }
  await page.waitForTimeout(400)
  const settled = (await page.evaluate(`(${SAMPLE})()`)) as {
    h: number
    pad: number
    overflow: string
    unroll: boolean
  }
  const label = `${name}${reduced ? ' (reduced)' : ''}`.padEnd(20)
  // Animated means: it started well short of rest, and was caught somewhere in
  // between — not merely that it ended in the right place.
  const first = samples[0] ?? rest
  const moved = first < rest - 4 && samples.some((h) => h > first && h <= rest)
  const overshot = samples.some((h) => h > rest + 1)
  console.log(
    `${label} rest=${rest}px  heights=${samples.join(' → ')}  ` +
      `settled=${Math.round(settled.h)}px pad=${settled.pad} overflow=${settled.overflow}  ` +
      `${
        reduced
          ? samples.every((h) => h === rest)
            ? 'INSTANT ✓'
            : 'MOVED UNDER REDUCE ✗'
          : overshot
            ? 'OVERSHOT ✗'
            : moved
              ? 'ANIMATED ✓'
              : 'DID NOT ANIMATE ✗'
      }`,
  )
  await browser.close()
}

await run('chromium', chromium, false)
await run('webkit', webkit, false)
await run('chromium', chromium, true)
await run('webkit', webkit, true)
