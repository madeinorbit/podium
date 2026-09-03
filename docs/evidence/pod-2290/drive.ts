/**
 * The POD-2290 test drive, as a script (operator's rule: the agent that wrote a
 * UX fix drives it live before landing).
 *
 *   bun docs/evidence/pod-2290/drive.ts <out-dir>
 *
 * THE OPERATOR'S JOURNEY, NOT AN APPROXIMATION OF IT. It clicks "Choose agent
 * and repo" → "New OpenCode" and then looks at the panel, which is exactly what
 * the report describes ("opening an opencode or codex agent shows a terminal
 * pane stuck on Starting…"). Spawning over the API and navigating to the result
 * would skip the very transition the second round is about.
 *
 * Every shot is taken at a NAMED moment, because the bug was a moment rather
 * than a steady state:
 *
 *   <kind>-1-starting  ~1s after the click, while the harness is still coming
 *                      up — where the operator saw the dead terminal pane
 *   <kind>-2-live      once the session is up and answering — and, together
 *                      with the shot before it, the evidence about whether
 *                      anything moved under the user in between
 *
 * Run it against the `p2290` instance from drive-up.sh, under the machine's
 * `test:heavy` lock: a browser plus a server plus a daemon plus real agents is
 * a heavy gate by any reading, and flatblock is shared.
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'

const ORIGIN = 'http://127.0.0.1:19807'
const PASSWORD = 'p2290'
const OUT = process.argv[2] ?? '/tmp/pod-2290/shots'

/** The harnesses the report named, plus Claude as the control group: it is the
 *  PTY family, and "unchanged" is a claim this drive has to be able to check. */
const JOURNEYS = [
  { kind: 'opencode', button: 'New OpenCode' },
  { kind: 'codex', button: 'New Codex' },
  { kind: 'grok', button: 'New Grok' },
  { kind: 'claude', button: 'New Claude' },
] as const

async function dismissUpdateModal(page: Page): Promise<void> {
  // The updater's source-identity check fails against a worktree with
  // uncommitted work, which this one has by definition — it IS the fix being
  // driven. Dismiss rather than photograph (POD-2245 F2 is the same false
  // positive seen from the other side).
  const dismiss = page.getByRole('button', { name: /^Dismiss$/i }).first()
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {})
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })

  const login = await fetch(`${ORIGIN}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  if (!cookie) throw new Error('no session cookie from /auth/login')
  const [cookieName, cookieValue] = cookie.split('=') as [string, string]

  // TUNED FOR THIS HOST, not for taste: flatblock is a 6-CPU/11-GiB box shared
  // by the whole epic, and a default launch died with ERR_INSUFFICIENT_RESOURCES
  // and a crashed renderer under load.
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--renderer-process-limit=2',
      '--js-flags=--max-old-space-size=512',
    ],
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addCookies([
    { name: cookieName, value: cookieValue, url: ORIGIN, httpOnly: true, sameSite: 'Lax' },
  ])

  for (const journey of JOURNEYS) {
    // A FRESH PAGE PER JOURNEY. Panels are kept warm across a session switch by
    // design, and a warm panel has already resolved its view — which is the one
    // thing this drive must not inherit from the previous session.
    const page = await context.newPage()
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
      timeout: 90_000,
    })
    await page.waitForTimeout(2_500)
    await dismissUpdateModal(page)

    await page.getByRole('button', { name: /Choose agent and repo/i }).first().click()
    await page.waitForTimeout(2_000)
    // The chooser's rows are MENU ITEMS whose accessible name is the provider
    // plus the action ("OpenCodeNew OpenCode"), so match the action inside it
    // rather than asserting the whole label.
    await page.getByRole('menuitem', { name: new RegExp(journey.button, 'i') }).first().click()

    // The first look: about a second after the click, which is when a person
    // who just started an agent is looking at the pane.
    await page.waitForTimeout(1_200)
    await page.screenshot({ path: `${OUT}/${journey.kind}-1-starting.png`, animations: 'disabled' })

    // …and once it is up. `opencode serve` took ~7s to bind on this box and
    // grok ~5s, so 18s clears every measured launch with room to spare.
    await page.waitForTimeout(18_000)
    await page.screenshot({ path: `${OUT}/${journey.kind}-2-live.png`, animations: 'disabled' })
    console.log(`${journey.kind}: shot`)
    await page.close()
  }

  await browser.close()
  console.log(`shots in ${OUT}`)
}

await main()
