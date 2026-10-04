/** Live sidebar capture. Credentials remain in memory; raw evidence stays on ludovico. */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname, loadavg } from 'node:os'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { type CDPSession, chromium, type Page } from '@playwright/test'
import { createLogger, preview } from 'vite'
import { installCommitObserver, startCpu } from './full-screen-profile'

/** Capture only function coordinates. A module closure can contain hundreds
 * of imports; walking every imported function stalls after the timed clicks. */
async function saveComponents(page: Page, cdp: CDPSession, path: string) {
  const names = await page.evaluate(() => window.__speedFunctionNames)
  const scripts = new Map<string, string>()
  const parsed = (script: any) => scripts.set(script.scriptId, script.url)
  cdp.on('Debugger.scriptParsed', parsed)
  await cdp.send('Debugger.enable')
  try {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'window.__speedFunctions',
      objectGroup: 'live-components',
    })
    const array = await cdp.send('Runtime.getProperties', {
      objectId: result.objectId,
      ownProperties: true,
    })
    const functions = array.result.filter((entry: any) => /^\d+$/.test(entry.name))
    const components = []
    for (let at = 0; at < functions.length; at += 16) {
      components.push(
        ...(await Promise.all(
          functions.slice(at, at + 16).map(async (entry: any) => {
            const props = await cdp.send('Runtime.getProperties', {
              objectId: entry.value.objectId,
            })
            const location = props.internalProperties?.find(
              (p: any) => p.name === '[[FunctionLocation]]',
            )?.value?.value
            const wrappedFunctions = []
            if (!names[Number(entry.name)]) {
              const scopesId = props.internalProperties?.find((p: any) => p.name === '[[Scopes]]')
                ?.value?.objectId
              if (scopesId) {
                const scopes = await cdp.send('Runtime.getProperties', { objectId: scopesId })
                const closure = scopes.result.find((p: any) =>
                  p.value?.description?.startsWith('Closure'),
                )
                if (closure?.value?.objectId) {
                  const variables = await cdp.send('Runtime.getProperties', {
                    objectId: closure.value.objectId,
                  })
                  const candidates = variables.result.filter(
                    (p: any) => p.value?.type === 'function',
                  )
                  // A render wrapper owns a small closure; a whole module does not.
                  if (candidates.length <= 8)
                    for (const candidate of candidates) {
                      const fields = await cdp.send('Runtime.getProperties', {
                        objectId: candidate.value.objectId,
                      })
                      const original = fields.internalProperties?.find(
                        (p: any) => p.name === '[[FunctionLocation]]',
                      )?.value?.value
                      if (original)
                        wrappedFunctions.push({
                          ...original,
                          url: scripts.get(original.scriptId) ?? '',
                        })
                    }
                }
              }
            }
            return {
              id: Number(entry.name),
              name: names[Number(entry.name)],
              ...location,
              url: scripts.get(location?.scriptId) ?? '',
              wrappedFunctions,
            }
          }),
        )),
      )
    }
    await writeFile(path, JSON.stringify(components))
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'live-components' })
    await cdp.send('Debugger.disable')
    cdp.off('Debugger.scriptParsed', parsed)
  }
}

if (hostname() !== 'ludovico') throw new Error('Live evidence must stay on ludovico')
const label = process.argv.find((a) => a.startsWith('--label='))?.slice(8) ?? 'baseline'
const inspect = process.argv.includes('--inspect')
const buildDir = resolve(
  process.argv.find((a) => a.startsWith('--build-dir='))?.slice(12) ?? 'apps/web/dist',
)
const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice(8) ?? 20)
const closeMeter = process.argv.includes('--close-meter')
const timingOnly = process.argv.includes('--timing-only')
const verifyMenu = process.argv.includes('--verify-menu')
const issuePageAction = process.argv.includes('--issue-page-action')
const sourceSha =
  process.argv.find((a) => a.startsWith('--source-sha='))?.slice(13) ??
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const targetsPath = process.argv.find((a) => a.startsWith('--targets='))?.slice(10)
console.log(JSON.stringify({ pid: process.pid, label }))
const root = resolve('.artifacts/live-sidebar', label)
await mkdir(root, { recursive: true })
process.env.PODIUM_WEB_PORT = '55619'
const logger = createLogger('silent')
// Vite's proxy errors include RPC query parameters. Keep failures as counts,
// never stream the operator's identifiers or content into command output.
let proxyErrors = 0
const proxyErrorKinds: Record<string, number> = {}
logger.error = (message) => {
  proxyErrors++
  const kind =
    message.match(/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOSPC)\b/)?.[0] ?? 'unclassified'
  proxyErrorKinds[kind] = (proxyErrorKinds[kind] ?? 0) + 1
}
const server = await preview({
  root: resolve('apps/web'),
  configFile: resolve('apps/web/vite.config.ts'),
  customLogger: logger,
  build: { outDir: buildDir },
  preview: { host: '127.0.0.1', port: 55619, strictPort: true },
})
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  serviceWorkers: 'block',
})
let capturePage: Awaited<ReturnType<typeof context.newPage>> | undefined
let captureCdp: Awaited<ReturnType<typeof context.newCDPSession>> | undefined
const startupErrors: string[] = []
const responseFailures = new Map<number, number>()
try {
  const token = execFileSync('podium', ['auth', 'mint-session', '--ttl', '2h', '--print-only'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  await context.addCookies([
    {
      name: 'podium_session',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  const page = await context.newPage()
  capturePage = page
  page.on('pageerror', (error) =>
    startupErrors.push(String(error.stack).replaceAll(token, '[redacted]')),
  )
  page.on('response', (response) => {
    if (response.status() >= 400)
      responseFailures.set(response.status(), (responseFailures.get(response.status()) ?? 0) + 1)
  })
  if (timingOnly) {
    await page.addInitScript(() => {
      window.__speedReact = { renderer: null, commits: [] }
      window.__speedFunctionNames = []
      window.__speedFunctions = []
    })
  } else await installCommitObserver(page, true)
  await page.addInitScript(() => {
    localStorage.setItem('podium.panelMode', 'chat')
    const state = {
      input: null as number | null,
      dom: null as number | null,
      twoRaf: false,
      twoRafAt: 0,
      target: '',
      trigger: '',
      pageAction: false,
      processingStart: 0,
      events: [] as unknown[],
      mutations: [] as number[],
      lastContentDom: 0,
      deckPending: false,
      deckReadyAt: 0,
    }
    Object.assign(window, { __speedCapture: state })
    new PerformanceObserver((list) =>
      state.events.push(...list.getEntries().map((e) => e.toJSON())),
    ).observe({ type: 'event', durationThreshold: 16, buffered: true })
    document.addEventListener(
      'click',
      (e) => {
        if (!state.target || !(e.target instanceof Element) || !e.target.closest(state.trigger))
          return
        state.input = e.timeStamp
        state.processingStart = performance.now()
        performance.mark('speed:input', { startTime: e.timeStamp })
        performance.mark('speed:handler')
      },
      true,
    )
    new MutationObserver(() => {
      if (state.input === null || state.dom !== null) return
      const row =
        document.querySelector(`[data-issue-row="${state.target}"]`) ??
        (state.trigger ? document.querySelector(state.trigger) : null)
      if (
        state.pageAction
          ? !document.querySelector('[data-testid="issue-page"]')
          : !row || row.getAttribute('data-selected') !== 'true'
      )
        return
      state.dom = performance.now()
      performance.mark('speed:dom')
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          state.twoRaf = true
          state.twoRafAt = performance.now()
        }),
      )
    }).observe(document, { subtree: true, attributes: true, childList: true, characterData: true })
    new MutationObserver((records) => {
      if (state.input === null) return
      const deckPending = Boolean(document.querySelector('[data-testid="flight-settling"]'))
      if (state.deckPending && !deckPending) state.deckReadyAt = performance.now()
      state.deckPending = deckPending
      if (
        records.some((r) =>
          (r.target instanceof Element ? r.target : r.target.parentElement)?.closest(
            '[data-panel-resident][data-pane], [data-testid="flight-deck-scroller"], [data-testid="right-rail"], [data-testid="issue-page"]',
          ),
        )
      ) {
        state.lastContentDom = performance.now()
        state.mutations.push(state.lastContentDom)
      }
    }).observe(document, { subtree: true, attributes: true, childList: true, characterData: true })
  })
  await page.goto('http://127.0.0.1:55619/?e2e=1&switchTrace=1', { waitUntil: 'domcontentloaded' })
  await page
    .locator('[data-issue-row]')
    .first()
    .waitFor({
      timeout: Number(
        process.argv.find((a) => a.startsWith('--startup-timeout='))?.slice(18) ?? 180_000,
      ),
    })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(10_000)
  if (process.argv.includes('--expand-closed')) {
    const closed = page.getByTestId('closed-fold-toggle')
    if (
      (await closed.count()) &&
      (await closed.first().getAttribute('aria-expanded')) === 'false'
    ) {
      await closed.first().click()
      await page.waitForTimeout(1000)
    }
  }
  const cdp = await context.newCDPSession(page)
  captureCdp = cdp
  const idleMs = Number(process.argv.find((a) => a.startsWith('--idle-ms='))?.slice(10) ?? 0)
  if (idleMs > 0) {
    const before = await page.evaluate(() => ({
      perf: (window as any).__podiumSidebarPerf?.read(),
      shell: (window as any).__liveShellCensus?.(),
      launch: (window as any).__liveLaunchCensus?.(),
      chat: (window as any).__liveChatCensus?.(),
      pool: (window as any).__livePoolCensus?.(),
    }))
    const stopIdle = await startCpu(cdp)
    await page.waitForTimeout(idleMs)
    const profile = await stopIdle()
    const after = await page.evaluate(() => ({
      perf: (window as any).__podiumSidebarPerf?.read(),
      shell: (window as any).__liveShellCensus?.(),
      launch: (window as any).__liveLaunchCensus?.(),
      chat: (window as any).__liveChatCensus?.(),
      pool: (window as any).__livePoolCensus?.(),
    }))
    if (profile) await writeFile(resolve(root, 'idle.cpuprofile'), JSON.stringify(profile))
    await writeFile(resolve(root, 'idle.json'), JSON.stringify({ idleMs, before, after }))
    console.log(JSON.stringify({ idleMs, profiled: Boolean(profile) }))
  }
  const initialCounters = await page.evaluate(() => (window as any).__podiumSidebarPerf?.read())
  if (initialCounters?.pool?.rows != null)
    console.log(JSON.stringify({ poolRowsAtStart: initialCounters.pool.rows }))
  if (closeMeter) await page.getByRole('button', { name: 'Close performance panel' }).click()
  const rows = await page.locator('[data-issue-row]').evaluateAll((nodes) =>
    nodes.map((n) => ({
      id: n.getAttribute('data-issue-row')!,
      className: n.className,
      phase: n.getAttribute('data-phase'),
      selected: n.getAttribute('data-selected') === 'true',
      numbered: /^\d+$/.test(
        n
          .querySelector('[data-testid="row-id-number"] [aria-hidden="true"]')
          ?.textContent?.trim() ?? '',
      ),
      number: n
        .querySelector('[data-testid="row-id-number"] [aria-hidden="true"]')
        ?.textContent?.trim(),
      title: n.querySelector('.shell-work-row-title')?.textContent?.trim(),
      attributes: [...n.attributes].map((a) => a.name),
    })),
  )
  console.log(
    JSON.stringify({
      label,
      rows: rows.length,
      numberedRows: rows.filter((r) => r.numbered).length,
      renderer: await page.evaluate(() => window.__speedReact.renderer),
      loadavg: loadavg(),
      classes: [...new Set(rows.map((r) => r.className))],
      attributes: [...new Set(rows.flatMap((r) => r.attributes))],
    }),
  )
  if (inspect) {
    await page.locator('[data-issue-row] button').first().click()
    await page.waitForTimeout(3000)
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          globals: Object.keys(window).filter((k) => /podium|pool|kernel/i.test(k)),
          main: [
            ...document.querySelectorAll(
              'main, [data-pane], [data-panel-resident], .issue-panel, .mission-pane',
            ),
          ].map((n) => ({
            tag: n.tagName,
            className: n.className,
            attributes: [...n.attributes].map((a) => a.name),
          })),
          testids: [
            ...new Set(
              [...document.querySelectorAll('[data-testid]')].map((n) =>
                n.getAttribute('data-testid'),
              ),
            ),
          ],
          selected: document.querySelectorAll('[data-issue-row][data-selected="true"]').length,
          elements: document.querySelectorAll('*').length,
        })),
      ),
    )
  } else {
    const saved = targetsPath ? JSON.parse(await readFile(targetsPath, 'utf8')) : null
    const unique = [
      ...new Set(
        rows.filter((r) => r.numbered && !r.selected && r.phase !== 'done').map((r) => r.id),
      ),
    ]
    const anchor: string =
      saved?.anchor ??
      rows.find((r) => r.numbered && !r.selected && r.phase === 'working')?.id ??
      unique[0]!
    const targets: string[] = saved?.targets ?? unique.filter((id) => id !== anchor).slice(0, limit)
    if (targets.length !== limit) throw new Error('Need distinct sidebar targets')
    const labels = { ...saved?.labels }
    for (const row of rows)
      labels[row.id] = {
        ...labels[row.id],
        ...(row.number ? { number: row.number } : {}),
        ...(row.title ? { title: row.title } : {}),
      }
    await writeFile(resolve(root, 'targets.json'), JSON.stringify({ anchor, targets, labels }))
    // The client has a bounded pane cache: revisits and resident warm visits are separate labels.
    const order = issuePageAction
      ? [
          ...targets.map((id, index) => ({ id, index, visit: 'first' })),
          ...targets.map((id, index) => ({ id, index, visit: 'revisit' })),
        ]
      : targets.flatMap((id, index) => [
          { id, index, visit: 'first' },
          { id: anchor, index: -1, visit: 'anchor' },
          { id, index, visit: 'revisit' },
        ])
    const titles = new Map<string, string>()
    if (issuePageAction) {
      for (const id of targets) {
        const title: string | undefined = labels[id]?.title
        if (!title) throw new Error('Issue-page target has no title')
        titles.set(id, title.trim())
      }
      await page.getByTestId('topbar-nav-issues').click()
    }
    const summaries = []
    for (const [iteration, item] of order.entries()) {
      if (issuePageAction) {
        const title = titles.get(item.id)
        if (!title) throw new Error('Issue-page target has no title')
        await page.getByRole('textbox', { name: 'Search tasks' }).fill(title.trim())
        await page.waitForTimeout(300)
      }
      let trigger = issuePageAction
        ? `[data-issue-id="${item.id}"]`
        : `[data-issue-row="${item.id}"]`
      if (!issuePageAction && !(await page.locator(`${trigger}:visible`).count())) {
        for (const closed of await page.getByTestId('closed-fold-toggle').all())
          if ((await closed.getAttribute('aria-expanded')) === 'false') await closed.click()
        await page.waitForTimeout(1000)
        const label = labels[item.id]
        if (!(await page.locator(`${trigger}:visible`).count()) && label) {
          const found = await page.evaluate(
            ({ id, label }) => {
              const matches = [
                ...document.querySelectorAll<HTMLElement>('[data-testid="folded-work-row"]'),
              ].filter(
                (node) =>
                  node.getClientRects().length > 0 &&
                  (label.number
                    ? node.firstElementChild?.textContent?.trim() === label.number
                    : node.getAttribute('title')?.endsWith(` · ${label.title}`)),
              )
              if (matches.length !== 1) return false
              matches[0]!.setAttribute('data-speed-issue', id)
              return true
            },
            { id: item.id, label },
          )
          if (found) trigger = `[data-speed-issue="${item.id}"]`
        }
      }
      const row = page.locator(`${trigger}:visible`).first()
      if (!(await row.count())) throw new Error('Target is absent from the prepared sidebar')
      await row.scrollIntoViewIfNeeded()
      let box = await row.boundingBox()
      if (!box) throw new Error('Sidebar target has no bounds')
      await page.mouse.move(box.x + Math.min(120, box.width / 2), box.y + box.height / 2)
      await page.waitForTimeout(1000)
      box = await row.boundingBox()
      if (!box) throw new Error('Sidebar target moved out of view')
      await page.evaluate(
        ({ id, trigger, pageAction }) => {
          const state = (window as any).__speedCapture
          Object.assign(state, {
            target: id,
            trigger,
            pageAction,
            input: null,
            dom: null,
            twoRaf: false,
            twoRafAt: 0,
            rowSelectionRecovery: false,
            events: [],
            mutations: [],
            deckPending: Boolean(document.querySelector('[data-testid="flight-settling"]')),
            deckReadyAt: 0,
          })
          state.lastContentDom = 0
          state.previousTrace = (window as any).__podiumSwitchTraces?.recent().at(-1)?.switchId
          state.previousSessions = [
            ...document.querySelectorAll('[data-panel-resident][data-pane]'),
          ]
            .map((n) => n.getAttribute('data-session'))
            .join(',')
          state.expectSession =
            Number(
              document
                .querySelector(`[data-issue-row="${id}"]`)
                ?.querySelector('[data-testid="issue-fleet-total"]')?.textContent ?? 0,
            ) > 0
          state.launchBefore = (window as any).__liveLaunchCensus?.() ?? {}
          state.launchInitializedBefore = !!(window as any).__liveLaunchCensus
          state.chatBefore = (window as any).__liveChatCensus?.() ?? {}
          state.shellBefore = (window as any).__liveShellCensus?.() ?? {}
          state.poolBefore = (window as any).__livePoolCensus?.() ?? {}
          window.__speedReact.commits = []
          performance.clearMarks()
        },
        { id: item.id, trigger, pageAction: issuePageAction },
      )
      const errorsBefore = proxyErrors
      const events: any[] = []
      const receive = ({ value }: { value: any[] }) => events.push(...value)
      cdp.on('Tracing.dataCollected', receive)
      await cdp.send('Tracing.start', {
        categories: 'toplevel,devtools.timeline,blink.user_timing,latencyInfo,benchmark',
        transferMode: 'ReportEvents',
      })
      const stopCpu = timingOnly ? async () => null : await startCpu(cdp)
      if (!timingOnly) await page.evaluate(() => window.__speedSeedCommit?.())
      if (issuePageAction) await row.click({ timeout: 60_000 })
      else if (trigger.startsWith('[data-speed-issue')) await row.click({ timeout: 60_000 })
      else await row.locator('button[data-pressable]').first().click({ timeout: 60_000 })
      await page.waitForFunction(
        () => {
          const state = (window as any).__speedCapture
          const trace = (window as any).__podiumSwitchTraces?.recent().at(-1)
          // A sub-issue activates its mission root. Its own row stays unselected;
          // the correlated new trace and actual pane mutation prove activation.
          if (
            state.dom === null &&
            !state.pageAction &&
            state.lastContentDom > state.input &&
            trace?.issueId === state.target &&
            trace.switchId !== state.previousTrace
          ) {
            state.dom = state.lastContentDom
            state.rowSelectionRecovery = true
            performance.mark('speed:dom', { startTime: state.dom })
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                state.twoRaf = true
                state.twoRafAt = performance.now()
              }),
            )
          }
          return state.twoRaf
        },
        null,
        {
          timeout: 60_000,
        },
      )
      await page.waitForFunction(
        () => {
          const state = (window as any).__speedCapture
          if (document.querySelector('[data-testid="flight-settling"]')) return false
          if (state.pageAction) {
            state.confirmed = true
            state.readyAt = state.twoRafAt
            performance.mark('speed:content-dom', { startTime: state.dom })
            performance.mark('speed:ready', { startTime: state.readyAt })
            return true
          }
          const trace = (window as any).__podiumSwitchTraces?.recent().at(-1)
          const sessions = [...document.querySelectorAll('[data-panel-resident][data-pane]')]
            .map((n) => n.getAttribute('data-session'))
            .join(',')
          const unchanged =
            sessions === state.previousSessions && (sessions !== '' || !state.expectSession)
          const matching = trace?.issueId === state.target && trace.switchId !== state.previousTrace
          if (unchanged || matching) {
            const nativePanel =
              matching &&
              [...document.querySelectorAll<HTMLElement>('[data-panel-resident][data-pane]')].find(
                (panel) => panel.getAttribute('data-session') === trace.sessionId,
              )
            const nativeMark =
              matching &&
              trace.marks.find((mark: { name: string }) => mark.name === 'term:interactable')
            // A native surface keeps an inactive ChatView mounted. Its rows-built
            // diagnostic can leave the generic trace waiting for an invisible
            // chat sentinel. Recover only the connected, visible terminal's
            // actual interactable mark, with the chat surface confirmed hidden.
            const nativeOnly =
              nativeMark &&
              trace.meta?.terminalConnected &&
              trace.meta?.terminalVisible &&
              trace.meta?.terminalReady &&
              nativePanel &&
              !nativePanel.querySelector('[data-testid="chat-surface"]')?.getClientRects().length
            state.nativeOnlyRecovery = Boolean(nativeOnly && trace.timedOut)
            state.confirmed = unchanged || !trace.timedOut || Boolean(nativeOnly)
            // With the diagnostics panel closed, the product trace starts at
            // beginSwitch rather than the click. Keep its clock origin so input
            // delay and synchronous selection work cannot disappear from ready.
            const traceInput =
              matching &&
              trace.marks.some((mark: { name: string }) => mark.name === 'sidebar:input-paint')
                ? state.input
                : trace?.startedAt - performance.timeOrigin
            state.readyAt = matching
              ? traceInput + (nativeOnly ? nativeMark.atMs : trace.totalMs)
              : state.twoRafAt
            // Pane readiness can precede the mission data. Include the actual
            // settling-shell removal, and never precede selection's paint fence.
            state.readyAt = Math.max(state.readyAt, state.twoRafAt, state.deckReadyAt)
            const mutations = state.mutations.filter((at: number) => at <= state.readyAt)
            performance.mark('speed:content-dom', {
              startTime: Math.max(state.dom, mutations.at(-1) ?? 0),
            })
            performance.mark('speed:ready', { startTime: state.readyAt })
            return true
          }
          return false
        },
        null,
        { timeout: 15_000 },
      )
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      )
      await page.waitForTimeout(150)
      const profile = await stopCpu()
      const complete = new Promise<void>((done) => cdp.once('Tracing.tracingComplete', done))
      await cdp.send('Tracing.end')
      await complete
      cdp.off('Tracing.dataCollected', receive)
      const state = await page.evaluate(() => ({
        boundary: (window as any).__speedCapture,
        timeOrigin: performance.timeOrigin,
        react: window.__speedReact,
        componentNames: window.__speedFunctionNames,
        traces: (window as any).__podiumSwitchTraces?.recent().slice(-1),
        elements: document.querySelectorAll('*').length,
        domSurfaces: {
          deck:
            document.querySelector('[data-testid="flight-deck-scroller"]')?.querySelectorAll('*')
              .length ?? 0,
          sidebar:
            document.querySelector('[data-testid="work-scroll"]')?.querySelectorAll('*').length ??
            0,
          panes:
            document.querySelector('[data-panel-resident][data-pane]')?.querySelectorAll('*')
              .length ?? 0,
          hiddenChat: [...document.querySelectorAll<HTMLElement>('[data-testid="chat-surface"]')]
            .filter((node) => !node.getClientRects().length)
            .reduce((count, node) => count + node.querySelectorAll('*').length, 0),
        },
        sidebar: (window as any).__podiumSidebarPerf?.read(),
      }))
      const launchAfter = await page.evaluate(() => (window as any).__liveLaunchCensus?.() ?? {})
      const chatAfter = await page.evaluate(() => (window as any).__liveChatCensus?.() ?? {})
      const shellAfter = await page.evaluate(() => (window as any).__liveShellCensus?.() ?? {})
      const poolAfter = await page.evaluate(() => (window as any).__livePoolCensus?.() ?? {})
      const input = events.find((e) => e.name === 'speed:input')
      const dom = events.find((e) => e.name === 'speed:dom')
      const paint = events
        .filter(
          (e) => e.name === 'Paint' && e.ph === 'X' && e.pid === input?.pid && e.ts >= dom?.ts,
        )
        .sort((a, b) => a.ts - b.ts)[0]
      const content = events.find((e) => e.name === 'speed:content-dom')
      const ready = events.find((e) => e.name === 'speed:ready')
      const contentPaints = events
        .filter(
          (e) =>
            e.name === 'Paint' &&
            e.ph === 'X' &&
            e.pid === input?.pid &&
            e.tid === input?.tid &&
            e.ts >= content?.ts,
        )
        .sort((a, b) => a.ts - b.ts)
      const layer = events.find(
        (e) =>
          e.name === 'Layerize' &&
          e.ph === 'X' &&
          e.pid === input?.pid &&
          e.tid === input?.tid &&
          e.ts >= Math.max(ready?.ts ?? 0, contentPaints[0]?.ts ?? 0),
      )
      const finishedPaint = layer
        ? contentPaints.filter((e) => e.ts <= layer.ts).at(-1)
        : (contentPaints.filter((e) => e.ts <= (ready?.ts ?? 0)).at(-1) ?? contentPaints[0])
      if (!input || !dom || !paint) throw new Error('Missing input, selected DOM or actual Paint')
      const click = state.boundary.events
        .filter((e: any) => e.name === 'click' && Math.abs(e.startTime - state.boundary.input) < 1)
        .at(-1)
      const numbers = {
        sourceSha,
        iteration,
        target: item.index,
        visit: item.visit,
        inputDelayMs: click
          ? click.processingStart - click.startTime
          : state.boundary.processingStart - state.boundary.input,
        presentationMs: click?.duration ?? null,
        finishedPaintMs: finishedPaint
          ? Math.max(finishedPaint.ts + finishedPaint.dur, ready?.ts ?? 0) / 1000 - input.ts / 1000
          : null,
        readyBoundaryMs: state.boundary.readyAt - state.boundary.input,
        deckReadyMs: state.boundary.deckReadyAt
          ? state.boundary.deckReadyAt - state.boundary.input
          : null,
        confirmed: state.boundary.confirmed,
        nativeOnlyRecovery: Boolean(state.boundary.nativeOnlyRecovery),
        rowSelectionRecovery: Boolean(state.boundary.rowSelectionRecovery),
        traceTimedOut:
          !issuePageAction && state.traces?.[0]?.issueId === item.id
            ? state.traces[0].timedOut
            : null,
        clickToPaintMs: (paint.ts + paint.dur - input.ts) / 1000,
        selectedDomMs: (dom.ts - input.ts) / 1000,
        elements: state.elements,
        domSurfaces: state.domSurfaces,
        commits: state.react.commits.length,
        traceMs:
          !issuePageAction && state.traces?.[0]?.issueId === item.id
            ? state.traces[0].totalMs
            : null,
        cold:
          !issuePageAction && state.traces?.[0]?.issueId === item.id ? state.traces[0].cold : null,
        poolRows: state.sidebar?.pool?.rows ?? null,
        sidebarTargetType: trigger.startsWith('[data-speed-issue') ? 'folded' : 'open',
        proxyErrors: proxyErrors - errorsBefore,
        proxyErrorKinds: { ...proxyErrorKinds },
        loadavg: loadavg(),
        instrumented: {
          launch: state.boundary.launchInitializedBefore,
          chat: Object.keys(state.boundary.chatBefore).length > 0,
          shell: Object.keys(state.boundary.shellBefore).length > 0,
          pool: Object.keys(state.boundary.poolBefore).length > 0,
        },
      }
      Object.assign(numbers, {
        action: issuePageAction ? 'issue-page-open' : 'sidebar-issue',
        chatWork: Object.fromEntries(
          ['mentionBuilds', 'mentionIssueReads', 'referenceBuilds', 'referenceSessionReads'].map(
            (key) => [
              key,
              Number(chatAfter[key] ?? 0) - Number(state.boundary.chatBefore[key] ?? 0),
            ],
          ),
        ),
        launchWork: Object.fromEntries(
          [
            'catalogBuilds',
            'launchReads',
            'issueBuilds',
            'coldSessionVisits',
            'usageQueries',
            'addressedSessionReads',
          ].map((key) => [
            key,
            Number(launchAfter[key] ?? 0) - Number(state.boundary.launchBefore[key] ?? 0),
          ]),
        ),
        shellWork: Object.fromEntries(
          ['issue', 'session', 'issues', 'sessions', 'chrome', 'dock'].map((key) => [
            key,
            Number(shellAfter[key] ?? 0) - Number(state.boundary.shellBefore?.[key] ?? 0),
          ]),
        ),
        poolReadsDuringCapture: Object.fromEntries(
          Object.keys(poolAfter).map((key) => [
            key,
            Number(poolAfter[key]) - Number(state.boundary.poolBefore[key] ?? 0),
          ]),
        ),
      })
      const file = `click-${iteration.toString().padStart(2, '0')}`
      const traceBytes = JSON.stringify({ traceEvents: events })
      if (traceBytes.includes(token))
        throw new Error('Credential found in capture; refusing to save it')
      await writeFile(resolve(root, file + '.trace.json.gz'), gzipSync(traceBytes, { level: 1 }))
      if (profile)
        await writeFile(
          resolve(root, file + '.cpuprofile.gz'),
          gzipSync(JSON.stringify(profile), { level: 1 }),
        )
      await writeFile(resolve(root, file + '.json'), JSON.stringify({ ...numbers, ...state }))
      summaries.push(numbers)
      console.log(JSON.stringify(numbers))
      await page.evaluate(() => {
        ;(window as any).__speedCapture.input = null
      })
      if (issuePageAction) {
        await page.locator('[data-testid="issue-page"] button[title="Back"]').click()
        await page.getByTestId('issue-page').waitFor({ state: 'hidden' })
      }
    }
    if (!timingOnly) await saveComponents(page, cdp, resolve(root, 'components.json'))
    if (verifyMenu) {
      await page.getByRole('button', { name: 'New panel', exact: true }).first().click()
      await page.getByRole('menuitem').first().waitFor({ timeout: 15_000 })
      const choices = await page.getByRole('menuitem').count()
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'hidden' })
      console.log(
        JSON.stringify({
          menuOpened: true,
          choices,
          menuClosed: true,
          launchInstrumented: await page.evaluate(() => !!(window as any).__liveLaunchCensus),
        }),
      )
    }
    await writeFile(
      resolve(root, 'summary.json'),
      JSON.stringify({ label, sourceSha, timingOnly, samples: summaries }, null, 2),
    )
  }
} catch (error) {
  await writeFile(resolve(root, 'failure.txt'), String((error as Error).stack))
  await writeFile(resolve(root, 'startup-errors.json'), JSON.stringify(startupErrors))
  if (capturePage)
    console.log(
      JSON.stringify({
        startup: await capturePage
          .evaluate(() => ({
            ready: document.readyState,
            elements: document.querySelectorAll('*').length,
            rows: document.querySelectorAll('[data-issue-row]').length,
            passwordInputs: document.querySelectorAll('input[type="password"]').length,
            alerts: document.querySelectorAll('[role="alert"]').length,
            rootChildren: document.getElementById('root')?.children.length ?? 0,
          }))
          .catch(() => ({ unavailable: true })),
        scriptErrors: startupErrors.length,
        responseFailures: Object.fromEntries(responseFailures),
        proxyErrors,
      }),
    )
  if (capturePage)
    await writeFile(
      resolve(root, 'failure-state.json'),
      JSON.stringify(
        await capturePage
          .evaluate(() => ({
            boundary: (window as any).__speedCapture,
            traces: (window as any).__podiumSwitchTraces?.recent().slice(-1),
          }))
          .catch(() => null),
      ),
    )
  if (capturePage && captureCdp) {
    await saveComponents(capturePage, captureCdp, resolve(root, 'components.json')).catch(() => {})
    console.log(
      JSON.stringify(
        await capturePage
          .evaluate(() => {
            const s = (window as any).__speedCapture
            const row = document.querySelector(`[data-issue-row="${s.target}"]`)
            return {
              inputCaptured: s.input !== null,
              selectedDom: s.dom !== null,
              targetPresent: !!row,
              targetSelected: row?.getAttribute('data-selected') === 'true',
              numbered: /^\d+$/.test(
                row
                  ?.querySelector('[data-testid="row-id-number"] [aria-hidden="true"]')
                  ?.textContent?.trim() ?? '',
              ),
            }
          })
          .catch(() => ({ diagnosticUnavailable: true })),
      ),
    )
  }
  console.error(JSON.stringify({ status: 'capture failed', error: (error as Error).name, label }))
  process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
  await server.httpServer.close()
}
