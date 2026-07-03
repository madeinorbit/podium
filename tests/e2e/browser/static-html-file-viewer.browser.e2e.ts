import { readFile, rm } from 'node:fs/promises'
import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop pointer test (real mouse click on a terminal cell)')

const gridSize = (page: Page): Promise<{ cols: number; rows: number }> =>
  page.evaluate(() => {
    const s = (
      window as unknown as { __podium: { state(): { cols: number; rows: number } } }
    ).__podium.state()
    return { cols: s.cols, rows: s.rows }
  })

async function sh(page: Page, line: string): Promise<void> {
  await podium.send(page, `${line}\r`)
}

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
    const lineIndex = lines.lastIndexOf(rel)
    const screenRow = lineIndex - (total - st.rows)
    if (lineIndex >= 0 && screenRow >= 0 && screenRow < st.rows) {
      const box = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.xterm-screen')) as HTMLElement[]
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
        /* render/hit-test miss - recompute and retry */
      }
    } else {
      await page.waitForTimeout(300)
    }
  }

  throw new Error(`could not open ${rel}`)
}

test('native terminal: clicking a static html file opens rendered preview and source save writes disk', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await newSession(page, 'Shell')
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

  const relHtml = './e2e_static_viewer.html'
  const relCss = './e2e_static_viewer.css'
  const htmlAbs = `${cwd}/e2e_static_viewer.html`
  const cssAbs = `${cwd}/e2e_static_viewer.css`

  try {
    await sh(
      page,
      `printf '<link rel="stylesheet" href="${relCss}"><h1>STATIC_HTML_RENDERED</h1>\\n' > ${relHtml}`,
    )
    await sh(page, `printf 'h1 { color: rgb(1, 99, 33); }\\n' > ${relCss}`)

    const st = await gridSize(page)
    await openStyledFile(page, relHtml, st)
    await expect(page.getByRole('button', { name: 'e2e_static_viewer.html' }).first()).toBeVisible()

    const iframe = page.locator('iframe[title="Rendered HTML preview"]')
    await expect(iframe).toBeVisible({ timeout: 15_000 })
    await expect(iframe).toHaveAttribute('sandbox', '')

    const preview = page.frameLocator('iframe[title="Rendered HTML preview"]')
    await expect(preview.locator('body')).toContainText('STATIC_HTML_RENDERED', {
      timeout: 15_000,
    })
    await expect
      .poll(
        async () =>
          preview
            .locator('h1')
            .evaluate((el) => getComputedStyle(el).color)
            .catch(() => ''),
        { timeout: 15_000 },
      )
      .toBe('rgb(1, 99, 33)')

    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(page.locator('.cm-content')).toContainText('STATIC_HTML_RENDERED', {
      timeout: 15_000,
    })

    const edit = 'E2E_HTML_EDIT'
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.type(`${edit} `)
    await page.keyboard.press('Control+s')

    await expect(page.getByText('Saved', { exact: false })).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(async () => await readFile(htmlAbs, 'utf8').catch(() => ''), { timeout: 10_000 })
      .toContain(edit)
    expect(await readFile(htmlAbs, 'utf8')).toContain('STATIC_HTML_RENDERED')
  } finally {
    await rm(htmlAbs, { force: true }).catch(() => {})
    await rm(cssAbs, { force: true }).catch(() => {})
  }
})
