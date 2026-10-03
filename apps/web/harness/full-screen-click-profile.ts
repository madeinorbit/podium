/** Measurement-only sibling of speed-gate.ts. Reuses its production config,
 * canonical fixture, targets and trusted input → actual Paint boundary. */
import { execFileSync, spawn } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { arch, cpus, hostname, loadavg, platform } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import type { UserConfig } from 'vite'
import { paintOf } from './browser-paint'
import {
  installCommitObserver,
  traceStart,
  saveComponentLocations,
  saveRecording,
  startCpu,
} from './full-screen-profile'
import type {} from '../test/sidebar-acceptance.browser'

const ACTIONS = [
  'sidebar-issue',
  'mission-switch',
  'session-pane',
  'issue-rename',
  'background-update',
] as const
type Action = (typeof ACTIONS)[number]
type Numbers = Record<Action, { medianMs: number; worstMs: number }>
type Targets = {
  sidebar: string[]
  missions: string[]
  sessions: string[]
  rename: string
  background: string
}
type Machine = {
  host: string
  cpu: string
  cores: number
  arch: string
  platform: string
  browser: string
}
type Baseline = { machine: Machine; targets: Targets }
type Expected = { selector: string; text?: string }
type Capture = {
  expected: Expected
  trigger: string
  action: Action
  input: number | null
  dom: number | null
  twoRaf: boolean
}
declare global {
  interface Window {
    __speedCapture: Capture | null
  }
}

const args = process.argv.slice(2).filter((arg) => arg !== '--')
const value = (name: string, fallback: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const profileAction = value('profile', 'all')
const profileActions = profileAction === 'all' ? ACTIONS.filter(action => action !== 'sidebar-issue')
  : [profileAction === 'session-switch' ? 'session-pane' : profileAction]
const root = resolve('.artifacts/full-screen-click-profile')
const buildDir = resolve(root, 'build')
const profileDir = resolve(root, 'profiles', profileAction)
const baselinePath = resolve('docs/measurements/click-speed-baseline.json')
const REPETITIONS = 3
const WARMUPS = 2
const git = (...argv: string[]) => execFileSync('git', argv, { encoding: 'utf8' }).trim()
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const round = (n: number) => Math.round(n * 1000) / 1000
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function main() {
  if (args.includes('--help')) {
    console.log('bun apps/web/harness/full-screen-click-profile.ts --profile=mission-switch|session-switch|issue-rename|background-update|all\n' +
      'Three production CPU + trace samples per action, mobxPane OFF/ON; no gate/baseline writes.\n' +
      '--lease-confirmed: caller holds bench:flatblock.')
    return
  }
  for (const arg of args) if (arg !== '--lease-confirmed' && !arg.startsWith('--profile='))
    throw new Error(`Unknown argument ${arg}`)
  if (hostname() !== 'flatblock') throw new Error('Profile capture runs on flatblock')
  if (!profileActions.length || profileActions.some(action => !ACTIONS.includes(action as Action) || action === 'sidebar-issue'))
    throw new Error('Choose a full-screen profile action')
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline
  const captureSha = git('rev-parse', 'HEAD')
  const dirtyProduct =
    git('status', '--porcelain', '--untracked-files=normal', '--', 'apps/web/src', 'packages')
      .length > 0
  if (dirtyProduct) throw new Error('Profile a committed product tree')
  await mkdir(root, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  const began = performance.now()
  let leased = false
  let browser: Browser | undefined
  let server: ReturnType<typeof createServer> | undefined
  const podium = async (argv: string[]) => {
    const proc = spawn('podium', argv, { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    proc.stdout.on('data', (chunk) => {
      output += chunk
    })
    const status = await new Promise<number | null>((done, reject) => {
      proc.once('error', reject)
      proc.once('exit', done)
    })
    if (status) throw new Error(`podium ${argv.join(' ')} exited ${status}`)
    if (argv.includes('--json')) {
      const result = JSON.parse(output)
      console.log(result.text)
      return result.data as { granted: boolean; alreadyHeld?: boolean }
    }
    console.log(output.trim())
    return null
  }
  let cleaning: Promise<void> | undefined
  async function cleanup() {
    cleaning ??= (async () => {
      const result = await Promise.allSettled([
        browser?.close(),
        server?.listening
          ? new Promise<void>((done, reject) =>
              server!.close((error) => (error ? reject(error) : done())),
            )
          : Promise.resolve(),
      ])
      if (leased) {
        leased = false
        await podium(['lock', 'release', 'bench:flatblock'])
      }
      for (const item of result) if (item.status === 'rejected') throw item.reason
    })()
    await cleaning
  }
  const budgetMs = 900_000
  const deadline = setTimeout(() => {
    console.error(
      `Full-screen profile exceeded ${budgetMs / 1000} seconds. Capture incomplete.`,
    )
    void cleanup().finally(() => process.exit(2))
  }, budgetMs)
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(130))
    })

  async function openPage(origin: string, pilot: number) {
    const context = await browser!.newContext({
      viewport: { width: 1800, height: 1000 },
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // Prevent this synthetic fixture from ever making an operator RPC/feed call.
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    )
    await installCommitObserver(page)
    await page.addInitScript(
      () => {
        const began = performance.now()
        Date.now = () => Date.parse('2026-09-20T12:00:00Z') + Math.floor(performance.now() - began)
        window.__speedCapture = null
        document.addEventListener(
          'pointerdown',
          (event) => {
            const c = window.__speedCapture
            if (!c || c.input !== null || !(event.target as Element)?.closest(c.trigger)) return
            if (!event.isTrusted) throw new Error('speed:gate needs a trusted browser input')
            c.input = event.timeStamp
            performance.mark('speed:input', { startTime: event.timeStamp })
          },
          true,
        )
        new MutationObserver(() => {
          const c = window.__speedCapture
          if (!c || c.input === null || c.dom !== null) return
          const el = document.querySelector(c.expected.selector)
          if (!el || (c.expected.text !== undefined && el.textContent?.trim() !== c.expected.text))
            return
          c.dom = performance.now()
          performance.mark('speed:dom')
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              c.twoRaf = true
            }),
          )
        }).observe(document, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        })
      },
    )
    await page.goto(
      `${origin}/harness/full-screen-click-profile.browser.html?mobxSidebar=1&mobxPane=${pilot}&scale=4&surface=full&panelMode=chat`,
    )
    await page.waitForFunction(
      () => window.__acceptance?.ready() && document.querySelector('[data-issue-row]'),
    )
    await page.evaluate(() => document.fonts.ready)
    await settle(page)
    const state = await page.evaluate(() => ({
      mode: window.__acceptance.mode(),
      ...window.__acceptance.state(),
      corpus: window.__acceptance.corpus,
      paneMode: window.__speedPaneMode(),
    }))
    if (
      state.mode !== 'pool' ||
      !state.pool ||
      (state.paneMode !== (pilot ? 'pool' : 'legacy')) ||
      (state.issues ?? 0) < 19_000 ||
      (state.sessions ?? 0) < 17_000
    )
      throw new Error(`Wrong 4× pool fixture: ${JSON.stringify(state)}`)
    {
      const renderer = await page.evaluate(() => window.__speedReact.renderer)
      if (renderer?.bundleType !== 0 || renderer.version !== '19.2.7')
        throw new Error(`Expected ordinary production React 19.2.7: ${JSON.stringify(renderer)}`)
    }
    return { page, cdp: await context.newCDPSession(page), context, errors, pilot }
  }
  async function settle(page: Page) {
    await page.evaluate(() => window.__acceptance.settled())
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    )
  }
  const row = (id: string) => `[data-issue-row="${id}"]`
  const deckSession = (id: string) => `[data-flight-session="${id}"] button.deck-agent`
  let sampleIndex: number | null = null
  const profileRecords: Record<string, unknown>[] = []

  async function capture(
    fixture: Awaited<ReturnType<typeof openPage>>,
    action: Action,
    trigger: string,
    expected: Expected,
    perform: () => Promise<unknown>,
  ) {
    const { page, cdp } = fixture
    await page.bringToFront()
    if (trigger) {
      await page.locator(trigger).first().scrollIntoViewIfNeeded()
      await page.locator(trigger).first().hover()
    }
    await settle(page)
    await page.evaluate(
      ({ expected, trigger, action }) => {
        const el = document.querySelector(expected.selector)
        if (el && (expected.text === undefined || el.textContent?.trim() === expected.text))
          throw new Error('Action would be a no-op')
        performance.clearMarks()
        window.__speedCapture = { expected, trigger, action, input: null, dom: null, twoRaf: false }
        if (window.__speedReact) window.__speedReact.commits = []
      },
      { expected, trigger, action },
    )
    const recordCpu = sampleIndex !== null
    const stateBefore = recordCpu ? await page.evaluate(() => window.__acceptance.state()) : null
    const stop = await traceStart(cdp)
    const stopCpu = recordCpu ? await startCpu(cdp) : null
    let events: Awaited<ReturnType<typeof stop>>
    let profile: Awaited<ReturnType<NonNullable<typeof stopCpu>>> | null = null
    let react: typeof window.__speedReact | null = null
    let boundary: Capture | null = null
    let browserTimeOriginMs: number | null = null
    try {
      await perform()
      await page.waitForFunction(() => window.__speedCapture?.twoRaf)
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        capture: window.__speedCapture,
        state: window.__acceptance.state(),
        errors: window.__acceptance.errors(),
        panes: [...document.querySelectorAll('[data-panel-resident]')].map((el) => ({
          session: el.getAttribute('data-session'),
          pane: el.getAttribute('data-pane'),
          text: el.textContent?.slice(0, 180),
        })),
      }))
      throw new Error(`${action} did not paint: ${JSON.stringify(diagnostic)}`, { cause: error })
    } finally {
      if (stopCpu) profile = await stopCpu()
      events = await stop()
      if (recordCpu) {
        const observed = await page.evaluate(() => ({
          react: window.__speedReact,
          boundary: window.__speedCapture,
          timeOriginMs: performance.timeOrigin,
        }))
        react = observed.react
        boundary = observed.boundary
        browserTimeOriginMs = observed.timeOriginMs
      }
      await page.evaluate(() => {
        window.__speedCapture = null
      })
    }
    const result = paintOf(events, 'speed:input', 'speed:dom')
    const errors = [...fixture.errors, ...(await page.evaluate(() => window.__acceptance.errors()))]
    if (errors.length) throw new Error(`Fixture errors: ${errors.join('; ')}`)
    if (profile) {
      const actionName = action === 'session-pane' ? 'session-switch' : action
      const file = `${actionName}-pilot-${fixture.pilot ? 'on' : 'off'}-${sampleIndex}`
      const record = {
        file, sourceSha: captureSha, action: actionName, pilot: fixture.pilot,
        iteration: sampleIndex, trigger, expected, paint: result, boundary,
        react, stateBefore, stateAfter: await page.evaluate(() => window.__acceptance.state()),
        loadavg: loadavg(),
        // Browser performance.timeOrigin + boundary.input locates the input
        // in UTC. Bun's process.hrtime has a process-relative origin and must
        // not be aligned directly with Chromium's uptime-based trace clock.
        clockSync: { wallMs: Date.now(), browserTimeOriginMs },
      }
      await saveRecording(profileDir, file, profile, events, record)
      profileRecords.push(record)
      console.log(`${file}: ${round(result.inputToPaintMs)} ms; ${react?.commits.length} observed commits (analysis clips at Paint)`)
    }
    return result.inputToPaintMs
  }

  async function suite(origin: string, fixed: Targets, pilot: number) {
    const full = await openPage(origin, pilot)
    const samples = Object.fromEntries(ACTIONS.map((action) => [action, [] as number[]])) as Record<
      Action,
      number[]
    >
    const loads: number[] = []
    try {
      const ids = await full.page
        .locator('[data-issue-row]')
        .evaluateAll((nodes) => [
          ...new Set(
            nodes
              .filter((node) => node.getClientRects().length)
              .map((node) => node.getAttribute('data-issue-row')!),
          ),
        ])
      const shapes = (await full.page.evaluate((ids) => window.__acceptance.shape(ids), fixed.missions))
        .filter((shape) => shape.root && shape.rows > 0)
        .sort((a, b) => b.rows - a.rows || a.id.localeCompare(b.id))
      const targets = structuredClone(fixed)
      if (
        targets.sidebar.length !== 2 ||
        targets.missions.length !== 2 ||
        targets.sidebar.some((id) => !ids.includes(id))
      )
        throw new Error('The fixed target roots are missing')
      const measure = async (action: Action, run: (iteration: number) => Promise<number>) => {
        if (!profileActions.includes(action)) return
        const repetitions = REPETITIONS
        for (let i = -WARMUPS; i < repetitions; i++) {
          sampleIndex = i >= 0 ? i : null
          const ms = await run(i + WARMUPS)
          await settle(full.page)
          if (i >= 0) {
            samples[action].push(ms)
            loads.push(loadavg()[0]!)
          }
        }
        console.log(
          `${action}: median ${round(median(samples[action]))} ms, worst ${round(Math.max(...samples[action]))} ms (n=${repetitions})`,
        )
      }
      await measure('mission-switch', async (i) => {
        const id = targets.missions[i % 2]!
        const ms = await capture(
          full,
          'mission-switch',
          row(id),
          { selector: `[data-fixture-mission="${id}"] [data-testid="flight-deck-scroller"]` },
          () => full.page.locator(row(id)).first().click(),
        )
        if ((await full.page.evaluate(() => window.__acceptance.state().selected)) !== id)
          throw new Error('Mission click routed to the wrong issue')
        return ms
      })
      await full.page.locator(row(targets.rename)).first().click()
      await settle(full.page)
      if (!targets.sessions.length) {
        targets.sessions = await full.page
          .locator('[data-flight-session]:not([data-retired="true"])')
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => node.querySelector('button.deck-agent'))
              .map((node) => node.getAttribute('data-flight-session')!)
              .slice(0, 2),
          )
      }
      if (targets.sessions.length !== 2) throw new Error('Need two distinct open session panes')
      // Establish the opposite pane before the first sample so opening is never a no-op.
      await full.page.locator(deckSession(targets.sessions[1]!)).first().click()
      await full.page.waitForFunction((id) => window.__acceptance.state().pane === id, targets.sessions[1]!)
      await settle(full.page)
      await measure('session-pane', async (i) => {
        const id = targets.sessions[i % 2]!
        const ms = await capture(
          full,
          'session-pane',
          deckSession(id),
          {
            selector: `[data-panel-resident][data-session="${id}"][data-pane]`,
          },
          () => full.page.locator(deckSession(id)).first().click(),
        )
        if ((await full.page.evaluate(() => window.__acceptance.state().pane)) !== id)
          throw new Error('Session click routed to the wrong pane')
        return ms
      })
      {
        // The six-sample ordinary gate finishes on the second session. Restore
        // that same dock/focus context after the odd three-sample profile block.
        await full.page.locator(deckSession(targets.sessions[1]!)).first().click()
        await full.page.waitForFunction((id) => window.__acceptance.state().pane === id, targets.sessions[1]!)
        await settle(full.page)
      }
      await measure('issue-rename', async (i) => {
        const title = `Speed gate rename ${i}`
        await full.page.getByTestId('dock-title').dblclick()
        await full.page.getByTestId('dock-inspect-head').locator('input').fill(title)
        // A real click outside the editor commits through its production onBlur/outbox.
        return capture(
          full,
          'issue-rename',
          '[data-fixture-workspace]',
          { selector: '[data-testid="dock-title"]', text: title },
          () => full.page.locator('[data-fixture-workspace]').click({ position: { x: 3, y: 3 } }),
        )
      })
      // A feed-delivered title on another visible root is unrelated to the selected mission,
      // but has real visible damage. A hidden heartbeat would paint nothing and cannot supply this metric.
      await full.page.locator(row(targets.background)).first().scrollIntoViewIfNeeded()
      await measure('background-update', async (i) => {
        const title = `Speed gate background ${i}`
        return capture(
          full,
          'background-update',
          '',
          { selector: `${row(targets.background)} .shell-work-row-title`, text: title },
          () =>
            full.page.evaluate(
              ({ id, title }) =>
                new Promise<void>((done) =>
                  requestAnimationFrame(() => {
                    // Fix feed arrival phase; timing still starts at actual delivery.
                    window.__speedCapture!.input = performance.now()
                    performance.mark('speed:input')
                    window.__acceptance.backgroundTitle(id, title)
                    done()
                  }),
                ),
              { id: targets.background, title },
            ),
        )
      })
      const actions = Object.fromEntries(
        ACTIONS.filter((action) => samples[action].length).map((action) => [
          action,
          {
            medianMs: round(median(samples[action])),
            worstMs: round(Math.max(...samples[action])),
          },
        ]),
      ) as Numbers
      {
        await saveComponentLocations(full.page, full.cdp,
          resolve(profileDir, `components-pilot-${pilot ? 'on' : 'off'}.json`))
      }
      return {
        targets,
        actions,
        samples,
        ...{
          shapes: shapes.filter((shape) => targets.missions.includes(shape.id)),
          fixture: await full.page.evaluate(() => ({
            ...window.__acceptance.state(), corpus: window.__acceptance.corpus,
          })),
        },
        load: { min: Math.min(...loads), max: Math.max(...loads) },
      }
    } finally {
      await full.context.close()
    }
  }

  let exitCode = 2
  try {
    console.log(
      'Building the gate’s ordinary minified production fixture, with measurement entry and hidden maps…',
    )
    const { build } = await import('../node_modules/vite/dist/node/index.js')
    const configPath = resolve('apps/web/harness/sidebar-acceptance.vite.ts')
    const { default: config } = await import(configPath) as { default: UserConfig }
    await build({
      ...config,
      configFile: false,
      logLevel: 'warn',
      plugins: config.plugins?.filter(
        (plugin) => (plugin as { name?: string })?.name !== 'acceptance-state-boundaries',
      ),
      build: { ...config.build, outDir: buildDir, sourcemap: 'hidden', minify: 'esbuild',
        rollupOptions: { ...config.build?.rollupOptions, input: resolve('apps/web/harness/full-screen-click-profile.browser.html') } },
    })
    server = createServer(async (req, res) => {
      try {
        const path = resolve(buildDir, '.' + new URL(req.url!, 'http://localhost').pathname)
        if (!path.startsWith(buildDir + '/')) {
          res.writeHead(403)
          res.end()
          return
        }
        const bytes = await readFile(path)
        res.setHeader(
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
        res.end(bytes)
      } catch {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const launchBrowser = () => chromium.launch({
      headless: true,
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [resolve('.toolchain/lib'), process.env.LD_LIBRARY_PATH]
          .filter(Boolean)
          .join(':'),
      },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    browser = await launchBrowser()
    const machine: Machine = {
      host: hostname(),
      cpu: cpus()[0]!.model,
      cores: cpus().length,
      arch: arch(),
      platform: platform(),
      browser: browser.version(),
    }
    if (baseline && !same(machine, baseline.machine))
      throw new Error('Machine/browser differs from the landed baseline; no timing comparison made')
    if (!args.includes('--lease-confirmed')) {
      const grant = await podium([
        'lock',
        'acquire',
        'bench:flatblock',
        '--ttl',
        '16m',
        '--wait',
        '--timeout',
        '30s',
        '--json',
      ])
      if (!grant?.granted) throw new Error('bench:flatblock was not granted')
      leased = !grant.alreadyHeld
    }
    const runs: Awaited<ReturnType<typeof suite>>[] = []
    console.log(`Production build and browser ready: ${round((performance.now() - began) / 1000)}s`)
    {
      if (dirtyProduct) throw new Error('Profile a committed product tree')
      for (const pilot of [0, 1]) {
        console.log(`4× full surface; mobxSidebar=1, mobxPane=${pilot}; ${REPETITIONS} profiles per action`)
        runs.push(await suite(origin, baseline!.targets, pilot))
      }
      await writeFile(resolve(profileDir, 'manifest.json'), JSON.stringify({
        version: 1, sourceSha: captureSha, dirtyProduct, machine, capturedAt: new Date().toISOString(),
        profileAction, pilot: 'mobxPane=0/1; mobxSidebar=1 in both arms',
        scale: 4, surface: 'full', seed: 4443, repetitions: REPETITIONS, warmups: WARMUPS,
        build: 'ordinary React 19.2.7; minified production; hidden source maps; no state-boundary wrappers',
        samplingIntervalUs: 1000,
        metric: 'trusted pointerdown (background: feed delivery) to end of first Chromium Paint after expected DOM change',
        window: 'Raw CPU and trace include setup/tails; analyze only speed:input through the qualifying Paint end.',
        runs, records: profileRecords.map((record) => record.file),
        runtimeSeconds: round((performance.now() - began) / 1000),
      }, null, 2) + '\n')
      console.log(`PROFILE CAPTURE COMPLETE — ${profileRecords.length} recordings; ${profileDir}. Shared speed gate and baseline untouched.`)
      exitCode = 0
      return
    }
  } catch (error) {
    console.error(error)
    exitCode = 2
  } finally {
    clearTimeout(deadline)
    await cleanup()
  }
  process.exit(exitCode)
}
await main().catch((error) => {
  console.error('FULL-SCREEN PROFILE INVALID:', error)
  process.exit(2)
})
