import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { newSession, openApp } from './_harness'

/**
 * POD-405 — REAL-CLICK VERIFICATION OF THE REFACTORED CHAT SURFACE.
 *
 * ChatView was 1,442 lines doing everything; it is now a shell over a chat
 * slice, a source hook, four lifecycle hooks and six components. The unit suites
 * cover each part; this covers what a unit suite structurally cannot see — the
 * parts wired to each other, in a browser, driven by a real mouse and keyboard:
 *
 *   - SEARCH, the scroll-to-match jump and the MINIMAP all key on the same
 *     ABSOLUTE row index. A shell that hands one of them the WINDOWED index
 *     instead is invisible to a test that renders a single component;
 *   - the MINIMAP measures real `[data-block]` offsets — with no layout it has
 *     nothing to render, so it can only be verified in a browser;
 *   - IMAGE PASTE crosses the clipboard, a FileReader and an upload mutation;
 *   - VOICE renders only where the Web Speech API exists.
 *
 * ONE SESSION, ONE TEST, DELIBERATELY. Spawning a keyecho pane is the expensive
 * step in this lane and the one that degrades under load; five flows against one
 * session is also the only arrangement that can catch the parts interfering with
 * each other, which is the failure a refactor of this size actually risks.
 *
 * The transcript is a seeded fixture bound through the daemon's real hook
 * ingest — the same mechanism `transcript-loading.browser.e2e.ts` uses, because
 * the harness runs the keyecho jig rather than a real `claude`, so there is no
 * organic transcript to search or map.
 */

test.skip(({ isMobile }) => isMobile, 'desktop chat surface (minimap + search header)')

// One case drives five interaction flows against a freshly spawned session —
// several seconds more than the lane's 30s default allows, and a timeout there
// would read as a product failure rather than a budget one.
test.describe.configure({ timeout: 180_000 })

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
const claudeSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const BUCKET = join(homedir(), '.claude', 'projects', claudeSlug(REPO_ROOT))
const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

/** Bind a keyecho Claude pane to a fixture through the daemon's real hook ingest. */
async function bindTranscript(sessionId: string, transcriptPath: string): Promise<void> {
  let baseUrl: string | undefined
  await expect
    .poll(async () => {
      const files = await readdir(HOOKS_DIR).catch(() => [])
      for (const file of files) {
        const settings = await readFile(join(HOOKS_DIR, file), 'utf8').catch(() => null)
        if (!settings) continue
        baseUrl = settings.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
        if (baseUrl) break
      }
      return baseUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)
  const hookUrl = baseUrl?.replace(/\/hooks\/[^/]+$/, `/hooks/${sessionId}`)
  if (!hookUrl) throw new Error('hook endpoint unavailable')
  const res = await fetch(hookUrl, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: basename(transcriptPath, '.jsonl'),
      transcript_path: transcriptPath,
      cwd: REPO_ROOT,
    }),
  })
  expect(res.ok).toBe(true)
}

const T = '2026-08-01T09:00:00.000Z'
const userRec = (uuid: string, text: string): string =>
  JSON.stringify({ type: 'user', uuid, timestamp: T, message: { role: 'user', content: text } })
const answerRec = (uuid: string, text: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: T,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  })

const TRANSCRIPT_ID = '55555555-5555-4555-8555-555555555555'

test.afterEach(async () => {
  await rm(BUCKET, { recursive: true, force: true }).catch(() => {})
})

test('send, search, minimap, voice and image-paste on the ported chat surface', async ({
  page,
}) => {
  // The mic renders only where the Web Speech API exists; headless Chromium has
  // no engine, so install a controllable stand-in BEFORE app code reads for it.
  // The browser CAPABILITY is faked here — the component is not mocked.
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = ''
      continuous = false
      interimResults = false
      onresult: ((e: unknown) => void) | null = null
      onerror: (() => void) | null = null
      onend: (() => void) | null = null
      start() {
        ;(window as unknown as { __voice?: FakeRecognition }).__voice = this
      }
      stop() {
        this.onend?.()
      }
    }
    ;(window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition
  })

  await page.setViewportSize({ width: 1280, height: 900 })

  // Long answers so the transcript actually scrolls: the minimap needs layout,
  // and the scroll-to-match jump needs somewhere to jump to.
  await mkdir(BUCKET, { recursive: true })
  await writeFile(
    join(BUCKET, `${TRANSCRIPT_ID}.jsonl`),
    `${[
      userRec('u-1', 'SLICE_PROMPT_ONE find the needle please'),
      answerRec('a-1', Array.from({ length: 20 }, (_, i) => `ANSWER_ONE_LINE_${i}`).join('\n\n')),
      userRec('u-2', 'SLICE_PROMPT_TWO unrelated haystack question'),
      answerRec('a-2', Array.from({ length: 20 }, (_, i) => `ANSWER_TWO_LINE_${i}`).join('\n\n')),
      userRec('u-3', 'SLICE_PROMPT_THREE the needle again'),
      answerRec('a-3', 'SLICE_ANSWER_THREE done'),
    ].join('\n')}\n`,
    'utf8',
  )

  await openApp(page)
  await newSession(page, 'Claude')
  const activeId = await page
    .locator('.flex.min-h-0 > div[data-session]:visible')
    .first()
    .getAttribute('data-session')
  expect(activeId).not.toBeNull()
  await bindTranscript(activeId as string, join(BUCKET, `${TRANSCRIPT_ID}.jsonl`))
  const chatMode = page.locator('[data-testid="mode-chat"]:visible')
  await expect(chatMode).toBeVisible({ timeout: 15_000 })
  await chatMode.click()

  // Presence, not visibility: the view opens pinned to the tail, and the sticky
  // operator-prompt hand-off deliberately hides prompts ABOVE the active one
  // (`visibility: hidden`), so an earlier prompt is mounted-but-not-visible by
  // design. Asserting visibility here would be asserting against the feature.
  const msg = (text: string) => page.locator('.chat-md').filter({ hasText: text })
  await expect(msg('SLICE_PROMPT_ONE find the needle please')).toHaveCount(1, { timeout: 30_000 })
  await expect(msg('SLICE_ANSWER_THREE done')).toBeVisible()

  // ---- 1. TRANSCRIPT SEARCH ------------------------------------------------
  const search = page.locator('input[placeholder="Search transcript…"]').locator('visible=true')
  await expect(search).toBeVisible()
  await search.fill('the needle')
  // The counter is the slice's search state: 1-based position over the total.
  const counter = page
    .getByText(/^\d+\/2$/)
    .locator('visible=true')
    .first()
  await expect(counter).toBeVisible({ timeout: 15_000 })
  await expect(counter).toHaveText('1/2')

  // Highlight and dimming come from the SAME derived state — what used to be
  // three independent computations inside one component. Asserted on the ROW
  // that carries the matched text rather than on a bare class selector: the
  // highlight is a `cn(...)` composition, and which of its outline utilities
  // survives tailwind-merge is a styling detail, not the behaviour.
  const rowFor = (text: string) => page.locator('.transcript-row').filter({ hasText: text }).first()
  await expect(rowFor('SLICE_PROMPT_ONE')).toHaveClass(/outline/)
  await expect(rowFor('SLICE_PROMPT_TWO')).toHaveClass(/opacity-35/)

  // Stepping the cursor moves the highlight to the OTHER match.
  await page.locator('button[title="Next match"]').locator('visible=true').click()
  await expect(counter).toHaveText('2/2')
  await expect(rowFor('SLICE_PROMPT_THREE')).toHaveClass(/outline/)
  await expect(rowFor('SLICE_PROMPT_ONE')).not.toHaveClass(/outline/)

  // Wrapping backwards returns to the first — the cursor is modular against the
  // same count the label prints.
  await page.locator('button[title="Previous match"]').locator('visible=true').click()
  await expect(counter).toHaveText('1/2')
  await expect(rowFor('SLICE_PROMPT_ONE')).toHaveClass(/outline/)

  await search.fill('')
  await expect(page.locator('.transcript-row.opacity-35')).toHaveCount(0)

  // ---- 2. MINIMAP ----------------------------------------------------------
  // Ticks are pointer-events-none colour guides; the TRACK is the scrub surface.
  const minimap = page
    .locator('[role="presentation"].cursor-pointer')
    .locator('visible=true')
    .first()
  await expect(minimap).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(async () => minimap.locator('div.absolute').count(), { timeout: 15_000 })
    .toBeGreaterThan(2)

  const scroller = page
    .locator('div.overflow-y-auto')
    .filter({ has: page.locator('.transcript-row') })
    .locator('visible=true')
    .first()
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)

  // A click near the top of the strip scrubs the transcript there: the ticks,
  // the viewport box and the scrub share one scroll coordinate space.
  const box = await minimap.boundingBox()
  expect(box).not.toBeNull()
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + 3)
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop), { timeout: 15_000 })
    .toBeLessThan(120)

  // ---- 3. SEND -------------------------------------------------------------
  const composer = page
    .locator('textarea[placeholder="Message the agent…"]')
    .locator('visible=true')
  await expect(composer).toBeVisible()
  // The draft is store state written through the actions seam, so wait for the
  // round-trip to land before submitting — pressing Enter against a value the
  // store has not seen yet would submit an empty draft.
  const marker = `SLICE_SEND_MARKER_${Date.now()}`
  await composer.fill(marker)
  await expect(composer).toHaveValue(marker)
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  const sentRow = page.locator('.transcript-row').filter({ hasText: marker })
  await expect(sentRow).toHaveCount(1, { timeout: 30_000 })
  await expect(sentRow).toContainText('You')

  // ---- 4. VOICE ------------------------------------------------------------
  // Scoped to THIS composer's action cluster: the superagent dock renders its
  // own ChatView with its own mic, and a page-wide `.first()` would dictate into
  // the wrong draft — and pass while doing it.
  const actions = composer.locator('xpath=..')
  const mic = actions.locator('button[title="Voice input"]')
  await expect(mic).toBeVisible()
  await mic.click()
  const stop = actions.locator('button[title="Stop voice input"]')
  await expect(stop).toBeVisible({ timeout: 15_000 })
  // A recognized phrase lands in the DRAFT through the same action typing uses —
  // voice is an input method, not a second write path.
  await page.evaluate(() => {
    const rec = (window as unknown as { __voice?: { onresult?: (e: unknown) => void } }).__voice
    rec?.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'dictated words' }], { isFinal: true })],
    })
  })
  await expect(composer).toHaveValue(/dictated words/, { timeout: 15_000 })
  await stop.click()
  await composer.fill('')
  await expect(composer).toHaveValue('')

  // ---- 5. IMAGE PASTE ------------------------------------------------------
  // A real paste event carrying a real image file, through the composer's own
  // handler — the path a screenshot takes on ⌘V.
  await composer.evaluate((node) => {
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const file = new File([bytes], 'pasted.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    node.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  })
  // The chip appears with its own upload state machine, naming the pasted file.
  const remove = page.locator('button[aria-label="Remove pasted.png"]')
  await expect(remove).toBeVisible({ timeout: 20_000 })
  // Removal is the only affordance the strip owns, and it clears the attachment.
  await remove.click()
  await expect(page.locator('button[aria-label="Remove pasted.png"]')).toHaveCount(0)
})
