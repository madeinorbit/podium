import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop shell foundation check')

test('podium dark foundation exposes canonical tokens and semantic styling at runtime', async ({
  page,
}) => {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await expect(page.getByTestId('desktop-topbar')).toBeVisible({ timeout: 45_000 })

  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }

  await expect(page.locator('aside').first()).toBeVisible({ timeout: 15_000 })
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('12px "Geist Variable"'),
      document.fonts.load('12px "Geist Mono Variable"'),
    ])
    await document.fonts.ready
  })

  const foundation = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const body = getComputedStyle(document.body)
    const sidebar = getComputedStyle(document.querySelector('aside') as HTMLElement)
    const claudeIcon = getComputedStyle(
      document.querySelector('[data-testid="new-agent-button"] svg') as SVGElement,
    )
    const read = (name: string): string => root.getPropertyValue(name).trim()

    return {
      preset: document.documentElement.dataset.theme,
      dark: document.documentElement.classList.contains('dark'),
      bodyFont: body.fontFamily,
      geistLoaded: document.fonts.check('12px "Geist Variable"'),
      geistMonoLoaded: document.fonts.check('12px "Geist Mono Variable"'),
      sidebarBackground: sidebar.backgroundColor,
      sidebarBorder: sidebar.borderRightColor,
      claudeIconColor: claudeIcon.color,
      tokens: Object.fromEntries(
        [
          '--background',
          '--card',
          '--engraved',
          '--bar',
          '--tabstrip',
          '--rail',
          '--chip',
          '--border',
          '--hairline-soft',
          '--hairline-bar',
          '--border-strong',
          '--text-strong',
          '--foreground',
          '--muted-foreground',
          '--text-dim',
          '--text-faint',
          '--label',
          '--attention',
          '--attention-foreground',
          '--live',
          '--claude',
          '--flow',
          '--issue',
        ].map((name) => [name, read(name)]),
      ),
    }
  })

  expect(foundation).toMatchObject({
    preset: 'podium',
    dark: true,
    geistLoaded: true,
    geistMonoLoaded: true,
    sidebarBackground: 'rgb(22, 22, 28)',
    sidebarBorder: 'rgb(42, 42, 52)',
    claudeIconColor: 'rgb(217, 119, 87)',
    tokens: {
      '--background': '#0e0e12',
      '--card': '#16161c',
      '--engraved': '#0a0a0e',
      '--bar': '#08080c',
      '--tabstrip': '#101016',
      '--rail': '#131318',
      '--chip': '#1b1b22',
      '--border': '#2a2a34',
      '--hairline-soft': '#25252f',
      '--hairline-bar': '#2e2e38',
      '--border-strong': '#3a3a46',
      '--text-strong': '#f3f3f8',
      '--foreground': '#d7d7e0',
      '--muted-foreground': '#9a9aa8',
      '--text-dim': '#6c6c78',
      '--text-faint': '#5a5a66',
      '--label': '#7a7a86',
      '--attention': '#f59e0b',
      '--attention-foreground': '#161006',
      '--live': '#10b981',
      '--claude': '#d97757',
      '--flow': '#94a3b8',
      // --issue is a registered <color>, so computed style returns a normalized RGB value.
      '--issue': 'rgb(148, 163, 184)',
    },
  })
  expect(foundation.bodyFont).toContain('Geist Variable')
})
