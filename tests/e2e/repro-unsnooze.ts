/**
 * LIVE reproduction + proof for #170 Fix 2 — the stuck "Unsnoozed" tag.
 *
 * Stands up an ISOLATED podium (own port + state dir, node-pty, no scope) that
 * serves the built web same-origin, seeds one repo + one issue with a session,
 * snoozes then UNSNOOZES it (so it enters returned-from-defer with the tag), then
 * drives a real browser to OPEN the issue and asserts the tag clears — the exact
 * flow the user reports sticking.
 *
 * Root cause (found via this repro): the client replica's `replaceContents` used
 * `delete draft[k]` inside a TanStack DB update draft, which is a change-tracking
 * proxy that IGNORES deletes — so an issue's `deferUntil` going present→absent (the
 * unsnooze clear) never applied, and the tag never cleared. The server clears it
 * correctly; only the client render stuck. Fix: assign `undefined` (tracked) rather
 * than delete. This script FAILS (tag STUCK) on the old code and PASSES on the fix.
 *
 * Run: node --conditions=@podium/source --import tsx tests/e2e/repro-unsnooze.ts
 * Requires the web to be built first (apps/web/dist): `bun run --filter @podium/web build`.
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

const PORT = Number(process.env.PORT ?? 18899)
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const log = (...a: unknown[]) => console.log('[repro]', ...a)

// Discovery jobs inline on the main thread (this harness runs under node --import
// tsx, where worker threads can't resolve the TS worker) — mirrors serve-harness.
function inlineWorkerClient(): DiscoveryWorkerClient {
  return new DiscoveryWorkerClient({
    spawn: (): WorkerLike => {
      const handlers: Array<(m: unknown) => void> = []
      let cache: ConversationDiscoveryCache | undefined
      const indexCache = (p?: string): ConversationDiscoveryCache => {
        if (!cache) cache = new ConversationDiscoveryCache(p)
        return cache
      }
      return {
        postMessage(m: unknown) {
          const job = m as WorkerJob
          void (async () => {
            try {
              const value =
                job.kind === 'memoryBreakdown'
                  ? runMemoryBreakdownJob(job.input)
                  : await runIndexRefreshJob(job.input, indexCache(job.input.cachePath))
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

  // Non-shell kinds spawn the keyecho jig (no real agent / no quota); the issue only
  // needs a NON-shell session to surface in the WORK list (shells are excluded).
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
    hooks: { port: 0 },
    agentRelay: { port: 0 },
    launch,
    workerClient: inlineWorkerClient(),
  })
  log(`server on :${server.port}, state=${stateDir}`)

  const issues = server.registry.issues
  const created = issues.create({ repoPath: REPO_ROOT, title: 'Repro Unsnooze Tag', origin: 'human' })
  server.registry.createSession({ agentKind: 'claude-code', cwd: REPO_ROOT, issueId: created.id })
  // The exact user flow: snooze (future) then Unsnooze — undefer backdates deferUntil,
  // landing the issue in returned-from-defer (top of WORK + "Unsnoozed" tag).
  issues.defer(created.id, new Date(Date.now() + 60 * 60 * 1000).toISOString())
  issues.undefer(created.id)
  await new Promise((r) => setTimeout(r, 1000))

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  page.on('pageerror', (e) => log('  page.error:', e.message))
  await page.addInitScript(() => localStorage.setItem('podium.sidebarLayout', 'unified'))

  await page.goto(`http://localhost:${PORT}/?server=ws://localhost:${PORT}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.getByText('Repro Unsnooze Tag').first().waitFor({ timeout: 30_000 })

  // Control: a live server change reaches the DOM (rules out a dead-socket artifact).
  issues.update(created.id, { title: 'Repro Unsnooze Tag RENAMED' })
  let controlOk = false
  try {
    await page.getByText('Repro Unsnooze Tag RENAMED').first().waitFor({ timeout: 8000 })
    controlOk = true
  } catch {}
  log('CONTROL (live server change reflected in DOM):', controlOk)

  const tagBefore = await page.getByText('Unsnoozed', { exact: true }).count()
  log('tag visible BEFORE open:', tagBefore)
  if (tagBefore === 0) {
    log('SETUP FAIL: the Unsnoozed tag never rendered.')
    await shutdown(browser, daemon, server)
    process.exit(2)
  }

  // OPEN the issue (the user's exact action) → should fire the defer(null) clear.
  await page.getByText('Repro Unsnooze Tag').first().click()
  await page.waitForTimeout(3000)

  const tagAfter = await page.getByText('Unsnoozed', { exact: true }).count()
  const serverDefer = issues.get(created.id)?.deferUntil ?? null
  log('tag visible AFTER open:', tagAfter, '| server deferUntil:', serverDefer)

  const pass = tagAfter === 0 && serverDefer == null
  log(
    pass
      ? 'RESULT: PASS — tag cleared in DOM and deferUntil cleared server-side.'
      : `RESULT: REPRODUCED BUG — dom tag ${tagAfter === 0 ? 'cleared' : 'STUCK'}, server deferUntil ${serverDefer == null ? 'cleared' : `STUCK (${serverDefer})`}.`,
  )
  await shutdown(browser, daemon, server)
  process.exit(pass ? 0 : 1)
}

async function shutdown(browser: any, daemon: any, server: any) {
  try {
    await browser.close()
  } catch {}
  try {
    await daemon.close({ reapSessions: true })
  } catch {}
  try {
    await server.close()
  } catch {}
}

main().catch((e) => {
  console.error('[repro] fatal', e)
  process.exit(3)
})
