/**
 * Photograph `harness/issue-records.html` (POD-6921): an issue page whose brief
 * and description come from the `issueBrief` and `issueDescription` records,
 * and an issue without either. Run from the repository root:
 *   bun apps/web/harness/capture-issue-records.ts [output-dir]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const output = process.argv[2] ?? '/tmp/issue-records'
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: 'apps/web/vite.harness.config.ts',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
})
await server.listen()
try {
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Missing harness address')
  const base = `http://127.0.0.1:${address.port}/harness/issue-records.html`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (error) => console.error(error.message))
    await page.goto(base)
    const brief = page.getByTestId('issue-brief')
    await brief.waitFor({ timeout: 30_000 }).catch(async (error) => {
      await page.screenshot({ path: join(output, 'capture-failure.png') })
      await writeFile(join(output, 'capture-failure.txt'), await page.locator('body').innerText())
      throw error
    })
    // The brief is folded by default; open it so the shot shows its text.
    await brief.locator('summary').click()
    await page.getByText('BRIEF FROM ITS OWN RECORD', { exact: false }).waitFor()
    await page.screenshot({ path: join(output, 'issue-records.png') })
    const evidence = {
      brief: await brief.innerText(),
      description: await page
        .getByText('issueDescription, loaded at start', { exact: false })
        .innerText(),
    }
    await page.goto(`${base}?issue=empty`)
    await page.getByText('Add a description…', { exact: true }).waitFor({ timeout: 30_000 })
    const empty = { briefShown: (await page.getByTestId('issue-brief').count()) > 0 }
    await page.screenshot({ path: join(output, 'issue-records-empty.png') })
    await writeFile(
      join(output, 'issue-records.json'),
      JSON.stringify({ evidence, empty }, null, 2),
    )
    console.log(JSON.stringify({ output, evidence, empty }))
  } finally {
    await browser.close()
  }
} finally {
  await server.close()
}
