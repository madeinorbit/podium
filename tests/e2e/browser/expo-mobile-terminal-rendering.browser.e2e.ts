import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => !isMobile, 'mobile browser proof')
test.setTimeout(180_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1149')

test('Expo native agent view keeps rapid TUI redraws legible', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })

  await page.goto(`/mobile?server=${RELAY}`)
  await page.getByRole('button', { name: 'New work' }).click()
  const launcher = page.getByRole('dialog')
  await launcher.getByRole('button', { name: 'Claude Code' }).click()
  await launcher.getByRole('button', { name: 'podium', exact: true }).click()
  await expect(page).toHaveURL(/\/mobile\/session\//, { timeout: 30_000 })

  // Expo Router does not retain the root query on a pushed route. Reload the
  // session route with the test flag so the terminal exposes its test API at
  // the initial hidden mount, before the first native reveal.
  const sessionUrl = new URL(page.url())
  sessionUrl.searchParams.set('e2e', '1')
  await page.goto(sessionUrl.href)

  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __podium?: { diagnostics(): Array<{ event: string }> }
        }
      ).__podium
        ?.diagnostics()
        .some((entry) => entry.event === 'mount') === true,
  )
  await expect(page.locator('.xterm')).toHaveCount(1)
  await expect(page.locator('.xterm')).toBeHidden()

  await page.getByRole('button', { name: 'Native agent view' }).click()
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

  // Desktop keeps AgentPanel's terminal mounted under chat and flips `active`.
  // Expo must exercise the identical setActive -> reveal -> fit -> WebGL atlas
  // recovery path, without a second terminal mount.
  await page.getByRole('button', { name: 'Chat view' }).click()
  await expect(page.locator('.xterm')).toBeHidden()
  await expect.poll(() => terminalEventCount(page, 'panel:active-change', false)).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Native agent view' }).click()
  await expect(page.locator('.xterm')).toBeVisible()
  await expect.poll(() => terminalEventCount(page, 'panel:active-change', true)).toBeGreaterThan(1)
  await expect.poll(() => terminalEventCount(page, 'reveal:start')).toBeGreaterThan(1)
  await expect.poll(() => terminalEventCount(page, 'renderer:recovered')).toBeGreaterThan(0)
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
