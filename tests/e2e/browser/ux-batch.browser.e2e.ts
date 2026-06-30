import { rm } from 'node:fs/promises'
import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

/**
 * Runtime click-through of the UX-batch-2026-06-30 changes against the REAL Live UI
 * on the harness relay (serve-harness registers THIS worktree, shell cwd === repo root):
 *   #13 right-click session context menu (tab) + Rename enters edit mode
 *   #8  shells are absent from the command center
 *   #3  copy button on a rendered code block (real click → clipboard)
 *   #4  external links in rendered markdown open in a new tab (target=_blank)
 * Desktop only — these are mouse interactions on desktop surfaces.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (real mouse interactions)')

async function sh(page: Page, line: string): Promise<void> {
  await podium.send(page, `${line}\r`)
}

/** Click a styled relative path printed into the shell, open its file tab (mirrors the
 *  robust retry-click used by the markdown-preview spec). */
async function openStyledFile(
  page: Page,
  rel: string,
  st: { cols: number; rows: number },
): Promise<void> {
  await sh(page, `printf '\\033[1;34m%s\\033[0m\\n' '${rel}'`)
  await expect
    .poll(async () => (await podium.screen(page)).includes(rel), { timeout: 15_000 })
    .toBe(true)
  const base = rel.replace('./', '')
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

test('#13 right-click tab → session context menu; Rename enters edit mode', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Shell')

  // Right-click the session tab (center is over its label button, which carries the
  // onContextMenu handler).
  const tab = page.locator('[data-session]').first()
  await expect(tab).toBeVisible({ timeout: 10_000 })
  await tab.click({ button: 'right' })

  // The cursor-anchored portal menu appears with the full action set.
  const menu = page.locator('[role="menu"][aria-label="Session actions"]')
  await expect(menu).toBeVisible({ timeout: 5_000 })
  for (const name of ['Rename', 'Pin', 'Archive', 'Close']) {
    await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible()
  }
  // Snooze options present (attention actions surface here too).
  await expect(menu.getByRole('menuitem', { name: 'For 1 hour' })).toBeVisible()

  // Rename → the tab swaps to an inline editor input.
  await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await expect(menu).toBeHidden()
  await expect(tab.locator('input')).toBeVisible({ timeout: 5_000 })
  // Cancel the rename so it doesn't interfere with later assertions.
  await tab.locator('input').press('Escape')

  // Esc/outside-click dismissal: reopen, press Escape, menu closes.
  await tab.click({ button: 'right' })
  await expect(menu).toBeVisible({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden({ timeout: 5_000 })
})

test('#8 shells are not listed in the command center', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Shell')

  // Navigate to the command center.
  await page.getByRole('button', { name: 'Command center' }).click()
  await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible({
    timeout: 10_000,
  })

  // With only a shell session present, the board has nothing to triage — the shell
  // must NOT appear (it's filtered by withoutShells). The empty-state copy proves it.
  await expect(page.getByText('No sessions yet', { exact: false })).toBeVisible({ timeout: 10_000 })
})

test('#3/#4 code-block copy button + external links open in a new tab', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Shell')
  await expect
    .poll(async () => (await podium.screen(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)

  let cwd = ''
  await sh(page, 'printf "CWDIS<<%s>>\\n" "$PWD"')
  await expect
    .poll(async () => {
      const m = (await podium.screen(page)).match(/CWDIS<<(\/[^>]*)>>/)
      if (m) cwd = m[1].trim()
      return cwd
    }, { timeout: 15_000 })
    .toMatch(/^\//)

  // A markdown file with a fenced code block and an external link.
  const md =
    'para with a [link](https://example.com)\\n\\n```sh\\nnpm run build\\n```\\n'
  await sh(page, `printf '${md}' > ./e2e_codeblock.md`)
  const st = await page.evaluate(() => {
    const s = (
      window as unknown as { __podium: { state(): { cols: number; rows: number } } }
    ).__podium.state()
    return { cols: s.cols, rows: s.rows }
  })
  await openStyledFile(page, './e2e_codeblock.md', st)

  const preview = page.locator('.markdown-preview')
  await expect(preview).toBeVisible({ timeout: 10_000 })

  // #4 — the external link carries target=_blank + a safe rel.
  const link = preview.locator('a[href="https://example.com"]')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)

  // #3 — the code block has a copy button; clicking it copies the code text.
  const pre = preview.locator('pre').first()
  const copyBtn = pre.locator('.code-copy')
  await expect(copyBtn).toBeAttached()
  await pre.hover()
  await copyBtn.click({ force: true })
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 })
    .toContain('npm run build')

  await rm(`${cwd}/e2e_codeblock.md`, { force: true }).catch(() => {})
})

test('#16/#17 memory view: "Project processes" legend; hibernation note ahead of the process list', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)

  // Open the host memory breakdown from the health strip.
  await page.locator('button[aria-label*="click for the breakdown"]').first().click()
  const panel = page.locator('[aria-label="Host info"]')
  await expect(panel).toBeVisible({ timeout: 10_000 })

  // #17 — the legend says "Project processes", not the old "Projects".
  await expect(panel.getByText('Project processes', { exact: true })).toBeVisible({
    timeout: 10_000,
  })

  // #16 — the auto-hibernation note renders ABOVE the per-process sections.
  await expect(panel.getByText('AGENTS & SHELLS', { exact: true })).toBeVisible({ timeout: 10_000 })
  const noteBeforeList = await panel.evaluate((root) => {
    const note = [...root.querySelectorAll('p')].find((p) =>
      /Auto-hibernation|hibernate/i.test(p.textContent ?? ''),
    )
    const section = [...root.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && el.textContent?.trim() === 'AGENTS & SHELLS',
    )
    if (!note || !section) return null
    // bit 4 (FOLLOWING) set → section comes after the note in document order.
    return Boolean(note.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(noteBeforeList).toBe(true)
})

test('#18 archive button is available once a session has exited', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Shell')
  await expect
    .poll(async () => (await podium.screen(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)

  // Archive is present while the session is live... (the keep-mounted panel deck
  // can hold a hidden second panel, so scope to the visible header button).
  const archive = page.locator('button[title^="Archive session"]:visible')
  await expect(archive).toBeVisible({ timeout: 10_000 })

  // ...end the shell process; the panel flips to its read-only/exited state...
  await sh(page, 'exit')
  await expect(page.getByText('no longer running', { exact: false })).toBeVisible({
    timeout: 15_000,
  })

  // ...and Archive STILL shows (the #18 fix — it used to disappear on exit).
  await expect(archive).toBeVisible({ timeout: 10_000 })
})
