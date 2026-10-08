/** Production-rendered, isolated sidebar search regression. No live backend. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { build } from 'vite'
import type {} from '../test/sidebar-renderer.browser'

const out = resolve('.artifacts/sidebar-search')
await mkdir(out, { recursive: true })
await build({
  configFile: resolve('apps/web/vite.sidebar-pool-perf.config.ts'),
  mode: 'production',
  build: {
    outDir: resolve(out, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('apps/web/test/sidebar-renderer.browser.html') },
  },
})
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const file = Bun.file(resolve(out, `dist.${path}`))
    return await file.exists() ? new Response(file) : new Response('Missing', { status: 404 })
  },
})
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, reducedMotion: 'no-preference' })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.port}/test/sidebar-renderer.browser.html?rows=80`)
  await page.waitForFunction(() => window.__sidebarRenderer?.ready())
  await expect(page.getByText('Only responsive target')).toBeVisible()
  await page.getByTestId('work-scroll').evaluate(node => { node.scrollTop = 1200 })
  await page.waitForTimeout(100)
  await page.getByTestId('work-search-input').fill('synthetic task 1')
  await expect(page.getByTestId('work-search-count')).toHaveText('11/76')
  await page.waitForTimeout(1000)
  const paint = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('[data-testid="project-group"]')].map(node => ({ text: node.textContent, rect: node.getBoundingClientRect().toJSON(), style: node.getAttribute('style') })),
    windows: [...document.querySelectorAll('[data-testid="worklist-window"]')].map(node => ({ text: node.textContent, rect: node.getBoundingClientRect().toJSON(), count: node.getAttribute('data-window-count'), mounted: node.querySelectorAll('[data-window-row]').length })),
    scroll: document.querySelector('[data-testid="work-scroll"]')?.scrollTop,
  }))
  await page.screenshot({ path: resolve(out, 'search.png') })
  await writeFile(resolve(out, 'paint.json'), JSON.stringify({ paint, errors }, null, 2))
  console.log(JSON.stringify({ paint, errors }))
  await expect(page.getByText('Synthetic task 10', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
  console.log('Production sidebar search smoke green')
} finally {
  await browser.close()
  server.stop(true)
}
