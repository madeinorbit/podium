/**
 * FIND THE BRIEF THAT OSCILLATES (POD-1192).
 *
 * The operator reports the pinned-brief shelf flickering "if they have certain
 * lengths that trigger a read more show/hide loop". This bug has been fixed
 * twice already, for two different real causes, which is what happens when a
 * boundary case is reasoned about instead of swept.
 *
 * So sweep it, with everything the shelf actually has:
 *   - the shipping CSS for `.brief-shelf*` AND the `.chat-md` rules under it,
 *     including `p { margin: 0.85em 0 }`, which is why `scrollHeight` is not a
 *     whole number of line boxes while the clamp is;
 *   - the shipping FONT. Geist is a variable font, and `text-wrap: pretty` is a
 *     multi-pass line breaker; measuring this in system-ui is not measuring it;
 *   - both densities, because `html[data-density="compact"] .chat-md` (0,2,1)
 *     OUTRANKS `.brief-shelf-text.chat-md` (0,2,0), so compact really does set
 *     the shelf to 13px/21px and moves the boundary;
 *   - real markdown bodies — one paragraph, two, and a list — not a run of text;
 *   - shut and open, with classic space-taking scrollbars forced.
 *
 * At each combination it lets the ResizeObserver settle and counts how many
 * times `clipped` changes its mind WITH NO INPUT AT ALL. Once is the answer
 * settling. More than once is the bug, and the body that does it is printed.
 *
 *   bunx tsx apps/web/e2e/pod1192-shelf-flicker.ts
 */
import { readFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'

const FONT_DIR = '/home/podium/podium/node_modules/@fontsource-variable/geist/files'
const GEIST = readFileSync(`${FONT_DIR}/geist-latin-wght-normal.woff2`).toString('base64')

/** Lifted from styles.css. Kept literal so drift shows up as this going quiet. */
const CSS = `
  @font-face { font-family: 'Geist Variable'; src: url(data:font/woff2;base64,${GEIST}) format('woff2'); font-weight: 100 900; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Geist Variable', system-ui, sans-serif; }

  /* .chat-md, as the shelf inherits it */
  .chat-md { font-size: 13.5px; line-height: 23px; }
  html[data-density="compact"] .chat-md { font-size: 13px; line-height: 21px; }
  .chat-md > :first-child { margin-top: 0; }
  .chat-md > :last-child { margin-bottom: 0; }
  .chat-md p { margin: 0.85em 0; }
  .chat-md ul { margin: 0.85em 0; padding-left: 1.2em; }

  .brief-shelf {
    display: flex; gap: 14px; align-items: flex-start;
    padding: 11px 14px 12px;
    border: 1px solid #3a3f48; border-radius: 13px; background: #23262d; color: #d7dae0;
  }
  .brief-shelf-text.chat-md {
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
  .brief-shelf[data-open="true"] .brief-shelf-text { overflow-y: auto; -webkit-mask-image: none; mask-image: none; }
  .brief-shelf-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 7px; padding-top: 1px; }
  .brief-shelf-time, .brief-shelf-toggle {
    font-family: ui-monospace, monospace; font-size: 10.5px; line-height: 1;
  }
  .brief-shelf-toggle { letter-spacing: 0.08em; text-transform: uppercase; }
  .brief-shelf-toggle[data-idle="true"] { visibility: hidden; pointer-events: none; }
  /* POSITIVE CONTROL. The loop POD-993 round 3 found and closed: taking the
     toggle OUT of the flow narrows the text, which adds a line, which is what
     "clipped" means, so the toggle comes back and widens it again. If the sweep
     cannot see this, its negative results mean nothing. */
  html[data-control="true"] .brief-shelf-toggle[data-idle="true"] { display: none; }
  .brief-shelf-text::-webkit-scrollbar { width: 15px; }
  .brief-shelf-text::-webkit-scrollbar-thumb { background: #555; }
`

const PAGE = `<style>${CSS}</style>
  <div class="brief-shelf" id="shelf" style="width:640px">
    <div class="chat-md brief-shelf-text" id="text"></div>
    <div class="brief-shelf-side">
      <span class="brief-shelf-time">14:02</span>
      <button class="brief-shelf-toggle" id="toggle" data-idle="true">Show full</button>
    </div>
  </div>`

/** The shipping measure and the shipping decision, driven the way PinnedBrief
 *  drives them, reporting how many times the answer changed unprompted. */
const SWEEP = `(html, openIt, width) => {
  const shelf = document.getElementById('shelf')
  const text = document.getElementById('text')
  const toggle = document.getElementById('toggle')
  const OPEN_MAX = 320

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
    const seen = []
    const apply = () => {
      const { content, clamp } = measure()
      const clipped = content > clamp + 1
      if (clipped !== last) {
        flips++
        last = clipped
        seen.push((clipped ? 'cut' : 'fit') + ' ' + content + '/' + clamp.toFixed(1))
      }
      if (clipped) shelf.setAttribute('data-clipped', 'true')
      else shelf.removeAttribute('data-clipped')
      if (clipped) toggle.removeAttribute('data-idle')
      else toggle.setAttribute('data-idle', 'true')
      if (shelf.getAttribute('data-open') === 'true') {
        text.style.maxHeight = Math.min(content, OPEN_MAX) + 'px'
      } else {
        text.style.maxHeight = ''
      }
    }
    shelf.style.width = width + 'px'
    text.innerHTML = html
    if (openIt) shelf.setAttribute('data-open', 'true')
    else shelf.removeAttribute('data-open')
    const ro = new ResizeObserver(apply)
    ro.observe(text)
    apply()
    setTimeout(() => {
      ro.disconnect()
      resolve({ flips, seen: seen.slice(0, 8) })
    }, 220)
  })
}`

const W = 'transcript '
/** Real markdown shapes, not a run of text: the paragraph margin is why
 *  `scrollHeight` stops being a whole number of line boxes. */
function bodies(n: number): { name: string; html: string }[] {
  const run = W.repeat(n) + 'x'.repeat(n % 5)
  const half = W.repeat(Math.max(1, Math.floor(n / 2)))
  return [
    { name: `p1(${n})`, html: `<p>${run}</p>` },
    { name: `p2(${n})`, html: `<p>${half}</p><p>${half}</p>` },
    { name: `ul(${n})`, html: `<p>${half}</p><ul><li>${half}</li></ul>` },
  ]
}

async function run(
  name: string,
  launch: typeof chromium,
  compact: boolean,
  control = false,
): Promise<void> {
  const browser = await launch.launch()
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.setContent(PAGE)
  if (compact) await page.evaluate(`document.documentElement.dataset.density = 'compact'`)
  if (control) await page.evaluate(`document.documentElement.dataset.control = 'true'`)
  await page.evaluate(`document.fonts.ready`)
  const bad: string[] = []
  let checked = 0
  for (let n = 2; n <= 14; n++) {
    for (const body of bodies(n)) {
      for (const width of [560, 620, 688]) {
        for (const openIt of [false, true]) {
          checked++
          const r = (await page.evaluate(
            `(${SWEEP})(${JSON.stringify(body.html)}, ${openIt}, ${width})`,
          )) as { flips: number; seen: string[] }
          if (r.flips > 1) {
            bad.push(
              `${body.name} w=${width} ${openIt ? 'OPEN' : 'shut'} flips=${r.flips} :: ${r.seen.join(' -> ')}`,
            )
          }
        }
      }
    }
  }
  const label = `${name}${compact ? ' compact' : ''}${control ? ' CONTROL' : ''}`.padEnd(22)
  console.log(`${label} ${checked} combinations, ${bad.length} oscillating`)
  for (const b of bad.slice(0, 12)) console.log(`   ${b}`)
  await browser.close()
}

// Control first: if these do not oscillate, the sweep is blind and the rest of
// the output is worthless.
await run('webkit', webkit, false, true)
await run('chromium', chromium, false, true)
await run('webkit', webkit, false)
await run('webkit', webkit, true)
await run('chromium', chromium, false)
await run('chromium', chromium, true)
