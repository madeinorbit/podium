import { rm } from 'node:fs/promises'
import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

/**
 * Runtime verification of the markdown preview feature against the REAL Live UI on the
 * harness relay (serve-harness registers THIS repo, so a Shell session's cwd is the repo
 * root and files we write there are readable through the daemon sandbox). Covers the
 * browser-only behaviors unit tests cannot: a real DOMPurify pass, real CodeMirror, the
 * Preview/Source/Split mode switch, and the relative-image pipeline through /files/asset.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (real mouse click on a terminal cell)')

async function sh(page: Page, line: string): Promise<void> {
  await podium.send(page, `${line}\r`)
}

/** Click a STYLED relative path printed into the shell and wait for its file tab. Mirrors
 *  the robust retry-click in clickable-files (visible terminal cell + lazy link resolve). */
async function openStyledFile(page: Page, rel: string, st: { cols: number; rows: number }): Promise<void> {
  await sh(page, `printf '\\033[1;34m%s\\033[0m\\n' '${rel}'`)
  await expect.poll(async () => (await podium.screen(page)).includes(rel), { timeout: 15_000 }).toBe(true)
  const base = rel.replace('./', '')
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const lines = (await podium.screen(page)).split('\n')
    const total = lines.length - 1
    const screenRow = lines.lastIndexOf(rel) - (total - st.rows)
    if (lines.lastIndexOf(rel) >= 0 && screenRow >= 0 && screenRow < st.rows) {
      const box = await page.evaluate(() => {
        const els = [...document.querySelectorAll('.xterm-screen')] as HTMLElement[]
        const el = els.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ?? els[0]
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })
      const x = Math.round(box.x + 6.5 * (box.w / st.cols))
      const y = Math.round(box.y + (screenRow + 0.5) * (box.h / st.rows))
      await page.mouse.move(x, y)
      await page.waitForTimeout(250)
      await page.mouse.click(x, y)
      try {
        // main's first-class tabs nest the label button inside the tab wrapper, so two
        // buttons share the basename name — match the first to avoid a strict violation.
        await page.getByRole('button', { name: base }).first().waitFor({ state: 'visible', timeout: 1500 })
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

test('markdown opens as a rendered preview; sanitizes; toggles Preview/Source/Split; renders a relative image', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Shell')
  await expect.poll(async () => (await podium.screen(page)).length, { timeout: 20_000 }).toBeGreaterThan(0)

  // Session cwd === the repo root (serve-harness registers this repo); confirm it.
  await sh(page, 'printf "CWDIS<<%s>>\\n" "$PWD"')
  let cwd = ''
  await expect
    .poll(async () => {
      const m = (await podium.screen(page)).match(/CWDIS<<(\/[^>]*)>>/)
      if (m) cwd = m[1].trim()
      return cwd
    }, { timeout: 15_000 })
    .toMatch(/^\//)

  // A real image next to the .md (copied from the committed fixture) + a markdown file
  // exercising every relevant feature, INCLUDING a <script> the browser DOMPurify must strip.
  await sh(page, 'cp docs/markdown-preview-samples/diagram.png ./e2e_img.png')
  const md =
    '# Heading\\n\\npara with **bold** text and a [link](https://example.com)\\n\\n| a | b |\\n| - | - |\\n| 1 | 2 |\\n\\n<script>window.__XSS=1</script>\\n\\n![pic](./e2e_img.png)\\n'
  await sh(page, `printf '${md}' > ./e2e_preview.md`)
  const st = await page.evaluate(() => {
    const s = (window as unknown as { __podium: { state(): { cols: number; rows: number } } }).__podium.state()
    return { cols: s.cols, rows: s.rows }
  })

  await openStyledFile(page, './e2e_preview.md', st)

  // ---- Default view is the RENDERED preview (not raw source) ----
  const preview = page.locator('.markdown-preview')
  await expect(preview).toBeVisible({ timeout: 10_000 })
  await expect(preview.locator('h1')).toHaveText('Heading')
  await expect(preview.locator('strong')).toHaveText('bold')
  await expect(preview.locator('table')).toBeVisible()
  // No CodeMirror in default preview mode.
  await expect(page.locator('.cm-editor')).toHaveCount(0)

  // ---- Sanitization (REAL browser DOMPurify; happy-dom can't verify this) ----
  await expect(preview.locator('script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __XSS?: number }).__XSS)).toBeUndefined()

  // ---- Relative image renders through /files/asset (daemon→server→img) ----
  const img = preview.locator('img')
  await expect(img).toHaveAttribute('src', /\/files\/asset\?.*sessionId=.*path=/)
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0)

  // The MarkdownFilePanel mode buttons uniquely carry aria-pressed; the workspace's
  // pane-split "⊟" button also has aria-label="Split" but no aria-pressed, so scope to
  // the mode toggle to avoid the strict-mode collision.
  const mode = (name: 'Preview' | 'Source' | 'Split') =>
    page.locator(`button[aria-label="${name}"][aria-pressed]`)

  // ---- Source mode shows the raw markdown in CodeMirror ----
  await mode('Source').click()
  await expect(page.locator('.cm-editor')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.cm-content')).toContainText('# Heading')

  // ---- Split mode shows BOTH panes ----
  await mode('Split').click()
  await expect(page.locator('.markdown-preview')).toBeVisible()
  await expect(page.locator('.cm-editor')).toBeVisible()

  // ---- Back to Preview ----
  await mode('Preview').click()
  await expect(page.locator('.markdown-preview h1')).toHaveText('Heading')
  await expect(page.locator('.cm-editor')).toHaveCount(0)

  await rm(`${cwd}/e2e_preview.md`, { force: true }).catch(() => {})
  await rm(`${cwd}/e2e_img.png`, { force: true }).catch(() => {})
})
