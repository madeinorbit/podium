import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'native desktop chrome coverage')

test('web keeps the browser-owned window chrome', async ({ page }) => {
  await openApp(page)

  const header = page.getByTestId('desktop-topbar')
  await expect(page.locator('html')).not.toHaveAttribute('data-podium-desktop', 'true')
  await expect(header).not.toHaveAttribute('data-tauri-drag-region')
  await expect(header.getByRole('group', { name: 'Window controls' })).toHaveCount(0)
  expect(await header.evaluate((element) => getComputedStyle(element).paddingLeft)).toBe('14px')
})

test('Windows and Linux render draggable custom controls', async ({ page }) => {
  await page.addInitScript(() => {
    const actions: string[] = []
    ;(window as unknown as { __nativeWindowActions: string[] }).__nativeWindowActions = actions
    ;(
      window as unknown as {
        __PODIUM_DESKTOP__: {
          platform: string
          minimize: () => Promise<void>
          toggleMaximize: () => Promise<void>
          close: () => Promise<void>
        }
      }
    ).__PODIUM_DESKTOP__ = {
      platform: 'windows',
      minimize: async () => actions.push('minimize'),
      toggleMaximize: async () => actions.push('maximize'),
      close: async () => actions.push('close'),
    }
  })
  await openApp(page)

  const root = page.locator('html')
  await expect(root).toHaveAttribute('data-podium-desktop', 'true')
  await expect(root).toHaveAttribute('data-podium-platform', 'windows')
  const header = page.getByTestId('desktop-topbar')
  await expect(header).toHaveAttribute('data-tauri-drag-region', 'true')
  await expect(header.locator('.desktop-topbar-logo')).toHaveAttribute(
    'data-tauri-drag-region',
    'true',
  )
  await expect(header.getByRole('group', { name: 'Window controls' })).toBeVisible()

  await header.getByRole('button', { name: 'Minimize window' }).click()
  await header.getByRole('button', { name: 'Maximize window' }).click()
  await header.getByRole('button', { name: 'Close window' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __nativeWindowActions: string[] }).__nativeWindowActions,
      ),
    )
    .toEqual(['minimize', 'maximize', 'close'])

  // The bar is the chassis, not a card: POD-365 dropped the command bar's
  // surface to the frame tier `--bar` (remeasured POD-725/POD-737), so the
  // custom-chrome header must sit on that token — an opaque surface, unlike
  // macOS where the same band goes transparent over NSVisualEffectView.
  const theme = await header.evaluate((element) => {
    const barSample = document.createElement('div')
    barSample.style.background = 'var(--bar)'
    document.body.append(barSample)
    const bar = getComputedStyle(barSample).backgroundColor
    barSample.remove()
    return {
      background: getComputedStyle(element).backgroundColor,
      bar,
      paddingLeft: getComputedStyle(element).paddingLeft,
    }
  })
  expect(theme.background).toBe(theme.bar)
  expect(theme.paddingLeft).toBe('14px')
})

test('macOS reserves traffic-light space and keeps native controls', async ({ page }) => {
  await page.addInitScript(() => {
    ;(
      window as unknown as {
        __PODIUM_DESKTOP__: {
          platform: string
          minimize: () => Promise<void>
          toggleMaximize: () => Promise<void>
          close: () => Promise<void>
        }
      }
    ).__PODIUM_DESKTOP__ = {
      platform: 'macos',
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
    }
  })
  await openApp(page)

  const root = page.locator('html')
  await expect(root).toHaveAttribute('data-podium-platform', 'macos')
  const header = page.getByTestId('desktop-topbar')
  await expect(header.getByRole('group', { name: 'Window controls' })).toHaveCount(0)
  const geometry = await header.evaluate((element) => {
    const logo = element.querySelector<HTMLElement>('.desktop-topbar-logo')
    const nav = element.querySelector<HTMLElement>('.desktop-topbar-nav')
    if (!logo || !nav) throw new Error('macOS header geometry elements are missing')
    const logoBounds = logo.getBoundingClientRect()
    const navBounds = nav.getBoundingClientRect()
    return {
      paddingLeft: getComputedStyle(element).paddingLeft,
      logoToNav: navBounds.left - logoBounds.right,
    }
  })
  expect(geometry.paddingLeft).toBe('84px')
  // POD-365's single 18px zone gap plus the 6px macOS nav inset
  // (html[data-podium-platform="macos"] .desktop-topbar-nav) — the POD-666-era
  // 16px this suite froze predates the command bar's one-rhythm respacing.
  expect(geometry.logoToNav).toBe(24)
})
