import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => !isMobile, 'mobile browser proof')
test.setTimeout(180_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1149')
const VIEWPORT_ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-425')

test('Expo native agent view keeps rapid TUI redraws legible', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })

  await page.goto(`/mobile?server=${RELAY}`)
  await page.getByRole('button', { name: 'New work' }).click()
  const launcher = page.getByRole('dialog')
  await launcher.getByRole('button', { name: 'Claude Code' }).click()
  await launcher.getByRole('button', { name: 'podium', exact: true }).click()
  await expect(page).toHaveURL(/\/mobile\/session\//, { timeout: 30_000 })

  await page.getByRole('button', { name: 'Open terminal' }).click()
  const terminalUrl = new URL(page.url())
  terminalUrl.searchParams.set('e2e', '1')
  await page.goto(terminalUrl.href)
  await page.waitForFunction(
    () =>
      /keyecho/.test(
        (
          window as unknown as {
            __podium?: { screenText(): string }
          }
        ).__podium?.screenText() ?? '',
      ),
    undefined,
    { timeout: 30_000 },
  )

  await expect.poll(() => terminalRenderer(page)).toBe('webgl')
  expect(await terminalFontFamily(page)).toContain('GeistMono_400Regular')
  const terminalBox = await page.locator('.xterm').boundingBox()
  expect(terminalBox).not.toBeNull()
  expect(terminalBox?.y ?? 0).toBeGreaterThanOrEqual(0)
  expect((terminalBox?.y ?? 0) + (terminalBox?.height ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.height ?? 0,
  )
  await expect(page.locator('.xterm')).toBeVisible()
  expect(await terminalEventCount(page, 'mount')).toBe(1)

  const terminal = page.locator('.xterm')
  const input = terminal.locator('.xterm-helper-textarea')
  await input.focus()
  await page.keyboard.type('redraw-stability-abcdefghijklmnopqrstuvwxyz', { delay: 12 })
  await page.waitForTimeout(1_200)

  await expect
    .poll(async () => {
      const text = await terminalScreenText(page)
      return /\[raw\]\s+7a\s+z/.test(text)
    })
    .toBe(true)
  expect(await terminalScreenText(page)).toMatch(/\[raw\]\s+7a\s+z/)

  await page.screenshot({
    path: resolve(ARTIFACTS, 'expo-terminal-redraw.png'),
    fullPage: true,
  })
  mkdirSync(VIEWPORT_ARTIFACTS, { recursive: true })
  await page.screenshot({
    path: resolve(VIEWPORT_ARTIFACTS, 'mobile-terminal-viewport.png'),
    fullPage: true,
  })
})

async function terminalFontFamily(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const entries = (
      window as unknown as {
        __podium?: {
          diagnostics(): Array<{ data?: { view?: { font?: { family?: string } } } }>
        }
      }
    ).__podium?.diagnostics()
    return (
      entries?.findLast((entry) => entry.data?.view?.font?.family)?.data?.view?.font?.family ?? ''
    )
  })
}

async function terminalScreenText(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __podium?: { screenText(): string }
        }
      ).__podium?.screenText() ?? '',
  )
}

async function terminalRenderer(
  page: import('@playwright/test').Page,
): Promise<string | undefined> {
  return page.evaluate(() => {
    const entries = (
      window as unknown as {
        __podium?: {
          diagnostics(): Array<{ data?: { view?: { renderer?: string } } }>
        }
      }
    ).__podium?.diagnostics()
    return entries?.findLast((entry) => entry.data?.view?.renderer)?.data?.view?.renderer
  })
}

async function terminalEventCount(
  page: import('@playwright/test').Page,
  event: string,
  next?: boolean,
): Promise<number> {
  return page.evaluate(
    ({ event, next }) => {
      const entries = (
        window as unknown as {
          __podium?: {
            diagnostics(): Array<{ event: string; data?: { next?: boolean } }>
          }
        }
      ).__podium?.diagnostics()
      return (
        entries?.filter(
          (entry) => entry.event === event && (next === undefined || entry.data?.next === next),
        ).length ?? 0
      )
    },
    { event, next },
  )
}
