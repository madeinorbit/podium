/**
 * FIND THE LENGTHS THAT OSCILLATE (POD-1192).
 *
 * The operator reports the pinned-brief shelf flickering "if they have certain
 * lengths that trigger a read more show/hide loop". Two earlier rounds each
 * found a real loop and closed it, and the bug came back, which is what happens
 * when a boundary case is reasoned about instead of swept.
 *
 * So sweep it. This rebuilds the shelf out of the SHIPPING CSS and the shipping
 * measure logic, then walks the brief's length one word at a time across the
 * three-line boundary, and at each length lets the ResizeObserver settle while
 * counting how many times `clipped` changes its mind WITH NO INPUT AT ALL. A
 * stable length flips once (the initial measure) or not at all. A length that
 * flips repeatedly is the bug, and it prints the exact text that does it.
 *
 *   bunx tsx apps/web/e2e/pod1192-shelf-flicker.ts
 */
import { chromium, webkit } from 'playwright'

/** Lifted from styles.css — the rules that decide the answer. Kept literal so a
 *  divergence from the stylesheet shows up as this harness going quiet. */
const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  .brief-shelf {
    display: flex; gap: 14px; align-items: flex-start;
    width: 640px; padding: 11px 14px 12px;
    border: 1px solid #3a3f48; border-radius: 13px; background: #23262d; color: #d7dae0;
  }
  .brief-shelf-text {
    flex: 1; min-width: 0;
    --brief-lines: 3;
    max-height: calc(var(--brief-lines) * 1lh);
    overflow: hidden;
    font-size: 14.5px; line-height: 23px;
    text-wrap: pretty;
  }
  .brief-shelf[data-clipped="true"] .brief-shelf-text {
    -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc((var(--brief-lines) - 1) * 1lh), transparent 100%);
    mask-image: linear-gradient(to bottom, #000 0, #000 calc((var(--brief-lines) - 1) * 1lh), transparent 100%);
  }
  .brief-shelf-side {
    flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 7px; padding-top: 1px;
  }
  .brief-shelf-time { font-family: ui-monospace, monospace; font-size: 10.5px; line-height: 1; }
  .brief-shelf-toggle { font-family: ui-monospace, monospace; font-size: 10.5px; line-height: 1;
    letter-spacing: 0.08em; text-transform: uppercase; }
  .brief-shelf-toggle[data-idle="true"] { visibility: hidden; pointer-events: none; }
  /* Open: the inline max-height is written from the measurement, and the
     overflow is released. On classic (space-taking) scrollbars this is the
     shape hypothesis 1 is about. */
  .brief-shelf[data-open="true"] .brief-shelf-text { overflow-y: auto; -webkit-mask-image: none; mask-image: none; }
  /* Force classic scrollbars, which is what a macOS mouse user has. */
  .brief-shelf-text::-webkit-scrollbar { width: 15px; }
  .brief-shelf-text::-webkit-scrollbar-thumb { background: #555; }
`

const PAGE = `<style>${CSS}</style>
  <div class="brief-shelf" id="shelf">
    <div class="brief-shelf-text" id="text"></div>
    <div class="brief-shelf-side">
      <span class="brief-shelf-time">14:02</span>
      <button class="brief-shelf-toggle" id="toggle" data-idle="true">Show full</button>
    </div>
  </div>`

/** The shipping measure + the shipping decision, driven by a ResizeObserver the
 *  way PinnedBrief drives it. Returns how many times the answer changed. */
const SWEEP = `(words, openIt) => {
  const shelf = document.getElementById('shelf')
  const text = document.getElementById('text')
  const toggle = document.getElementById('toggle')

  const measure = () => {
    const style = getComputedStyle(text)
    const lineHeight = Number.parseFloat(style.lineHeight)
    const lines = Number.parseFloat(style.getPropertyValue('--brief-lines')) || 3
    return {
      content: text.scrollHeight,
      clamp: Number.isFinite(lineHeight) ? lineHeight * lines : text.clientHeight,
    }
  }

  return new Promise((resolve) => {
    let flips = 0
    let last = null
    let seen = []
    const OPEN_MAX = 320
    const apply = () => {
      const { content, clamp } = measure()
      const clipped = content > clamp + 1
      if (clipped !== last) {
        flips++
        last = clipped
        seen.push(content + '/' + Math.round(clamp))
      }
      // Exactly what PinnedBrief does with the answer.
      shelf.dataset.clipped = clipped ? 'true' : ''
      if (!clipped) shelf.removeAttribute('data-clipped')
      if (clipped) toggle.removeAttribute('data-idle')
      else toggle.dataset.idle = 'true'
      // ...and when OPEN, the height is written back from the measurement,
      // which is the step that can feed a scrollbar into the next measure.
      if (shelf.dataset.open === 'true') {
        text.style.maxHeight = Math.min(content, OPEN_MAX) + 'px'
      } else {
        text.style.maxHeight = ''
      }
    }
    const ro = new ResizeObserver(() => apply())
    text.textContent = words
    if (openIt) shelf.dataset.open = 'true'
    else shelf.removeAttribute('data-open')
    ro.observe(text)
    apply()
    // Let it settle. A stable length is done in a frame or two; an oscillator
    // keeps the observer firing for as long as anyone is watching.
    setTimeout(() => {
      ro.disconnect()
      resolve({ flips, seen: seen.slice(0, 8) })
    }, 400)
  })
}`

const WORD = 'transcript '
async function run(name: string, launch: typeof chromium): Promise<void> {
  const browser = await launch.launch()
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await page.setContent(PAGE)
  const bad: string[] = []
  // One character at a time through the region where three lines becomes four,
  // because the boundary is a wrap point and a whole word can step over it.
  const base = WORD.repeat(6)
  for (let extra = 0; extra <= 90; extra++) {
    const words = base + 'x'.repeat(extra % 7) + WORD.repeat(Math.floor(extra / 7))
    for (const openIt of [false, true]) {
      const r = (await page.evaluate(
        `(${SWEEP})(${JSON.stringify(words)}, ${openIt})`,
      )) as { flips: number; seen: string[] }
      if (r.flips > 1) {
        bad.push(
          `len=${words.length} ${openIt ? 'OPEN ' : 'shut '}flips=${r.flips} content/clamp=${r.seen.join(' ')}`,
        )
      }
    }
  }
  console.log(`${name.padEnd(9)} oscillating lengths: ${bad.length}`)
  for (const b of bad.slice(0, 10)) console.log(`   ${b}`)
  await browser.close()
}

await run('chromium', chromium)
await run('webkit', webkit)
