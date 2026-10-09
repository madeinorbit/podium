/** One isolated sidebar/issue-page render from apps/web/dist. Run after the
 * normal production web build, on flatblock, with checkout-local Bun. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { chromium, expect } from '@playwright/test'

if (hostname() !== 'flatblock') throw new Error('Production render smoke runs on flatblock')
const port = 58222
const origin = `http://127.0.0.1:${port}`
mkdirSync('.artifacts', { recursive: true })
mkdirSync('.evidence/worklist-cleanup', { recursive: true })
const server = spawn(process.execPath, ['--conditions=@podium/source', 'tests/e2e/serve-harness.ts'], {
  env: { ...process.env, PORT: String(port), PODIUM_E2E_RUN_ID: `worklist-5822-${process.pid}` },
  stdio: ['ignore', openSync('.artifacts/production-smoke-server.log', 'w'), 'inherit'],
})
assert(server.pid)
writeFileSync('.artifacts/production-smoke-pids.json', JSON.stringify({ server: server.pid }))
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 500))
async function rpc<T>(procedure: string, input: object = {}, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const url = `${origin}/trpc/${procedure}${method === 'GET' ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`
  const response = await fetch(url, { method, ...(method === 'POST' ? {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  } : {}) })
  assert(response.ok, `${procedure}: ${response.status}`)
  const body = await response.json() as { result: { data: T } }
  return body.result.data
}
try {
  const deadline = Date.now() + 90_000
  for (;;) {
    if (server.exitCode !== null) throw new Error(`Harness exited ${server.exitCode}`)
    if (await fetch(`${origin}/health`).then(response => response.ok).catch(() => false)) break
    assert(Date.now() < deadline, 'Harness health deadline')
    await pause()
  }
  const repos = await rpc<string[]>('repos.list', {}, 'GET')
  const repoPath = repos.find(path => path.endsWith(`zz-podium-e2e-repo-${port}`))
  assert(repoPath, 'Isolated scratch repository is registered')
  const title = 'Worklist shared field smoke'
  const issue = await rpc<{ id: string }>('issues.create', { repoPath, title, startNow: false })
  await rpc('issues.update', { id: issue.id, patch: { stage: 'planning' } })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/?server=ws://127.0.0.1:${port}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, { timeout: 60_000 })
  const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true })
  await expect(expand.or(page.getByTestId('unified-issue-row').first()).first()).toBeVisible({ timeout: 60_000 })
  if (await expand.isVisible()) await expand.click()
  await expect(page.getByTestId('unified-issue-row').filter({ hasText: title })).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: '.evidence/worklist-cleanup/production-sidebar.png', fullPage: true })
  await page.goto(`${origin}/issues/${issue.id}?server=ws://127.0.0.1:${port}&e2e=1`)
  await expect(page.getByTestId('issue-page')).toContainText(title, { timeout: 60_000 })
  assert.deepEqual(errors, [], 'Production sidebar and issue page throw no renderer errors')
  await page.screenshot({ path: '.evidence/worklist-cleanup/production-sidebar-issue.png', fullPage: true })
  console.log(JSON.stringify({ sidebar: 'rendered', issuePage: 'rendered', rendererErrors: errors, production: true }))
} finally {
  await browser?.close()
  // This is the one server PID recorded above; its graceful harness shutdown
  // closes its daemon and server and reaps its own throwaway sessions.
  if (server.exitCode === null) {
    server.kill('SIGTERM')
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { server.kill('SIGKILL'); resolve() }, 15_000)
      server.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}
