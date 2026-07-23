import { mkdir } from 'node:fs/promises'
import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

async function captureReviewShot(page: Page, name: string): Promise<void> {
  if (process.env.PODIUM_CAPTURE_INTERACTION !== '1') return
  const dir = `${process.cwd()}/artifacts`
  await mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}`, fullPage: true })
}

async function openShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as Window & { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
  })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }
}

test.describe('interaction feedback contract', () => {
  test('visible controls expose focus, real pointer-down, touch, and reduced-motion states', async ({
    page,
    isMobile,
  }) => {
    await openShell(page)
    const control = page.locator('[data-pressable]:visible:not(:disabled)').first()
    await expect(control).toBeVisible({ timeout: 15_000 })

    await control.focus()
    await expect
      .poll(() => control.evaluate((element) => getComputedStyle(element).outlineStyle))
      .toBe('solid')

    await captureReviewShot(
      page,
      isMobile ? 'POD-228-pixel-focus.png' : 'POD-228-desktop-focus.png',
    )

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect
      .poll(() => control.evaluate((element) => getComputedStyle(element).transitionDuration))
      .toMatch(/^(0s)(, 0s)*$/)
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    if (!box) return
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2

    if (isMobile) {
      await control.evaluate((element) => {
        element.addEventListener(
          'pointerdown',
          (event) => element.setAttribute('data-e2e-pointer-type', event.pointerType),
          { once: true },
        )
      })
      await page.touchscreen.tap(x, y)
      await expect(control).toHaveAttribute('data-e2e-pointer-type', 'touch')
      await expect
        .poll(() => control.evaluate((element) => getComputedStyle(element).touchAction))
        .toBe('manipulation')
    }

    // Hold the pointer down long enough to observe the real rendered :active state
    // in both the desktop and Pixel-sized projects.
    await page.mouse.move(x, y)
    await page.mouse.down()
    await expect
      .poll(() => control.evaluate((element) => getComputedStyle(element).transform))
      .not.toBe('none')
    await page.mouse.up()
  })

  test('workflow create reports pending, success, and recoverable failure at its origin', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'workflow library is desktop shell chrome')
    let createRequests = 0
    await page.route('**/trpc/workflows.create*', async (route) => {
      createRequests += 1
      await new Promise((resolve) => setTimeout(resolve, 700))
      await route.continue()
    })
    await openShell(page)

    await page
      .getByTestId('desktop-topbar')
      .getByRole('button', { name: 'Workflows', exact: true })
      .click()
    await page.getByRole('button', { name: 'New workflow' }).click()

    const name = `Feedback workflow ${Date.now()}`
    await page.getByLabel('Name').fill(name)
    await page.getByLabel('Ordered steps (JSON)').fill('[]')
    const create = page.getByRole('button', { name: 'Create revision 1' })
    const widthBefore = await create.evaluate((element) => element.getBoundingClientRect().width)
    await create.click()
    const pending = page.getByRole('button', { name: 'Creating workflow…' })
    await expect(pending).toHaveAttribute('aria-busy', 'true')
    await expect(pending).toBeDisabled()
    await captureReviewShot(page, 'POD-228-workflow-pending.png')
    expect(await pending.evaluate((element) => element.getBoundingClientRect().width)).toBe(
      widthBefore,
    )
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 15_000 })
    expect(createRequests).toBe(1)

    await page.getByRole('button', { name: 'New workflow' }).click()
    await page.getByLabel('Name').fill('Invalid workflow')
    await page.getByLabel('Ordered steps (JSON)').fill('{ not-json')
    await page.getByRole('button', { name: 'Create revision 1' }).click()
    await expect(
      page.locator('p.text-destructive').filter({ hasText: /Unexpected|property name/i }),
    ).toBeVisible()
    await expect(page.getByLabel('Ordered steps (JSON)')).toHaveValue('{ not-json')
    await expect(page.getByRole('button', { name: 'Create revision 1' })).toBeEnabled()
  })
})
