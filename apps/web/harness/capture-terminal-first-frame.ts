import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const output = process.argv[2] ?? '/tmp/terminal-first-frame'
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: 'apps/web/vite.harness.config.ts',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
})
await server.listen()
try {
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Missing harness address')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', (error) => console.error(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/harness/terminal-first-frame.html?e2e=1`)
    await page.waitForFunction(() =>
      Boolean((window as unknown as { __podium?: unknown }).__podium),
    )
    const evidence = await page.evaluate(() => {
      const terminal = (
        window as unknown as {
          __podium: {
            grid(): { cols: number; rows: number }
            diagnostics(): { event: string; data: Record<string, unknown> }[]
          }
        }
      ).__podium
      const grid = terminal.grid()
      const diagnostics = terminal.diagnostics()
      const first = diagnostics.find((entry) => entry.event === 'mount')
      const label = document.getElementById('first-frame-reading')
      if (label)
        label.textContent = `Measured first grid: ${grid.cols} × ${grid.rows} · before attach`
      return { grid, first, diagnostics }
    })
    if (evidence.grid.cols !== 132 || evidence.grid.rows !== 43)
      throw new Error(`Wrong birth grid: ${JSON.stringify(evidence)}`)
    if (
      JSON.stringify(evidence.first?.data.initialGeometry) !==
      JSON.stringify({ cols: 132, rows: 43 })
    )
      throw new Error(`Missing model geometry at mount: ${JSON.stringify(evidence.first)}`)
    await writeFile(join(output, 'first-frame.json'), JSON.stringify(evidence, null, 2))
    await page.screenshot({ path: join(output, 'first-frame.png') })
    console.log(JSON.stringify({ output, grid: evidence.grid, first: evidence.first }))
    await page.goto(`http://127.0.0.1:${address.port}/harness/terminal-first-frame.html?view=issue`)
    await page.getByText('Snapshot attachment', { exact: true }).waitFor()
    await page.reload()
    const artifact = page.getByTestId('issue-artifacts')
    await artifact.getByText('Snapshot attachment', { exact: true }).waitFor()
    await artifact.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(output, 'issue-reload.png') })
    await writeFile(
      join(output, 'issue-reload.json'),
      JSON.stringify(
        {
          reloaded: true,
          artifacts: await artifact.innerText(),
        },
        null,
        2,
      ),
    )
    console.log('Reloaded issue page shows its snapshot attachment')
  } finally {
    await browser.close()
  }
} finally {
  await server.close()
}
