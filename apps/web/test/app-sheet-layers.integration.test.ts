import { fileURLToPath } from 'node:url'
import { chromium, expect as expectBrowser } from '@playwright/test'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

it('keeps utility sheet controls clickable over an update offer until the sheet closes', async () => {
  const appRoot = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root: appRoot,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'app-sheet-layers-fixture',
        configureServer(vite) {
          vite.middlewares.use('/sheet-test', async (_request, response) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(
              await vite.transformIndexHtml(
                '/sheet-test',
                '<div id="root"></div><script type="module" src="/test/app-sheet-layers.browser.tsx"></script>',
              ),
            )
          })
        },
      },
    ],
    resolve: { alias: { '@': `${appRoot}src` }, dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${server.resolvedUrls!.local[0]}sheet-test`)
    const offer = page.getByRole('dialog', { name: 'Podium update' })
    await expectBrowser(offer).toBeVisible()

    for (const label of ['Settings', 'Usage']) {
      await page.getByRole('button', { name: `Open ${label}` }).click()
      const sheet = page.getByRole('dialog', { name: label, exact: true })
      const control = sheet.getByRole('button', { name: 'Sheet control' })
      await expectBrowser(sheet).toHaveAttribute('aria-modal', 'true')
      await expectBrowser(control).toBeVisible()
      await expectBrowser(offer).toBeVisible()
      // Non-vacuity: the control's click point must be inside the offer's box.
      const controlBox = await control.boundingBox()
      const offerBox = await offer.boundingBox()
      expect(controlBox).not.toBeNull()
      expect(offerBox).not.toBeNull()
      const x = controlBox!.x + controlBox!.width / 2
      const y = controlBox!.y + controlBox!.height / 2
      expect(x).toBeGreaterThan(offerBox!.x)
      expect(x).toBeLessThan(offerBox!.x + offerBox!.width)
      expect(y).toBeGreaterThan(offerBox!.y)
      expect(y).toBeLessThan(offerBox!.y + offerBox!.height)

      const before = await control.getAttribute('aria-pressed')
      await control.click()
      await expectBrowser(control).toHaveAttribute('aria-pressed', String(before !== 'true'))
      await sheet.getByRole('button', { name: `Close ${label.toLowerCase()}` }).click()
      await expectBrowser(sheet).toHaveCount(0)
    }

    // No implicit dismissal: the same offer remains usable after closing.
    await offer.getByRole('button', { name: 'Later' }).click()
    await expectBrowser(offer).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await server.close()
  }
}, 60_000)
