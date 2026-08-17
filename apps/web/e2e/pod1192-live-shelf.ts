/**
 * HUNT THE FLICKER IN THE REAL SHELF (POD-1192).
 *
 * The isolated sweep (pod1192-shelf-flicker.ts) walked 91 brief lengths through
 * the shipping CSS and the shipping measure logic, shut and open, in both
 * engines, and found nothing. So the loop needs what that page did not have:
 * React's re-render, real markdown in the body, and the live layer the shelf is
 * drawn into. This drives the running app instead.
 *
 * THE TRICK IS TO SWEEP WIDTH, NOT LENGTH. The boundary is "does this brief
 * wrap to a fourth line", and the operator reaches it by writing a message of a
 * certain length. Narrowing the pane one pixel at a time walks the SAME
 * boundary without needing to author a message at all — the same sentence is
 * three lines wide and four lines narrow — and it does it against the real
 * component with the reader's own markdown in it.
 *
 * At each width it counts how many times the shelf changes its mind about
 * `data-clipped` / the toggle's `data-idle` WITH NO FURTHER INPUT. One change is
 * the answer settling. Repeated changes are the bug, and the width that does it
 * is a reproduction.
 *
 *   podium auth mint-session
 *   PODIUM_SESSION_COOKIE=… bunx tsx apps/web/e2e/pod1192-live-shelf.ts <worktree> <row-label>
 */
import { chromium, webkit } from 'playwright'

const [worktree, rowLabel] = process.argv.slice(2)
const ORIGIN = 'http://127.0.0.1:18787'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''

/** Watch the two attributes the answer drives, and report every change. */
const ARM = `() => {
  const shelf = document.querySelector('.brief-shelf')
  if (!shelf) return false
  const w = window
  w.__flick = { changes: [], armed: true }
  const toggle = shelf.querySelector('.brief-shelf-toggle')
  const read = () => (shelf.getAttribute('data-clipped') === 'true' ? 'clipped' : 'plain')
  w.__flick.last = read()
  w.__flickObs = new MutationObserver(() => {
    const now = read()
    if (now !== w.__flick.last) {
      w.__flick.last = now
      const text = shelf.querySelector('.brief-shelf-text')
      w.__flick.changes.push(now + '@' + (text ? text.scrollHeight : -1))
    }
  })
  w.__flickObs.observe(shelf, { attributes: true, subtree: true, attributeFilter: ['data-clipped', 'data-idle'] })
  return true
}`

const RESET = `() => { if (window.__flick) window.__flick.changes = [] }`
const READ = `() => (window.__flick ? window.__flick.changes : null)`

/** Scroll the feed until a brief takes the shelf. scrollTop writes work in
 *  WebKit even though pointer input does not (see POD-1160 / POD-1158). */
const PIN_A_BRIEF = `() => {
  const feed = document.querySelector('[data-feed-scroller]')
  if (!feed) return 'no feed'
  const prompts = feed.querySelectorAll('[data-operator-prompt="true"]')
  if (prompts.length === 0) return 'no operator prompts'
  // Put the LAST operator prompt just above the top edge, which is exactly the
  // condition syncStickyPromptPositions pins on.
  const last = prompts[prompts.length - 1]
  feed.scrollTop = last.offsetTop + last.offsetHeight + 40
  return 'scrolled ' + prompts.length + ' prompts'
}`

async function run(name: string, launch: typeof chromium): Promise<void> {
  const browser = await launch.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  if (COOKIE) {
    await ctx.addCookies([
      { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/', httpOnly: false, secure: false },
    ])
  }
  const page = await ctx.newPage()
  await page.goto(`${ORIGIN}/workspace?wt=${encodeURIComponent(worktree ?? '/home/podium/podium')}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForTimeout(3500)
  // A shelf needs a transcript that HAS operator prompts, and most agent
  // sessions on this board do not have one in the rendered window. So walk the
  // work rows until a feed with prompts turns up, rather than trusting a label.
  // Wait for the sidebar to render before asking it anything — querying at a
  // fixed delay is what produced "0 rows" and a meaningless clean sweep.
  let titles: string[] = []
  for (let i = 0; i < 40 && titles.length === 0; i++) {
    titles = (await page.evaluate(
      `Array.from(document.querySelectorAll('.shell-work-row-title')).map(e => e.textContent.trim())`,
    )) as string[]
    if (titles.length === 0) await page.waitForTimeout(500)
  }
  console.log(`${name}: ${titles.length} work rows`)
  const wanted = rowLabel ? [rowLabel, ...titles] : titles
  let ready = false
  for (const t of wanted.slice(0, 14)) {
    await page.evaluate((label: string) => {
      const el = Array.from(document.querySelectorAll('.shell-work-row-title')).find((n) =>
        (n.textContent ?? '').trim().includes(label),
      )
      if (!el) return
      const row = el.closest('[data-pressable], [role="button"], button, li') ?? el.parentElement
      ;(row ?? el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }, t)
    for (let i = 0; i < 12; i++) {
      const n = (await page.evaluate(
        `(() => { const f = document.querySelector('[data-feed-scroller]'); return f ? f.querySelectorAll('[data-operator-prompt="true"]').length : -1 })()`,
      )) as number
      if (n > 0) {
        console.log(`${name}: "${t}" has ${n} operator prompts`)
        ready = true
        break
      }
      await page.waitForTimeout(600)
    }
    if (ready) break
  }
  if (!ready) {
    console.log(`${name}: no transcript with operator prompts among ${titles.length} rows`)
    await page.screenshot({ path: `apps/web/e2e/pod1192-${name}-noprompts.png` })
    await browser.close()
    return
  }
  console.log(`${name}: ${await page.evaluate(`(${PIN_A_BRIEF})()`)}`)
  await page.waitForTimeout(1200)

  if (!(await page.evaluate(`(${ARM})()`))) {
    console.log(`${name}: no .brief-shelf on screen — nothing to sweep`)
    await page.screenshot({ path: `apps/web/e2e/pod1192-${name}-noshelf.png` })
    await browser.close()
    return
  }

  const bad: string[] = []
  for (let width = 1280; width >= 720; width -= 4) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(80)
    await page.evaluate(`(${RESET})()`)
    // Nothing touches the page from here — any change is the loop's own doing.
    await page.waitForTimeout(400)
    const changes = (await page.evaluate(`(${READ})()`)) as string[] | null
    if (changes && changes.length > 1) bad.push(`w=${width} changes=${changes.length} ${changes.slice(0, 6).join(' ')}`)
  }
  console.log(`${name.padEnd(9)} oscillating widths: ${bad.length}`)
  for (const b of bad.slice(0, 12)) console.log(`   ${b}`)
  await browser.close()
}

await run('webkit', webkit)
await run('chromium', chromium)
