/**
 * Runtime capture for the POD-635 audit follow-through.
 *
 * Descends from `.artifacts/POD-641/capture-task-detail.mjs`, which shot the
 * first pass (typography, rhythm, dossier). This one shoots the remainder —
 * header/rail duplication, colour restraint, the composer at rest — so it
 * carries a SECOND task alongside the busy one: the audit asks for a sparse
 * page to prove the calmer page does not read as empty.
 *
 * Usage: bun .artifacts/POD-635/capture-task-detail.mjs [label]
 * Requires a dev server on 127.0.0.1:4318 built from THIS worktree.
 */
import { chromium } from '@playwright/test'

const ORIGIN = 'http://127.0.0.1:4318'
const LABEL = process.argv[2] ?? 'before'

/** The two review scenes the audit names: a busy multi-agent task and a quiet one. */
const SCENES = [
  // POD-628: two agents, one waiting on the human, a live worktree — the scene
  // where the header's live band and the rail's Branch section can duplicate.
  { name: 'busy', issue: 'iss_0081eb88-6dcf-44bc-a262-a472381e1dba' },
  // POD-636: one session waiting on the operator, no branch — the scene that
  // proves a calmer page does not read as an empty one.
  { name: 'quiet', issue: 'iss_0ce89ff4-321a-4501-b4d1-b9c2e9ae68eb' },
  // POD-641: closed, every session finished — nothing is live, so the Now block
  // should have collapsed to one line.
  { name: 'settled', issue: 'iss_cac76cc0-afed-447f-8425-c1095c4c695f' },
  // POD-497: the only scene with a filled long-form field, so the only one that
  // shows an authored section heading against the prose beneath it.
  { name: 'authored', issue: 'iss_ed8fa1b2-e9e4-47b9-b832-051fb52cd60a' },
]

const auth = Bun.spawnSync(['podium', 'auth', 'mint-session', '--print-only', '--ttl', '15m'])
if (auth.exitCode !== 0) throw new Error(new TextDecoder().decode(auth.stderr))
const token = new TextDecoder().decode(auth.stdout).trim()

const browser = await chromium.launch({ headless: true })

/** One scene at one viewport: screenshots plus the computed values under review. */
async function shoot(scene, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  await context.addCookies([{ name: 'podium_session', value: token, url: ORIGIN }])
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/issues/${scene.issue}?e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="issue-page"]', { timeout: 60_000 })
  await page.waitForTimeout(1800)

  const metrics = await page.evaluate(() => {
    const measure = (element) => {
      if (!(element instanceof HTMLElement)) return null
      const style = getComputedStyle(element)
      return {
        width: Math.round(element.getBoundingClientRect().width),
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        background: style.backgroundColor,
      }
    }

    // Every machine-voice label on the page must agree on one size.
    const machineLabels = [...document.querySelectorAll('span, h3')]
      .filter((el) => getComputedStyle(el).textTransform === 'uppercase')
      .filter((el) => getComputedStyle(el).fontFamily.toLowerCase().includes('mono'))
      .map((el) => ({ text: el.textContent?.trim().slice(0, 22), size: getComputedStyle(el).fontSize }))

    // The colour census the audit's "fewer visual voices" item is about: every
    // distinct non-neutral text colour actually painted on the document column.
    const scroller = document.querySelector('[data-testid="issue-page"]')
    const voices = {}
    for (const el of scroller?.querySelectorAll('*') ?? []) {
      if (!el.textContent?.trim()) continue
      const color = getComputedStyle(el).color
      const [r, g, b] = color.match(/\d+/g)?.map(Number) ?? []
      if (r === undefined) continue
      const spread = Math.max(r, g, b) - Math.min(r, g, b)
      if (spread < 26) continue // neutral ink
      voices[color] = (voices[color] ?? 0) + 1
    }

    return {
      header: {
        gitStamp: Boolean(document.querySelector('header [data-testid="git-stamp"]')),
        text: document.querySelector('header')?.textContent?.trim().replace(/\s+/g, ' '),
      },
      aside: measure(document.querySelector('[data-testid="issue-aside"]')),
      now: measure(document.querySelector('[data-testid="issue-now"]')),
      nowRows: document.querySelector('[data-testid="issue-now"]')?.querySelectorAll('button').length,
      status: document.querySelector('[data-testid="status-strip"]')?.textContent?.trim(),
      composer: measure(document.querySelector('textarea[aria-label="Add a comment"]')),
      machineLabels,
      voices,
      docScrollWidth: document.documentElement.scrollWidth,
    }
  })

  const cdp = await context.newCDPSession(page)
  const capture = async (path) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await Bun.write(path, Buffer.from(shot.data, 'base64'))
  }
  await capture(`.artifacts/POD-635/${LABEL}-${scene.name}-top.png`)

  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="issue-page"]')
    const scroller = [...(root?.querySelectorAll('div') ?? [])].find(
      (element) => getComputedStyle(element).overflowY === 'auto',
    )
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight
  })
  await page.waitForTimeout(600)
  await capture(`.artifacts/POD-635/${LABEL}-${scene.name}-activity.png`)

  await context.close()
  return metrics
}

const out = {}
for (const scene of SCENES) out[scene.name] = await shoot(scene, 1976, 1232)
// Just above the rail's md breakpoint, where the document column is narrowest
// and the wider measure has the least room to give.
out.narrow = await shoot({ ...SCENES[0], name: 'narrow' }, 820, 1100)
await Bun.write(`.artifacts/POD-635/${LABEL}.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
await browser.close()
