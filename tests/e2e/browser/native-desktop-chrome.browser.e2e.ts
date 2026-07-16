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

  const theme = await header.evaluate((element) => {
    const cardSample = document.createElement('div')
    cardSample.style.background = 'var(--card)'
    document.body.append(cardSample)
    const card = getComputedStyle(cardSample).backgroundColor
    cardSample.remove()
    return {
      background: getComputedStyle(element).backgroundColor,
      card,
      paddingLeft: getComputedStyle(element).paddingLeft,
    }
  })
  expect(theme.background).toBe(theme.card)
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
  expect(geometry.logoToNav).toBe(16)
})
