/**
 * LIVE verification for #170 Fix 1 (selected row not bold) + Fix 3 (issue rename
 * by double-click). Isolated podium serving the built web, driven by a real
 * browser. Run: node --conditions=@podium/source --import tsx tests/e2e/verify-sidebar-ux.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { ConversationDiscoveryCache } from '@podium/agent-bridge'
import { agentLaunchCommand, type LaunchOptions, type LaunchSpec } from '@podium/agent-bridge'
import type { AgentKind } from '@podium/protocol'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { runIndexRefreshJob, runMemoryBreakdownJob } from '../../apps/daemon/src/discovery-jobs'
import type { WorkerJob } from '../../apps/daemon/src/discovery-worker'
import { DiscoveryWorkerClient, type WorkerLike } from '../../apps/daemon/src/worker-client'
import { LOCAL_MACHINE_ID } from '../../apps/server/src/local-machine'
import { startServer } from '../../apps/server/src/server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

const PORT = Number(process.env.PORT ?? 18898)
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const log = (...a: unknown[]) => console.log('[verify]', ...a)

function inlineWorkerClient(): DiscoveryWorkerClient {
  return new DiscoveryWorkerClient({
    spawn: (): WorkerLike => {
      const handlers: Array<(m: unknown) => void> = []
      let cache: ConversationDiscoveryCache | undefined
      const ic = (p?: string) => (cache ??= new ConversationDiscoveryCache(p))
      return {
        postMessage(m: unknown) {
          const job = m as WorkerJob
          void (async () => {
            try {
              const value =
                job.kind === 'memoryBreakdown'
                  ? runMemoryBreakdownJob(job.input)
                  : await runIndexRefreshJob(job.input, ic(job.input.cachePath))
              for (const h of handlers) h({ id: job.id, ok: true, value })
            } catch (err) {
              for (const h of handlers)
                h({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          })()
        },
        on(ev, cb) {
          if (ev === 'message') handlers.push(cb)
        },
        terminate() {
          cache = undefined
        },
      }
    },
  })
}

async function main() {
  process.env.PODIUM_NO_SCOPE = '1'
  process.env.PODIUM_PTY_BACKEND = 'node-pty'
  reapHarnessSessions(PORT)
  const { stateDir } = applyHarnessEnv(PORT)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(`${stateDir}/repos.json`, JSON.stringify([REPO_ROOT]))
  writeFileSync(`${stateDir}/config.json`, JSON.stringify({ mode: 'all-in-one' }))

  const KEYECHO_CLI = fileURLToPath(new URL('../keyecho/src/cli.tsx', import.meta.url))
  const KEYECHO_PKG = fileURLToPath(new URL('../keyecho', import.meta.url))
  const launch = (kind: AgentKind, opts: LaunchOptions): LaunchSpec =>
    kind === 'shell'
      ? agentLaunchCommand(kind, opts)
      : { cmd: process.execPath, args: ['--import', 'tsx', KEYECHO_CLI, '--mode', 'both'], cwd: KEYECHO_PKG }

  const server = await startServer({ port: PORT })
  const daemon = await startDaemon({
    serverUrl: `ws://localhost:${server.port}`,
    bootstrapToken: server.bootstrapToken,
    machineId: LOCAL_MACHINE_ID,
    launch,
    workerClient: inlineWorkerClient(),
  })

  const issues = server.registry.issues
  const iss = issues.create({ repoPath: REPO_ROOT, title: 'Original Title', origin: 'human' })
  server.registry.createSession({ agentKind: 'claude-code', cwd: REPO_ROOT, issueId: iss.id })
  await new Promise((r) => setTimeout(r, 1000))

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  page.on('pageerror', (e) => log('  page.error:', e.message))
  await page.addInitScript(() => localStorage.setItem('podium.sidebarLayout', 'unified'))
  await page.goto(`http://localhost:${PORT}/?server=ws://localhost:${PORT}`, { waitUntil: 'domcontentloaded' })

  const row = page.getByText('Original Title').first()
  await row.waitFor({ timeout: 30_000 })

  // ── Fix 1: select the row, assert the label is NOT bold (accent bg conveys it).
  await row.click()
  await page.waitForTimeout(500)
  const weight = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'))
    const el = spans.find((s) => s.textContent === 'Original Title') as HTMLElement | undefined
    if (!el) return null
    const btn = el.closest('button') as HTMLElement | null
    return {
      labelWeight: getComputedStyle(el).fontWeight,
      btnBg: btn ? getComputedStyle(btn).backgroundColor : null,
    }
  })
  const bold = weight && Number(weight.labelWeight) >= 600
  const fix1Pass = weight != null && !bold
  log(`FIX 1 selected≠bold: label fontWeight=${weight?.labelWeight} → ${fix1Pass ? 'PASS' : 'FAIL'}`)

  // ── Fix 3: double-click → inline editor seeded+selected → type → Enter commits.
  await row.dblclick()
  await page.locator('input').first().waitFor({ timeout: 5000 })
  const selInfo = await page.evaluate(() => {
    const i = document.activeElement as HTMLInputElement | null
    return i && i.tagName === 'INPUT'
      ? { focused: true, start: i.selectionStart, end: i.selectionEnd, len: i.value.length, value: i.value }
      : { focused: false }
  })
  // Focused with select-all → typing replaces the whole name, then Enter commits.
  await page.keyboard.type('Renamed Live')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const serverTitle = issues.get(iss.id)?.title
  const domRenamed = (await page.getByText('Renamed Live').count()) > 0
  const fix3Pass =
    selInfo.focused &&
    selInfo.start === 0 &&
    selInfo.end === selInfo.len &&
    serverTitle === 'Renamed Live' &&
    domRenamed
  log(
    `FIX 3 rename: focus+selectAll=${JSON.stringify(selInfo)} serverTitle="${serverTitle}" domShowsRenamed=${domRenamed} → ${fix3Pass ? 'PASS' : 'FAIL'}`,
  )

  const pass = fix1Pass && fix3Pass
  log(pass ? 'RESULT: PASS (both fixes verified live)' : 'RESULT: FAIL')
  try {
    await browser.close()
  } catch {}
  try {
    await daemon.close({ reapSessions: true })
  } catch {}
  try {
    await server.close()
  } catch {}
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('[verify] fatal', e)
  process.exit(3)
})
