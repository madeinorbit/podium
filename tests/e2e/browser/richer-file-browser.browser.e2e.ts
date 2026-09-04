import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { openHome } from './_harness'

const RECORD_WALKTHROUGH = process.env.PODIUM_RECORD_FILE_BROWSER === '1'
const PORT = Number(process.env.PORT ?? 8799)

test.use({
  video: RECORD_WALKTHROUGH
    ? {
        mode: 'on',
        size: { width: 1280, height: 820 },
        show: {
          actions: { duration: 900, position: 'bottom-right', fontSize: 14 },
          test: { level: 'step', position: 'top-left', fontSize: 18 },
        },
      }
    : 'retain-on-failure',
})

test.skip(({ isMobile }) => isMobile, 'desktop file-browser walkthrough')
test.setTimeout(120_000)

async function openWorkspace(page: Page): Promise<void> {
  await openHome(page)
  const hideUpdate = page.getByRole('button', { name: 'Hide' })
  const updateVisible = await hideUpdate
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  if (updateVisible) await hideUpdate.click()

  const closePrompt = page.getByRole('button', { name: 'Close the prompt' })
  if (await closePrompt.isVisible().catch(() => false)) await closePrompt.click()
  const launch = page.getByTestId('cold-start-launch')
  await expect(launch).toBeEnabled({ timeout: 30_000 })
  await launch.click()
  await expect(page.locator('button[aria-label="New panel"]:visible')).toBeVisible({
    timeout: 30_000,
  })
}

async function pauseForWalkthrough(page: Page, milliseconds = 900): Promise<void> {
  if (RECORD_WALKTHROUGH) await page.waitForTimeout(milliseconds)
}

test('richer file browser finds and previews image and tabular files', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openWorkspace(page)
  const fixtureDir = join(tmpdir(), `zz-podium-e2e-repo-${PORT}`, 'e2e-file-browser')

  await mkdir(fixtureDir, { recursive: true })
  await writeFile(
    join(fixtureDir, '2-landscape.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#315c9e"/><stop offset="1" stop-color="#111827"/></linearGradient></defs>
      <rect width="640" height="360" fill="url(#sky)"/>
      <circle cx="505" cy="82" r="42" fill="#f5c518"/>
      <path d="M0 278 150 126l92 92 84-80 194 140z" fill="#18283e"/>
      <path d="M118 278 282 110l220 168z" fill="#264261"/>
      <text x="32" y="326" fill="#f2f3f5" font-family="system-ui" font-size="28" font-weight="600">Podium image preview</text>
    </svg>`,
  )
  await writeFile(
    join(fixtureDir, '10-projects.csv'),
    [
      'name,status,files',
      'Atlas,Active,128',
      'Beacon,Blocked,42',
      'Comet,Review,76',
      'Delta,Active,19',
    ].join('\n'),
  )
  await writeFile(join(fixtureDir, 'config.json'), '{"theme":"dark","density":"compact"}\n')

  try {
    const filesButton = page.getByRole('button', { name: 'Files' })
    await test.step('Open the repository file browser', async () => {
      await filesButton.click()
      const panel = page.locator('[data-right-dock-panel="files"]')
      await expect(panel).toBeVisible()
      await expect(panel.getByPlaceholder('Search files  /')).toBeVisible()
      await pauseForWalkthrough(page)
    })

    const panel = page.locator('[data-right-dock-panel="files"]')
    await test.step('Inspect natural sorting and file-type icons', async () => {
      await panel.locator('[title="e2e-file-browser"]').click()
      const imageRow = panel.locator('[title^="2-landscape.svg"]')
      const tableRow = panel.locator('[title^="10-projects.csv"]')
      await expect(imageRow).toBeVisible()
      await expect(tableRow).toBeVisible()
      await expect(imageRow.locator('svg.lucide-file-image')).toBeVisible()
      await expect(tableRow.locator('svg.lucide-sheet')).toBeVisible()
      const imageBox = await imageRow.boundingBox()
      const tableBox = await tableRow.boundingBox()
      if (!imageBox || !tableBox) throw new Error('file rows have no layout boxes')
      expect(imageBox.y).toBeLessThan(tableBox.y)
      await pauseForWalkthrough(page, 1_200)
    })

    const search = panel.getByPlaceholder('Search files  /')
    await test.step('Quick-open an untracked image with keyboard search', async () => {
      await panel.locator('[title^="2-landscape.svg"]').press('/')
      await expect(search).toBeFocused()
      await search.fill('landscape')
      await expect(panel.getByRole('option', { name: /2-landscape\.svg/ })).toBeVisible()
      await pauseForWalkthrough(page)
      await search.press('Enter')
      const image = page.getByRole('img', { name: '2-landscape.svg' })
      await expect(image).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText('640 × 360')).toBeVisible()
      await pauseForWalkthrough(page, 1_200)
    })

    await test.step('Zoom and refit the image preview', async () => {
      await page.getByRole('button', { name: 'Show image at actual size' }).click()
      await expect(page.getByRole('button', { name: 'Show image at actual size' })).toHaveText(
        '100%',
      )
      await page.getByRole('button', { name: 'Zoom in' }).click()
      await expect(page.getByRole('button', { name: 'Show image at actual size' })).toHaveText(
        '125%',
      )
      await pauseForWalkthrough(page)
      await page.getByRole('button', { name: 'Fit image to window' }).click()
      await pauseForWalkthrough(page)
    })

    await test.step('Search, filter, and sort a CSV as a table', async () => {
      await search.fill('projects')
      await expect(panel.getByRole('option', { name: /10-projects\.csv/ })).toBeVisible()
      await search.press('Enter')
      const table = page.getByTestId('table-file-viewer')
      await expect(table).toBeVisible({ timeout: 15_000 })
      await expect(table).toContainText('Atlas')
      await pauseForWalkthrough(page)

      const filter = page.getByPlaceholder('Filter rows')
      await filter.fill('blocked')
      await expect(table).toContainText('Beacon')
      await expect(table).not.toContainText('Atlas')
      await expect(page.getByText('1 of 4 rows')).toBeVisible()
      await pauseForWalkthrough(page)

      await page.getByRole('button', { name: 'Clear row filter' }).click()
      await table.getByRole('button', { name: 'name', exact: true }).click()
      await expect(page.getByRole('columnheader', { name: /name/ })).toHaveAttribute(
        'aria-sort',
        'ascending',
      )
      await pauseForWalkthrough(page)
    })

    await test.step('Switch between table and editable source', async () => {
      await page.getByRole('button', { name: 'Source' }).click()
      await expect(page.locator('.cm-editor')).toBeVisible()
      await expect(page.locator('.cm-content')).toContainText('name,status,files')
      await pauseForWalkthrough(page, 1_200)
      await page.getByRole('button', { name: 'Table' }).click()
      await expect(page.getByTestId('table-file-viewer')).toBeVisible()
      await pauseForWalkthrough(page, 1_200)
    })
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})
