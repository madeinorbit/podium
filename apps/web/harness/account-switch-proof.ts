/** Focused Chromium proof over the ordinary synthetic full-screen fixture.
 * Run on flatblock: bun apps/web/harness/account-switch-proof.ts
 * --plant-stale-handler retains the first real close-tab closure and must fail. */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium, expect, type Page } from '@playwright/test'
import { build } from 'vite'
import type {} from '../test/sidebar-acceptance.browser'
import config from './sidebar-acceptance.vite'

const args = process.argv.slice(2)
const planted = args.includes('--plant-stale-handler')
const sharedScopePlant = args.includes('--plant-shared-scope-callback')
const unkeyedPlant = args.includes('--plant-unkeyed-account')
const preserveState = args.includes('--preserve-state')
const pilotArg = args.find((arg) => arg.startsWith('--pilot='))?.slice(8)
if (pilotArg !== undefined && !['0', '1'].includes(pilotArg)) throw new Error('Invalid pilot arm')
const pilots = pilotArg === undefined ? [0, 1] : [Number(pilotArg)]
const out = resolve(
  args.find((arg) => arg.startsWith('--out='))?.slice(6) ?? '.artifacts/account-switch',
)
const buildDir = resolve(out, 'build')
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const switches = [
  'mobxSidebar',
  'mobxPane',
  'mobxSessionPane',
  'mobxChatContext',
  'mobxHeader',
  'mobxChips',
  'mobxCommands',
  'mobxNotices',
  'mobxShell',
  'mobxPreferences',
  'mobxSettings',
  'mobxWorkflows',
  'mobxBoard',
  'mobxSuperagent',
  'mobxAutomations',
  'mobxSpecs',
]
type Lifetime = {
  principal: string
  retired: { name: string; present: boolean; destroyed?: boolean }[]
}
declare global {
  interface Window {
    __accountLifetime(): Lifetime
    __accountEdit(): void
    __accountUiState(): Record<string, string | null>
    __accountArmBlurWriter(): boolean
    __accountBlurWrites: {
      principal: string
      writingPrincipal: string
      actualPrincipal: string
      destroyed: boolean
      value: string
    }[]
    __PODIUM_CLOSE_TAB__?: () => boolean
  }
}
if (hostname() !== 'flatblock') throw new Error('Account-switch proof runs on flatblock')
await mkdir(out, { recursive: true })
await build({
  ...config,
  configFile: false,
  logLevel: 'warn',
  plugins: [
    ...(config.plugins ?? []).filter(
      (plugin: any) => plugin?.name !== 'acceptance-state-boundaries',
    ),
    {
      name: 'account-lifetime-probe',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (unkeyedPlant && id.endsWith('/react/provider.tsx')) {
          const key = 'key={principalKey(principal)}'
          if (!code.includes(key)) throw new Error('Unkeyed account plant was not armed')
          return { code: code.replace(key, ''), map: null }
        }
        if (sharedScopePlant && id.endsWith('/app/Workspace.tsx')) {
          const close = '  const closeTab = (tabId: string): void => {'
          if (!code.includes(close)) throw new Error('Shared-scope callback plant was not armed')
          return {
            code:
              "import { useCallback as retainAccountCallback } from 'react';\n" +
              code.replace(
                close,
                '  const plantedSharedCallback = retainAccountCallback(() => closeFileTab, [])\n' +
                  '  ;(window as any).__plantedSharedScopeCallback ??= plantedSharedCallback\n' +
                  close,
              ),
            map: null,
          }
        }
        if (!id.endsWith('/test/sidebar-acceptance.browser.tsx')) return
        if (preserveState) {
          const marker = '{measured && <MeasurementBinding />}'
          if (!code.includes(marker)) throw new Error('Blur writer control was not armed')
          code = code.replace(marker, marker + '<AccountBlurWriter />')
        }
        // Observe identities through the fixture's existing WeakRefs. This probe
        // returns only scalars and never holds a runtime in a browser handle.
        return {
          code:
            code +
            `
      import { THEME_UI_KEYS as lifetimeThemeKeys, asSessionId as lifetimeSessionId } from '@podium/model/browser';
      import { useCurrentPrincipal as lifetimeCurrentPrincipal } from '@podium/client-core/react';
      const lifetimeBlurWrites: { principal: string; writingPrincipal: string; actualPrincipal: string; destroyed: boolean; value: string }[] = [];
      function AccountBlurWriter() {
        const principal = lifetimeCurrentPrincipal()!, handle = useStoreHandle();
        const write = useRuntimeSelector(s => s.setSessionDraft);
        return <input data-account-blur-writer tabIndex={-1} aria-hidden="true"
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
          defaultValue={principal.userId + ' on-blur write attempt'} ref={input => {
            // Native listeners exercise retirement even while React mutes its
            // delegated handlers during commit (editors may use native routing).
            if (input) input.onblur = () => {
              write(lifetimeSessionId(targets.phaseSessionId), input.value);
              lifetimeBlurWrites.push({ principal: principal.userId, writingPrincipal: handle.principal.userId,
                actualPrincipal: owner!.principal.userId, destroyed: handle.isDestroyed, value: input.value });
            };
          }} />;
      }
      Object.assign(window, { __accountLifetime: () => ({
        principal: owner?.principal.userId,
        retired: retired.map(({ name, ref }) => {
          const value = ref.deref();
          return { name, present: value !== undefined, destroyed: value?.destroyed };
        }),
      }), __accountBlurWrites: lifetimeBlurWrites, __accountArmBlurWriter: () => {
        const input = document.querySelector<HTMLInputElement>('[data-account-blur-writer]');
        if (!input) throw new Error('No blur writer input');
        input.focus(); return document.activeElement === input;
      }, __accountEdit: () => {
        flushSync(() => {
          owner!.getSnapshot().setSelectedIssueId(asIssueId(targets.visibleRootId));
          // Arm the workspace shown by this session, rather than an unrelated
          // issue's worktree that the next session-route hydration can replace.
          const worktree = owner!.getSnapshot().sessions.find(row => row.sessionId === targets.phaseSessionId)?.cwd;
          if (!worktree) throw new Error('No focused session worktree in synthetic kernel');
          owner!.getSnapshot().openSessionTab(lifetimeSessionId(targets.phaseSessionId));
          const s = owner!.getSnapshot(), ws = s.workspaces[s.workspaceKey()];
          s.splitWorkspacePane(ws.focusedPaneId, 'row', { tabId: targets.heartbeatSessionId });
          s.setSessionDraft(lifetimeSessionId(targets.phaseSessionId), 'Alice unsent chat draft');
          s.uiState.set('podium.firstTaskActivation.draft', JSON.stringify({ title: 'Alice first task', description: 'Unsent first task draft' }));
          s.uiState.set(lifetimeThemeKeys[0], 'light');
          // Keep the selected worktree aligned with the session on screen.
          s.setSelectedWorktree(worktree);
        });
      }, __accountUiState: () => {
        const s = owner!.getSnapshot();
        return { selectedIssueId: s.selectedIssueId, selectedWorktree: s.selectedWorktree,
          workspaceKey: s.workspaceKey(), layout: JSON.stringify(s.workspaces[s.workspaceKey()]),
          paneA: s.paneA, paneB: s.paneB, draft: s.drafts[targets.phaseSessionId] ?? '',
          firstTaskDraft: s.uiState.get('podium.firstTaskActivation.draft'), theme: s.uiState.get(lifetimeThemeKeys[0]) };
      } });\n`,
          map: null,
        }
      },
    },
  ],
  build: { ...config.build, outDir: buildDir, minify: 'esbuild', sourcemap: 'hidden' },
})
const server = createServer(async (request, response) => {
  try {
    const path = resolve(buildDir, '.' + new URL(request.url!, 'http://localhost').pathname)
    if (!path.startsWith(buildDir + '/')) {
      response.writeHead(403)
      response.end()
      return
    }
    const bytes = await readFile(path)
    response.setHeader(
      'Content-Type',
      (
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.woff2': 'font/woff2',
        } as Record<string, string>
      )[extname(path)] ?? 'application/octet-stream',
    )
    response.end(bytes)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PODIUM_CHROMIUM_PATH,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--expose-gc'],
})
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => window.__acceptance.settled())
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  )
}
const records: unknown[] = [],
  failures: string[] = []
try {
  for (const pilot of pilots) {
    const context = await browser.newContext({
      viewport: { width: 1800, height: 1000 },
      reducedMotion: 'reduce',
    })
    try {
      const page = await context.newPage(),
        errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (entry) => {
        if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:'))
          errors.push(entry.text())
      })
      await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      )
      const params = new URLSearchParams({ scale: '1', surface: 'full', panelMode: 'chat' })
      for (const key of switches) params.set(key, String(pilot))
      await page.goto(`${origin}/test/sidebar-acceptance.browser.html?${params}`)
      await page.waitForFunction(
        () => window.__acceptance?.ready() && !!window.__PODIUM_CLOSE_TAB__,
      )
      await settle(page)
      const startup = await page.evaluate(() => ({
        ...window.__acceptance.state(),
        mode: window.__acceptance.mode(),
      }))
      if (
        startup.issues !== 4867 ||
        startup.sessions !== 4302 ||
        startup.mode !== (pilot ? 'pool' : 'legacy')
      )
        throw new Error('Startup/corpus guard failed')
      for (const key of switches)
        if (startup.switches[key] !== String(pilot))
          throw new Error(`Missing startup switch ${key}`)
      const cdp = await context.newCDPSession(page)
      let initialUi: Record<string, string | null> | undefined
      if (preserveState) {
        await page.evaluate(() => window.__accountEdit())
        await settle(page)
        initialUi = await page.evaluate(() => window.__accountUiState())
        if (
          !initialUi.layout ||
          JSON.parse(initialUi.layout).root.kind !== 'split' ||
          !initialUi.draft ||
          !initialUi.firstTaskDraft
        )
          throw new Error(`State preservation control was not armed: ${JSON.stringify(initialUi)}`)
      }
      if (planted)
        await page.evaluate(() => {
          // Keep the actual installed handler, rather than planting a name in the
          // report. Its captured account must make the survivor guard go red.
          Object.assign(window, { __plantedStaleCloseTab: window.__PODIUM_CLOSE_TAB__ })
        })
      for (const principal of ['acceptance-bob', 'acceptance-alice']) {
        if (preserveState && !(await page.evaluate(() => window.__accountArmBlurWriter())))
          throw new Error('Blur writer did not receive real DOM focus')
        await page.evaluate((name) => window.__acceptance.show(name), principal)
        await page.waitForFunction(() => window.__acceptance.ready())
        await settle(page)
        // Playwright 1.60 keeps the last locator targets in its injected script.
        // Mark an empty set so collector-owned DOM cannot retain retired props.
        await expect(page.locator('[data-acceptance-no-such-target]')).toHaveCount(0)
        await page.mouse.move(1799, 999)
        // A real successor field focus replaces React's transient removed-field
        // selection owner. Do not manufacture events to reset private caches.
        await page
          .locator('textarea:visible, input:visible:not([data-account-blur-writer])')
          .first()
          .focus()
        await settle(page)
        const nextFocus = await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          connected: document.activeElement?.isConnected,
          type: (document.activeElement as HTMLInputElement)?.type,
        }))
        const beforeGc = await page.evaluate(() => window.__accountLifetime())
        if (beforeGc.principal !== principal) throw new Error('Actual principal did not change')
        if (
          beforeGc.retired.some(
            (row) => row.name.endsWith('.runtime') && row.present && !row.destroyed,
          )
        )
          throw new Error('Retired runtime was not destroyed')
        for (let round = 0; round < 5; round++) {
          await cdp.send('HeapProfiler.collectGarbage')
          await page.waitForTimeout(100)
          await settle(page)
        }
        const lifetime = await page.evaluate(() => window.__accountLifetime())
        const survivors = await page.evaluate(() => window.__acceptance.survivors())
        const state = await page.evaluate(() => window.__acceptance.state())
        const uiState = preserveState
          ? await page.evaluate(() => window.__accountUiState())
          : undefined
        const blurWrites = preserveState
          ? await page.evaluate(() => window.__accountBlurWrites)
          : undefined
        records.push({
          pilot,
          principal,
          beforeGc,
          lifetime,
          survivors,
          state,
          initialUi,
          uiState,
          blurWrites,
          nextFocus,
        })
        if (preserveState) {
          const write = blurWrites!.at(-1),
            retiredPrincipal =
              principal === 'acceptance-bob' ? 'acceptance-alice' : 'acceptance-bob'
          if (
            !write ||
            write.principal !== retiredPrincipal ||
            write.writingPrincipal !== retiredPrincipal ||
            write.actualPrincipal !== principal ||
            !write.destroyed
          )
            failures.push(`pilot=${pilot}: retiring blur writer ownership guard failed`)
          if (principal === 'acceptance-bob' && uiState!.draft !== '')
            failures.push(`pilot=${pilot}: Alice's blur wrote into Bob's draft`)
        }
        if (
          preserveState &&
          principal === 'acceptance-alice' &&
          JSON.stringify(uiState) !== JSON.stringify(initialUi)
        )
          failures.push(`pilot=${pilot}: returning account UI state changed`)
        console.log(JSON.stringify({ pilot, principal, survivors }))
        if (survivors.length) failures.push(`pilot=${pilot} ${principal}: ${survivors.join(', ')}`)
      }
      if (errors.length || (await page.evaluate(() => window.__acceptance.errors())).length)
        throw new Error(`Browser errors: ${errors.join('; ')}`)
    } finally {
      await context.close()
    }
  }
  await writeFile(
    resolve(out, 'report.json'),
    JSON.stringify(
      {
        sourceSha,
        browser: browser.version(),
        host: hostname(),
        seed: 4443,
        issues: 4867,
        sessions: 4302,
        switches,
        planted,
        sharedScopePlant,
        unkeyedPlant,
        preserveState,
        records,
        failures,
      },
      null,
      2,
    ) + '\n',
  )
  if (failures.length)
    throw new Error(`Account lifetime/state guard failed:\n${failures.join('\n')}`)
  console.log(
    `Account-switch proof passed: zero retired survivors in startup arms ${pilots.join(', ')}`,
  )
} finally {
  await browser.close()
  await new Promise<void>((done) => server.close(() => done()))
}
