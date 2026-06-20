import { readFile, rm } from 'node:fs/promises'
import { expect, type Page, test } from '@playwright/test'
import { gotoWorkspace, podium, RELAY } from './_harness'

// The committed _harness helpers (openApp/newSession) use pre-shadcn selectors
// (.tab-add / .sidebar .worktree) that no longer exist, so we drive the current
// DOM directly here: open the app in native mode, enter the worktree's workspace,
// then create a Shell session via the NewPanelMenu ("+" → New Shell).
async function openWorkspaceWithShell(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 20_000,
  })
  await gotoWorkspace(page)
  // Create a real shell session.
  await page.getByRole('button', { name: 'New panel' }).click({ timeout: 15_000 })
  await page.getByRole('menuitem', { name: 'New Shell' }).click({ timeout: 10_000 })
  await page.waitForFunction(
    () => !!(window as unknown as { __podium?: unknown }).__podium,
    undefined,
    {
      timeout: 20_000,
    },
  )
  await page.waitForTimeout(800)
}

// Runtime verification of the clickable-files feature against the REAL Live UI:
// a styled file path printed into a live xterm shell pane is clicked with a real
// mouse, which must open the inline CodeMirror editor on that file (the native
// link-provider → activate → openFile → files.read → daemon read → panel path that
// unit tests cannot exercise because happy-dom has no cell geometry). Then we edit
// and Ctrl+S and assert the on-disk file actually changed (files.write round-trip).
test.skip(({ isMobile }) => isMobile, 'desktop pointer test (real mouse click on a terminal cell)')

/** Read the terminal grid size from the live test API (called inside the page —
 *  __podium methods don't survive serialization across the Playwright boundary). */
const gridSize = (page: Page): Promise<{ cols: number; rows: number }> =>
  page.evaluate(() => {
    const s = (
      window as unknown as { __podium: { state(): { cols: number; rows: number } } }
    ).__podium.state()
    return { cols: s.cols, rows: s.rows }
  })

/** Send a shell command line (CR-terminated, as Enter does) to the live PTY. */
async function sh(page: Page, line: string): Promise<void> {
  await podium.send(page, `${line}\r`)
}

test('native terminal: clicking a styled file path opens it in the editor; edit+save writes disk', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openWorkspaceWithShell(page)

  // Wait for a live shell (prompt produces output).
  await expect
    .poll(async () => (await podium.screen(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)

  // Discover the session cwd (the link provider + daemon sandbox key off session.cwd,
  // which is the cwd the shell starts in — so the probe must live there).
  // Require the captured value to start with "/" so we match the printf OUTPUT line
  // (expanded path), not the command-echo line (which contains the literal "%s").
  await sh(page, 'printf "CWDIS<<%s>>\\n" "$PWD"')
  let cwd = ''
  await expect
    .poll(
      async () => {
        const m = (await podium.screen(page)).match(/CWDIS<<(\/[^>]*)>>/)
        if (m) cwd = m[1].trim()
        return cwd
      },
      { timeout: 15_000 },
    )
    .toMatch(/^\//)
  const probeAbs = `${cwd}/e2e_probe_clickable.txt`
  // Click a SHORT, relative styled token so it never wraps across rows (a long
  // absolute path would, breaking the single-line cell lookup). The native provider
  // resolves "./x" against the session cwd to the same absolute file, and (Task 11)
  // hands that resolved absolute path to openFile. It needs a leading "/" to match
  // PATHISH, which the "./" provides.
  const relToken = './e2e_probe_clickable.txt'
  const marker = 'PODIUM_E2E_OPEN_OK'

  // Create the probe file in the session cwd, then print the relative token STYLED
  // (bold blue → the provider's "highlighted-only" gate is satisfied).
  await sh(page, `printf '${marker}\\n' > ${relToken}`)
  await sh(page, `printf '\\033[1;34m%s\\033[0m\\n' '${relToken}'`)

  await expect
    .poll(async () => (await podium.screen(page)).includes(relToken), { timeout: 15_000 })
    .toBe(true)
  const st = await gridSize(page)

  // Convert the styled-path buffer line to a viewport cell, then pixels, and click it.
  // screenText() is the full buffer (scrollback + viewport); pinned to the bottom the
  // viewport top is (total - rows), so screenRow = lineIndex - (total - rows). xterm
  // resolves a link lazily on hover, and the hit-test can briefly miss right after
  // render, so retry: re-read the cell, hover to let the provider resolve, click, and
  // check the editor opened (a real DOM outcome, not a heuristic).
  const editor = page.locator('.cm-editor')
  const clicked = await (async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lines = (await podium.screen(page)).split('\n')
      const total = lines.length - 1 // trailing '' after the final '\n'
      const lineIndex = lines.lastIndexOf(relToken) // bare-token OUTPUT line (echo line has printf/quotes)
      const screenRow = lineIndex - (total - st.rows)
      if (lineIndex >= 0 && screenRow >= 0 && screenRow < st.rows) {
        // The keep-mounted deck leaves hidden sessions' terminals in the DOM; target the
        // VISIBLE one (the active session, which __podium/screenText also refer to).
        const box = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('.xterm-screen')) as HTMLElement[]
          const el =
            els.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ??
            els[0]
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        })
        const col = Math.min(6, relToken.length - 1) // a few chars into the path run
        const x = Math.round(box.x + (col + 0.5) * (box.w / st.cols))
        const y = Math.round(box.y + (screenRow + 0.5) * (box.h / st.rows))
        await page.mouse.move(x, y)
        await page.waitForTimeout(250)
        await page.mouse.click(x, y)
        if (await editor.isVisible().catch(() => false)) return true
        try {
          await editor.waitFor({ state: 'visible', timeout: 1500 })
          return true
        } catch {
          /* miss — recompute and retry */
        }
      } else {
        await page.waitForTimeout(300)
      }
    }
    return false
  })()
  expect(clicked, 'clicking the styled path opened the inline editor').toBe(true)
  await expect(page.locator('.cm-content'), 'editor shows the clicked file content').toContainText(
    marker,
    { timeout: 15_000 },
  )

  // ---- edit + save round-trip (files.write) ----
  const edit = 'E2E_EDIT_SAVE'
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+Home') // cursor to doc start
  await page.keyboard.type(`${edit} `)
  await page.keyboard.press('Control+s')

  // A "Saved" toast confirms the write RPC succeeded...
  await expect(page.getByText('Saved', { exact: false })).toBeVisible({ timeout: 10_000 })
  // ...and the bytes must actually be on disk.
  await expect
    .poll(async () => await readFile(probeAbs, 'utf8').catch(() => ''), { timeout: 10_000 })
    .toContain(edit)
  expect(await readFile(probeAbs, 'utf8')).toContain(marker) // original content preserved

  await rm(probeAbs, { force: true })
})

/** Print a styled relative path into the shell and click it open; returns once the
 *  editor shows. Mirrors the first test's robust click (visible terminal + retry). */
async function openStyledFile(
  page: Page,
  rel: string,
  st: { cols: number; rows: number },
): Promise<void> {
  await sh(page, `printf '\\033[1;34m%s\\033[0m\\n' '${rel}'`)
  await expect
    .poll(async () => (await podium.screen(page)).includes(rel), { timeout: 15_000 })
    .toBe(true)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const lines = (await podium.screen(page)).split('\n')
    const total = lines.length - 1
    const screenRow = lines.lastIndexOf(rel) - (total - st.rows)
    if (lines.lastIndexOf(rel) >= 0 && screenRow >= 0 && screenRow < st.rows) {
      const box = await page.evaluate(() => {
        const els = [...document.querySelectorAll('.xterm-screen')] as HTMLElement[]
        const el =
          els.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ?? els[0]
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })
      const x = Math.round(box.x + 6.5 * (box.w / st.cols))
      const y = Math.round(box.y + (screenRow + 0.5) * (box.h / st.rows))
      await page.mouse.move(x, y)
      await page.waitForTimeout(250)
      await page.mouse.click(x, y)
      const base = rel.replace('./', '')
      try {
        await page
          .getByRole('button', { name: base })
          .first()
          .waitFor({ state: 'visible', timeout: 1500 })
        return
      } catch {
        /* render/hit-test miss — recompute and retry */
      }
    } else {
      await page.waitForTimeout(300)
    }
  }
  throw new Error(`could not open ${rel}`)
}

test('native terminal: each opened file is its own closeable tab in the strip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openWorkspaceWithShell(page)
  await expect
    .poll(async () => (await podium.screen(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)
  await sh(page, 'printf "CWDIS<<%s>>\\n" "$PWD"')
  let cwd = ''
  await expect
    .poll(
      async () => {
        const m = (await podium.screen(page)).match(/CWDIS<<(\/[^>]*)>>/)
        if (m) cwd = m[1].trim()
        return cwd
      },
      { timeout: 15_000 },
    )
    .toMatch(/^\//)
  await sh(page, `printf 'TAB_ONE\\n' > ./e2e_tab_one.txt`)
  const st = await gridSize(page)

  // Open the file → it becomes a closeable TAB in the strip (not an overlay), and the
  // editor shows its content.
  await openStyledFile(page, './e2e_tab_one.txt', st)
  await expect(
    page.getByRole('button', { name: 'e2e_tab_one.txt' }).first(),
    'opened file appears as a tab in the strip',
  ).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('TAB_ONE', { timeout: 10_000 })

  // Close the tab via its × → it disappears from the strip.
  await page.getByRole('button', { name: 'Close file' }).click()
  await expect(page.getByRole('button', { name: 'e2e_tab_one.txt' })).toHaveCount(0)

  await rm(`${cwd}/e2e_tab_one.txt`, { force: true }).catch(() => {})
})

test('native terminal: a HARD-wrapped URL (agent hang-indent) opens whole in a new tab', async ({
  page,
  context,
}) => {
  // Reproduce Claude's exact shape deterministically: a URL printed as a head line that
  // ends in a URL char, then a REAL new line with a 2-space hang indent continuing it
  // (not a terminal soft-wrap). The link must come back WHOLE, not the line-1 fragment.
  await page.setViewportSize({ width: 1280, height: 820 })
  await openWorkspaceWithShell(page)
  await expect
    .poll(async () => (await podium.screen(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)
  const head = `https://example.com/docs/${'seg-'.repeat(15)}x`
  const tail = `${'tl-'.repeat(8)}end`
  const full = head + tail
  await sh(page, `printf '%s\\n  %s\\n' '${head}' '${tail}'`)
  await expect
    .poll(async () => (await podium.screen(page)).includes(tail), { timeout: 15_000 })
    .toBe(true)

  const st = await gridSize(page)
  const popup = await (async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lines = (await podium.screen(page)).split('\n')
      const total = lines.length - 1
      const rowIdx = lines.findIndex((l) => l.startsWith('https://example.com/docs/seg')) // head line
      const screenRow = rowIdx - (total - st.rows)
      if (rowIdx >= 0 && screenRow >= 0 && screenRow < st.rows) {
        const box = await page.evaluate(() => {
          const els = [...document.querySelectorAll('.xterm-screen')] as HTMLElement[]
          const el =
            els.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ??
            els[0]
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        })
        const x = Math.round(box.x + 10.5 * (box.w / st.cols)) // a few chars into the URL head
        const y = Math.round(box.y + (screenRow + 0.5) * (box.h / st.rows))
        const popupP = context.waitForEvent('page', { timeout: 2500 }).catch(() => null)
        await page.mouse.move(x, y)
        await page.waitForTimeout(250)
        await page.mouse.click(x, y)
        const pop = await popupP
        if (pop) return pop
      } else {
        await page.waitForTimeout(300)
      }
    }
    return null
  })()
  expect(popup, 'clicking the head row opened a tab for the whole hard-wrapped URL').toBeTruthy()
  await popup!.waitForLoadState('domcontentloaded').catch(() => {})
  expect(popup!.url(), 'the WHOLE hard-wrapped URL opened, not the line-1 fragment').toBe(full)
  await popup!.close().catch(() => {})
})

test('native terminal: a zero-indent HARD-wrapped URL opens whole in a new tab', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openWorkspaceWithShell(page)
  await expect
    .poll(async () => (await podium.screen(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)

  const st = await gridSize(page)
  const prefix = 'https://example.com/docs/'
  expect(st.cols).toBeGreaterThan(prefix.length + 10)
  const head = prefix + 'a'.repeat(st.cols - prefix.length)
  const finalTail = `${'d'.repeat(24)}end`
  const tails = ['b'.repeat(st.cols), 'c'.repeat(st.cols), finalTail]
  const full = [head, ...tails].join('')

  await sh(
    page,
    `printf '%s\\n%s\\n%s\\n%s\\n' '${head}' '${tails[0]}' '${tails[1]}' '${tails[2]}'`,
  )
  await expect
    .poll(async () => (await podium.screen(page)).split('\n').includes(finalTail), {
      timeout: 15_000,
    })
    .toBe(true)

  const popup = await (async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lines = (await podium.screen(page)).split('\n')
      const total = lines.length - 1
      const rowIdx = lines.indexOf(head)
      const screenRow = rowIdx - (total - st.rows)
      if (rowIdx >= 0 && screenRow >= 0 && screenRow < st.rows) {
        const box = await page.evaluate(() => {
          const els = [...document.querySelectorAll('.xterm-screen')] as HTMLElement[]
          const el =
            els.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ??
            els[0]
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        })
        const x = Math.round(box.x + 10.5 * (box.w / st.cols))
        const y = Math.round(box.y + (screenRow + 0.5) * (box.h / st.rows))
        const popupP = context.waitForEvent('page', { timeout: 2500 }).catch(() => null)
        await page.mouse.move(x, y)
        await page.waitForTimeout(250)
        await page.mouse.click(x, y)
        const pop = await popupP
        if (pop) return pop
      } else {
        await page.waitForTimeout(300)
      }
    }
    return null
  })()

  if (!popup) throw new Error('clicking the head row did not open a tab')
  await popup.waitForLoadState('domcontentloaded').catch(() => {})
  expect(
    popup.url(),
    'the WHOLE zero-indent hard-wrapped URL opened, not the line-1 fragment',
  ).toBe(full)
  await popup.close().catch(() => {})
})

test('native terminal: a wrapped URL opens the FULL url in a NEW tab (not same window)', async ({
  page,
  context,
}) => {
  // Narrow viewport so a long URL wraps across rows. Reproduces the reported shape:
  // prose + URL ("See the docs at https://…") wrapping, where the URL begins after a
  // space on the logical-line start row — the row the unpatched addon truncated.
  await page.setViewportSize({ width: 900, height: 760 })
  await openWorkspaceWithShell(page)
  await expect
    .poll(async () => (await podium.screen(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)

  // ~230 chars, no spaces, and example.com serves 200 for any path with NO redirect,
  // so the opened tab's URL equals exactly what was clicked (clean truncation check).
  const url = `https://example.com/docs/${'segment-'.repeat(26)}end`
  const prose = 'See the docs at '
  await sh(page, `printf '%s%s\\n' '${prose}' '${url}'`)
  await expect
    .poll(async () => (await podium.screen(page)).includes('example.com/docs/segment-'), {
      timeout: 15_000,
    })
    .toBe(true)

  const st = await gridSize(page)
  // Click into the URL on its TOP row (the prose row) and capture the popup it opens.
  const popup = await (async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lines = (await podium.screen(page)).split('\n')
      const total = lines.length - 1
      const rowIdx = lines.findIndex((l) => l.startsWith(`${prose}https://example.com`))
      const screenRow = rowIdx - (total - st.rows)
      if (rowIdx >= 0 && screenRow >= 0 && screenRow < st.rows) {
        const box = await page.evaluate(() => {
          const els = [...document.querySelectorAll('.xterm-screen')] as HTMLElement[]
          const el =
            els.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ??
            els[0]
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        })
        const col = prose.length + 8 // a few chars into the URL, on its top row
        const x = Math.round(box.x + (col + 0.5) * (box.w / st.cols))
        const y = Math.round(box.y + (screenRow + 0.5) * (box.h / st.rows))
        const popupP = context.waitForEvent('page', { timeout: 2500 }).catch(() => null)
        await page.mouse.move(x, y)
        await page.waitForTimeout(250)
        await page.mouse.click(x, y)
        const pop = await popupP
        if (pop) return pop
      } else {
        await page.waitForTimeout(300)
      }
    }
    return null
  })()

  expect(popup, 'clicking the wrapped URL opened a new tab').toBeTruthy()
  await popup!.waitForLoadState('domcontentloaded').catch(() => {})
  // The WHOLE url, not a wrap-truncated fragment like https://example.com/docs/segment-…(first row only).
  expect(popup!.url(), 'the full wrapped URL opened').toBe(url)
  // Podium itself was NOT navigated away — it opened in a separate tab (the PWA-safety fix).
  expect(page.url(), 'Podium stayed put (new tab, not same-window replace)').toContain(
    'localhost:4317',
  )
  await popup!.close().catch(() => {})
})
