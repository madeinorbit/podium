import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { gotoWorkspace, newSession, openApp } from './_harness'

/**
 * Runtime proof of the transcript-loading re-architecture (Task G1).
 *
 * The original bug: for Claude Code sessions the chat transcript was unreliable —
 * (a) it didn't load at all for some RUNNING sessions, (b) it was missing the
 * newest messages, (c) it was missing old messages. The fix makes the on-disk
 * JSONL the source of truth, served by an opaque-cursor `sessions.transcriptRead`;
 * ChatView now READS the newest window off disk for ANY status, THEN subscribes to
 * live `transcriptDelta`s — so a live session renders its transcript even when the
 * hub yields no live delta.
 *
 * Why this works against the keyecho harness: the harness launches the keyecho jig
 * (not a real `claude`), so no real transcript JSONL exists. But the daemon resolves
 * a claude-code session's transcript purely from `cwd`: it reads
 *   <home>/.claude/projects/<slug(cwd)>/<*>.jsonl
 * (slug = cwd with every non-alphanumeric char → '-'; newest .jsonl in the bucket).
 * The harness registers THIS repo, so a `New Claude` session's cwd is the worktree
 * root with a deterministic, unique slug. We pre-seed a fixture JSONL there before
 * creating the session; `transcriptRead` (and the live tail) then read OUR fixture.
 * The bug is proven fixed when the chat view renders that fixture's items for a
 * RUNNING (status: live) session — i.e. NOT the "No transcript yet" empty state.
 *
 * Desktop only: drives a real mouse/DOM against the chat panel; the chat toggle and
 * transcript layout are the same on mobile but the harness flow (sidebar worktree →
 * New panel) is the desktop one the other specs use.
 */
test.skip(({ isMobile }) => isMobile, 'desktop chat-panel test (real DOM against ChatView)')

// The worktree root === the cwd of a harness `New Claude` session (serve-harness
// registers this repo; the active worktree path is the session cwd). Resolve it the
// same way serve-harness.ts does, from this spec's location (tests/e2e/browser/).
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
const claudeSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')
// The exact bucket the daemon reads for this cwd. Unique to this worktree path, so
// it never collides with the developer's real Claude project data. Always removed
// in afterEach so the test leaves no trace under the real ~/.claude.
const BUCKET = join(homedir(), '.claude', 'projects', claudeSlug(REPO_ROOT))
const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

/** Bind a keyecho Claude pane to a fixture through the daemon's real hook ingest.
 * Fresh keyecho sessions have no native resume id, so current transcript routing
 * correctly refuses to guess a cwd-only file until a hook supplies its path. */
async function bindTranscript(sessionId: string, transcriptPath: string): Promise<void> {
  let baseUrl: string | undefined
  await expect
    .poll(async () => {
      const files = await readdir(HOOKS_DIR).catch(() => [])
      for (const file of files) {
        // The hooks root may also contain per-session directories; only the
        // JSON settings files carry a callable hook URL.
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
      session_id: '44444444-4444-4444-8444-444444444444',
      transcript_path: transcriptPath,
      cwd: REPO_ROOT,
    }),
  })
  expect(res.ok).toBe(true)
}

// ---- Fixture transcript builders (real Claude Code JSONL record shapes) ----

/** A user-prompt record. */
function userRec(uuid: string, text: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: text },
  })
}
/** An assistant final-answer record (stop_reason end_turn → rendered as the answer). */
function answerRec(uuid: string, text: string, ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  })
}
/** Two adjacent tool calls + their paired results. They collapse into one chat
 * row, which is important for exercising block-index → row-index mapping. */
function toolUseRec(uuid: string, ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'sticky-tool-1', name: 'Read', input: { file_path: '/a.ts' } },
        { type: 'tool_use', id: 'sticky-tool-2', name: 'Grep', input: { pattern: 'needle' } },
      ],
    },
  })
}
function toolResultRec(uuid: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'sticky-tool-1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'sticky-tool-2', content: 'ok' },
      ],
    },
  })
}

/** Write a JSONL transcript into the daemon's cwd bucket. MUST end with a trailing
 *  newline — the reader drops a final newline-less line as a possible torn write. */
async function seedTranscript(uuid: string, lines: string[]): Promise<void> {
  await mkdir(BUCKET, { recursive: true })
  await writeFile(join(BUCKET, `${uuid}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
}

// The keep-mounted panel deck leaves earlier sessions' panels in the DOM (hidden via
// display:none) across the sequential tests in this file, so several chat/native
// toggles exist. Scope to the VISIBLE one — the active session's panel, which is the
// one newSession() just brought to front. `visible=true` excludes the display:none
// panels so the locator resolves to a single element.
const chatToggle = (page: Page) =>
  page.locator('button[aria-label="Switch to chat view"]').locator('visible=true')
const nativeToggle = (page: Page) =>
  page.locator('button[aria-label="Switch to native terminal"]').locator('visible=true')

test.afterEach(async () => {
  await rm(BUCKET, { recursive: true, force: true }).catch(() => {})
})

test('(a) a RUNNING claude session renders its on-disk transcript in the chat view', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  // Seed a small, deterministic transcript BEFORE the session exists, so the daemon
  // discovers it the moment the claude-code session spawns (and so the on-demand
  // transcriptRead reads it immediately).
  const t = '2026-06-20T10:00:00.000Z'
  await seedTranscript('11111111-1111-4111-8111-111111111111', [
    userRec('u-1', 'TRANSCRIPT_PROMPT_ALPHA please refactor the parser', t),
    answerRec('a-1', 'TRANSCRIPT_ANSWER_BRAVO done — extracted the cursor codec', t),
    userRec('u-2', 'TRANSCRIPT_PROMPT_CHARLIE now add a paging test', t),
    answerRec('a-2', 'TRANSCRIPT_ANSWER_DELTA added the anchored back-page read', t),
  ])

  await openApp(page)
  await newSession(page, 'Claude')

  // The session is RUNNING (the keyecho PTY is live) — confirm the chat toggle is
  // offered (chatCapable) and switch to the chat view.
  await expect(chatToggle(page)).toBeVisible({ timeout: 15_000 })
  await chatToggle(page).click()

  // PRIMARY ASSERTION: the live session's transcript renders. This is the core bug:
  // before the fix a running session could show "No transcript yet" / blank chat.
  // Scope to the chat message markdown (`.chat-md`) — the prompt text also appears
  // as the auto-derived session TITLE in sidebar buttons, so a bare getByText would
  // match those too. Matching the rendered transcript paragraph is the real proof.
  // Scope to VISIBLE chat markdown so the keep-mounted hidden panels from other tests
  // in this file never satisfy the assertion (markers are also unique per test).
  const msg = (text: string) =>
    page.locator('.chat-md').locator('visible=true').filter({ hasText: text })
  await expect(msg('TRANSCRIPT_PROMPT_ALPHA please refactor the parser')).toBeVisible({
    timeout: 15_000,
  })
  await expect(msg('TRANSCRIPT_ANSWER_BRAVO done — extracted the cursor codec')).toBeVisible()
  // Newest messages present too (the "missing the newest" half of the bug).
  await expect(msg('TRANSCRIPT_PROMPT_CHARLIE now add a paging test')).toBeVisible()
  await expect(msg('TRANSCRIPT_ANSWER_DELTA added the anchored back-page read')).toBeVisible()

  // And it is NOT the empty state (scope to the visible panel).
  await expect(
    page.getByText('No transcript yet.', { exact: false }).locator('visible=true'),
  ).toHaveCount(0)
})

test('operator prompts stick in place, push one another, and respect the appearance setting', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 700 })

  const t = '2026-06-20T11:00:00.000Z'
  const firstAnswer = Array.from(
    { length: 22 },
    (_, i) => `FIRST_ANSWER_LINE_${String(i).padStart(2, '0')} explanatory response text.`,
  ).join('\n\n')
  const secondAnswer = Array.from(
    { length: 22 },
    (_, i) => `SECOND_ANSWER_LINE_${String(i).padStart(2, '0')} explanatory response text.`,
  ).join('\n\n')
  await seedTranscript('44444444-4444-4444-8444-444444444444', [
    toolUseRec('tool-call-record', t),
    toolResultRec('tool-result-record', t),
    userRec('sticky-user', 'STICKY_FIRST_PROMPT keep this visible', t),
    answerRec('sticky-answer', firstAnswer, t),
    userRec(
      'delivered-mail',
      `[podium message msg_sticky_e2e · from issue:POD-16 · to your session · reply: podium mail reply msg_sticky_e2e]
DELIVERED_AGENT_MAIL must not replace the operator prompt
[end podium message msg_sticky_e2e]STICKY_SECOND_PROMPT push the first away`,
      t,
    ),
    answerRec('sticky-answer-2', secondAnswer, t),
  ])

  await openApp(page)
  await newSession(page, 'Claude')
  const activeId = await page
    .locator('.flex.min-h-0 > div[data-session]:visible')
    .first()
    .getAttribute('data-session')
  expect(activeId).not.toBeNull()
  await bindTranscript(
    activeId as string,
    join(BUCKET, '44444444-4444-4444-8444-444444444444.jsonl'),
  )
  const chatMode = page.locator('[data-testid="mode-chat"]:visible')
  await expect(chatMode).toBeVisible({ timeout: 15_000 })
  await chatMode.click()

  const scroller = page
    .locator('div.overflow-y-auto')
    .filter({ has: page.locator('.transcript-row') })
    .locator('visible=true')
    .first()
  const firstPrompt = scroller
    .locator('.transcript-row')
    .filter({ hasText: 'STICKY_FIRST_PROMPT keep this visible' })
  const secondPrompt = scroller
    .locator('.transcript-row')
    .filter({ hasText: 'STICKY_SECOND_PROMPT push the first away' })
  const deliveredMail = scroller
    .locator('.transcript-row')
    .filter({ hasText: 'DELIVERED_AGENT_MAIL must not replace the operator prompt' })
  await expect(firstPrompt).toBeAttached({ timeout: 15_000 })
  await expect(secondPrompt).toBeAttached()
  await expect(firstPrompt).toHaveAttribute('data-operator-prompt', 'true')
  await expect(secondPrompt).toHaveAttribute('data-operator-prompt', 'true')
  await expect(firstPrompt.locator('[data-sticky-prompt-backdrop]')).toHaveCount(1)
  await expect(deliveredMail).not.toHaveAttribute('data-operator-prompt', 'true')
  await expect(deliveredMail).toHaveAttribute('data-internal-message', 'true')
  await expect(deliveredMail).toContainText('Internal')
  await expect(page.locator('[data-testid="sticky-user-message"]')).toHaveCount(0)

  // Start above the first prompt, then scroll its real row into the sticky
  // boundary. There is no duplicate overlay: the same DOM row stops at the top.
  await scroller.evaluate((el) => {
    el.scrollTop = 0
  })
  const geometry = await scroller.evaluate((el) => {
    const prompts = Array.from(el.querySelectorAll<HTMLElement>('[data-operator-prompt="true"]'))
    const first = prompts.find((row) => row.textContent?.includes('STICKY_FIRST_PROMPT'))
    const second = prompts.find((row) => row.textContent?.includes('STICKY_SECOND_PROMPT'))
    if (!first || !second) throw new Error('operator prompt rows not found')
    return {
      firstTop: first.offsetTop,
      firstHeight: first.offsetHeight,
      secondTop: second.offsetTop,
    }
  })
  await scroller.evaluate((el, top) => {
    el.scrollTop = top
  }, geometry.firstTop + 24)
  await expect
    .poll(async () => {
      return scroller.evaluate((el) => {
        const prompt = el.querySelector<HTMLElement>('[data-operator-prompt="true"]')
        if (!prompt) return false
        const promptTop = prompt.getBoundingClientRect().top
        const bodyTop =
          prompt.querySelector<HTMLElement>(':scope > .transcript-body')?.getBoundingClientRect()
            .top ?? Number.POSITIVE_INFINITY
        const viewportTop = el.getBoundingClientRect().top
        const stickyTop =
          viewportTop +
          (Number.parseFloat(getComputedStyle(el).paddingTop) || 0) +
          (Number.parseFloat(getComputedStyle(prompt).top) || 0)
        const visibleInset = bodyTop - viewportTop
        return Math.abs(promptTop - stickyTop) <= 2 && visibleInset >= 6 && visibleInset <= 10
      })
    })
    .toBe(true)

  // The stuck surface bleeds to both transcript edges while its content stays
  // on the shared 960px reading measure.
  expect(
    await scroller.evaluate((el) => {
      const prompt = el.querySelector<HTMLElement>(
        '[data-operator-prompt="true"][data-stuck="true"]',
      )
      const backdrop = prompt?.querySelector<HTMLElement>('[data-sticky-prompt-backdrop]')
      if (!prompt || !backdrop) return false
      const scrollerRect = el.getBoundingClientRect()
      const promptRect = prompt.getBoundingClientRect()
      const backdropRect = backdrop.getBoundingClientRect()
      return (
        backdropRect.left <= scrollerRect.left &&
        backdropRect.right >= scrollerRect.right &&
        backdropRect.width > promptRect.width
      )
    }),
  ).toBe(true)

  // As the next operator turn arrives, it physically pushes the first row out;
  // their edges meet during the handoff instead of the cards overlapping.
  await scroller.evaluate((el, { secondTop, firstHeight }) => {
    el.scrollTop = secondTop - firstHeight / 2
  }, geometry)
  await expect
    .poll(async () => {
      return scroller.evaluate((el) => {
        const prompts = Array.from(
          el.querySelectorAll<HTMLElement>('[data-operator-prompt="true"]'),
        )
        const first = prompts.find((row) => row.textContent?.includes('STICKY_FIRST_PROMPT'))
        const second = prompts.find((row) => row.textContent?.includes('STICKY_SECOND_PROMPT'))
        if (!first || !second) return false
        const firstBody = first.querySelector<HTMLElement>(':scope > .transcript-body')
        const secondBody = second.querySelector<HTMLElement>(':scope > .transcript-body')
        if (!firstBody || !secondBody) return false
        const firstRect = firstBody.getBoundingClientRect()
        const secondRect = secondBody.getBoundingClientRect()
        const stickyTop =
          el.getBoundingClientRect().top +
          (Number.parseFloat(getComputedStyle(el).paddingTop) || 0) +
          (Number.parseFloat(getComputedStyle(first).top) || 0)
        return (
          firstRect.top < stickyTop &&
          secondRect.top > stickyTop &&
          Math.abs(firstRect.bottom - secondRect.top) <= 2
        )
      })
    })
    .toBe(true)
  await scroller.evaluate((el, top) => {
    el.scrollTop = top + 12
  }, geometry.secondTop)
  await expect
    .poll(async () => {
      return scroller.evaluate((el) => {
        const prompts = Array.from(
          el.querySelectorAll<HTMLElement>('[data-operator-prompt="true"]'),
        )
        const prompt = prompts.find((row) => row.textContent?.includes('STICKY_SECOND_PROMPT'))
        if (!prompt) return false
        const promptTop = prompt.getBoundingClientRect().top
        const bodyTop =
          prompt.querySelector<HTMLElement>(':scope > .transcript-body')?.getBoundingClientRect()
            .top ?? Number.POSITIVE_INFINITY
        const viewportTop = el.getBoundingClientRect().top
        const stickyTop =
          viewportTop +
          (Number.parseFloat(getComputedStyle(el).paddingTop) || 0) +
          (Number.parseFloat(getComputedStyle(prompt).top) || 0)
        return Math.abs(promptTop - stickyTop) <= 2 && bodyTop - viewportTop <= 10
      })
    })
    .toBe(true)

  // The calm state transition is removed under reduced-motion; the scroll
  // tracking itself remains direct and unanimated in every mode.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(secondPrompt).toHaveCSS('transition-property', 'none')

  // The default-on behavior can be disabled immediately in Appearance. Return
  // to the same chat and prove the real prompt now scrolls away normally.
  await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
  const stickySwitch = settings.getByRole('switch', { name: 'Sticky prompts' })
  await expect(stickySwitch).toBeChecked()
  await stickySwitch.click()
  await expect(stickySwitch).not.toBeChecked()
  await settings.getByRole('button', { name: 'Back', exact: true }).click()
  await gotoWorkspace(page)
  await expect(firstPrompt).toBeAttached({ timeout: 15_000 })
  await expect(firstPrompt).not.toHaveClass(/\bsticky\b/)
  await scroller.evaluate((el, top) => {
    el.scrollTop = top + 24
  }, geometry.firstTop)
  await expect
    .poll(async () => {
      const [prompt, viewport] = await Promise.all([
        firstPrompt.boundingBox(),
        scroller.boundingBox(),
      ])
      return !!prompt && !!viewport && prompt.y < viewport.y - 2
    })
    .toBe(true)
})

test('(c) scroll-to-top pages older history off disk with no gaps or duplicates', async ({
  page,
}) => {
  // Heavier than the others: a 1400-item transcript + many scroll-to-top paging
  // passes (each does a disk read + prepend). Give it room beyond the 30s default.
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 900 })

  // Build a transcript LONGER than the initial read window (INITIAL_LIMIT = 1000
  // items) so the first read returns hasMore:true and scroll-to-top must fetch an
  // older page off disk via the cursor anchor. Each user turn carries a unique,
  // monotonically-increasing marker so we can detect any gap or duplicate after
  // paging. 700 user+answer pairs = 1400 items (> 1000).
  const PAIRS = 700
  const lines: string[] = []
  const base = Date.parse('2026-06-20T00:00:00.000Z')
  for (let i = 0; i < PAIRS; i++) {
    const ts = new Date(base + i * 1000).toISOString()
    // Zero-padded ordinal makes "MARK-0000" .. "MARK-0699" both unique and sortable.
    const mark = `MARK-${String(i).padStart(4, '0')}`
    lines.push(userRec(`u-${i}`, `${mark} prompt number ${i}`, ts))
    lines.push(answerRec(`a-${i}`, `answer for ${mark}`, ts))
  }
  await seedTranscript('22222222-2222-4222-8222-222222222222', lines)

  await openApp(page)
  await newSession(page, 'Claude')
  await expect(chatToggle(page)).toBeVisible({ timeout: 15_000 })
  await chatToggle(page).click()

  // Read every rendered prompt ordinal straight from the DOM (uniquely numbered),
  // so we can reason about the window precisely without locator timing races.
  // (The first prompt also becomes the session title in sidebar buttons, so we key
  // off the transcript markdown text, not a bare page-wide getByText.) Only count
  // VISIBLE .chat-md (offsetParent !== null) so the keep-mounted hidden panels from
  // earlier tests in this file never contribute.
  const renderedOrdinals = (): Promise<number[]> =>
    page.evaluate(() => {
      const out: number[] = []
      for (const el of Array.from(document.querySelectorAll('.chat-md'))) {
        if ((el as HTMLElement).offsetParent === null) continue
        const m = el.textContent?.match(/MARK-(\d{4}) prompt number/)
        if (m) out.push(Number(m[1]))
      }
      return out
    })

  // The read returns the newest INITIAL_LIMIT (1000) items and ChatView bounds the
  // DOM to RENDER_WINDOW (300) rows; the rendered window settles to the newest ~300
  // prompts. Wait for that to settle (newest MARK-0699 present AND the window
  // clamped so the oldest rendered ordinal is well inside the newest half) before
  // probing — the initial mount briefly holds the full list before clamping, which
  // would make a naive "MARK-0050 absent" check flaky. Generous timeout: this runs
  // after other sessions exist on the shared relay, so the spawn + first read can be
  // slower than in isolation.
  await expect
    .poll(
      async () => {
        const ords = await renderedOrdinals()
        if (ords.length === 0) return false
        const hi = Math.max(...ords)
        const lo = Math.min(...ords)
        // Newest present and the window has clamped (the bounded ~300-row window means
        // the oldest rendered ordinal is well inside the newest half, never near 50).
        return hi === 699 && ords.length <= 320 && lo >= 400
      },
      { timeout: 60_000, intervals: [250, 500, 1000] },
    )
    .toBe(true)

  // The newest marker is present; an OLD marker beyond the initial 1000-item window
  // (it can only appear after a disk back-page) is NOT yet rendered. Read from the
  // settled DOM snapshot (the window can re-clamp on a ResizeObserver tick, so a
  // single querySelectorAll read is more stable here than a visibility locator).
  const initial = await renderedOrdinals()
  expect(initial, 'newest marker 699 in the initial window').toContain(699)
  expect(initial, 'MARK-0050 not in the settled initial window').not.toContain(50)

  // Scroll to the very top repeatedly; each pass reveals more locally-held rows, then
  // autoloads an older disk page (anchored read) and prepends it. Drive it until the
  // out-of-initial-window marker (50) appears, proving the disk back-page landed.
  // Scope the scroller to the VISIBLE chat panel — the keep-mounted hidden panels
  // from earlier tests also have an overflow-y-auto scroller, and scrolling a hidden
  // one does nothing (this was a real flake: `.first()` grabbed a hidden scroller).
  const scroller = page
    .locator('div.overflow-y-auto')
    .filter({ has: page.locator('.transcript-row') })
    .locator('visible=true')
    .first()
  await expect
    .poll(
      async () => {
        // Scroll the visible scroller to the top; the onScroll handler reveals more
        // local rows then autoloads + prepends an older disk page.
        await scroller.evaluate((el) => {
          el.scrollTop = 0
        })
        // Give the window-grow / disk-fetch + prepend a beat to settle.
        await page.waitForTimeout(300)
        return (await renderedOrdinals()).includes(50)
      },
      { timeout: 60_000 },
    )
    .toBe(true)

  // No gaps / no duplicates across the paging seam: every marker that is currently
  // rendered must be unique, and the rendered markers must be a CONTIGUOUS ascending
  // run (no skipped ordinals between the lowest and highest visible marker). This
  // catches both a gap (a missing ordinal in the run) and a duplicate (a repeated one).
  const rendered: number[] = await renderedOrdinals()
  expect(rendered.length, 'some markers rendered').toBeGreaterThan(0)
  const unique = new Set(rendered)
  expect(unique.size, 'no duplicate markers across the paging seam').toBe(rendered.length)
  const sorted = [...unique].sort((a, b) => a - b)
  const lo = Math.min(...sorted)
  const hi = Math.max(...sorted)
  // The visible markers must form a contiguous ascending run lo..hi — any missing
  // ordinal in between is a gap introduced by paging.
  expect(sorted, `markers ${lo}..${hi} contiguous (no gap)`).toEqual(
    Array.from({ length: hi - lo + 1 }, (_, k) => lo + k),
  )
})

/**
 * (re-seed) The transcript survives a fresh ChatView mount that re-reads off disk.
 *
 * SCOPE / HONESTY: a true server-PROCESS restart (or a daemon reattach re-seed) is
 * NOT drivable from this browser harness — the server + daemon run as an external
 * Playwright `webServer` the spec cannot signal, and the only control plane the page
 * exposes (`__podium`) has no restart/detach hook. Those paths are covered by the
 * daemon/server unit + integration tests (apps/daemon/src/daemon.test.ts re-seeds the
 * tail on reattach; apps/server/src/relay.test.ts covers the read routing). What this
 * scenario DOES prove at runtime is the client-visible re-seed: toggling chat → native
 * → chat fully UNMOUNTS and re-MOUNTS ChatView, so its read-then-subscribe effect runs
 * again from scratch and must re-populate the transcript from disk (not leave it blank).
 * This is the same code path a reconnect / panel re-mount exercises, and it would
 * regress to an empty chat if the read-then-subscribe seeding were broken.
 */
test('(re-seed) the transcript re-loads on a fresh ChatView mount (chat→native→chat)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  const t = '2026-06-21T09:00:00.000Z'
  await seedTranscript('33333333-3333-4333-8333-333333333333', [
    userRec('u-1', 'RESEED_PROMPT_ECHO investigate the reattach path', t),
    answerRec('a-1', 'RESEED_ANSWER_FOXTROT re-seeded the tail on reattach', t),
  ])

  await openApp(page)
  await newSession(page, 'Claude')
  await expect(chatToggle(page)).toBeVisible({ timeout: 15_000 })
  await chatToggle(page).click()

  // Scope to VISIBLE chat markdown + this test's unique markers so the keep-mounted
  // hidden panels from other tests never satisfy the assertion.
  const msg = (text: string) =>
    page.locator('.chat-md').locator('visible=true').filter({ hasText: text })
  // First mount renders the transcript.
  await expect(msg('RESEED_PROMPT_ECHO investigate the reattach path')).toBeVisible({
    timeout: 15_000,
  })

  // Switch to native (unmounts ChatView), then back to chat (a brand-new ChatView
  // instance whose read-then-subscribe effect must re-seed from disk).
  await nativeToggle(page).click()
  // ChatView is gone — this test's transcript message is no longer in the visible DOM.
  await expect(msg('RESEED_PROMPT_ECHO investigate the reattach path')).toHaveCount(0, {
    timeout: 10_000,
  })
  await chatToggle(page).click()

  // The freshly-mounted ChatView must re-read and re-render the transcript — not the
  // empty state.
  await expect(msg('RESEED_PROMPT_ECHO investigate the reattach path')).toBeVisible({
    timeout: 15_000,
  })
  await expect(msg('RESEED_ANSWER_FOXTROT re-seeded the tail on reattach')).toBeVisible()
  await expect(
    page.getByText('No transcript yet.', { exact: false }).locator('visible=true'),
  ).toHaveCount(0)
})
