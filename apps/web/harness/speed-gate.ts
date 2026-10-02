/** Fixed production-browser continuation of selection-runtime / POD-5077. */
import { execFileSync, spawn } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { arch, cpus, hostname, loadavg, platform } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { paintOf, traceStart } from './browser-paint'
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
type Baseline = {
  version: 1
  sourceSha: string
  landedRef: string
  machine: Machine
  repetitions: number
  scale: 4
  seed: 4443
  targets: Targets
  actions: Numbers
  noise: { runs: number; medianSpreadPercent: Record<Action, number>; maxPercent: number }
}
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
const calibrate = args.includes('--calibrate')
const promote = args.includes('--promote')
const delayMs = Number(value('plant-delay-ms', '0'))
const root = resolve('.artifacts/speed-gate')
const buildDir = resolve(root, 'build')
const baselinePath = resolve('docs/measurements/click-speed-baseline.json')
const REPETITIONS = 10
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
    console.log(
      'bun run speed:gate — flatblock, five actions × ten samples; median > landed +10% exits 1.\n' +
        '--calibrate --baseline-ref=<landed SHA/ref>: initial baseline only, three runs to measure noise.\n' +
        '--plant-delay-ms=50: plant a synchronous delay in the sidebar click path (expected red).\n' +
        '--promote: commit-ready baseline from the saved green run after its source lands; no rerun.\n' +
        '--lease-confirmed: caller already holds bench:flatblock (remote capture).',
    )
    process.exit(0)
  }
  for (const arg of args)
    if (
      !['--calibrate', '--promote', '--lease-confirmed'].includes(arg) &&
      !arg.startsWith('--plant-delay-ms=') &&
      !arg.startsWith('--baseline-ref=')
    )
      throw new Error(`Unknown argument ${arg}`)
  if (hostname() !== 'flatblock')
    throw new Error('speed:gate runs on flatblock; no cross-machine comparisons')
  if (
    !Number.isFinite(delayMs) ||
    delayMs < 0 ||
    delayMs > 1000 ||
    (delayMs && (calibrate || promote))
  )
    throw new Error('Invalid planted delay/mode')
  if (calibrate && promote) throw new Error('Choose calibration or promotion')

  let baseline: Baseline | null = null
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (calibrate && baseline)
    throw new Error('Initial baseline already exists; a red run cannot replace it')
  if (!calibrate && !baseline)
    throw new Error('Missing landed baseline; initialize at integrate/4286-pilot with --calibrate')
  if (
    baseline &&
    (baseline.version !== 1 ||
      baseline.repetitions !== REPETITIONS ||
      baseline.scale !== 4 ||
      baseline.seed !== 4443 ||
      ACTIONS.some(
        (action) =>
          !Number.isFinite(baseline!.actions[action]?.medianMs) ||
          baseline!.actions[action]!.medianMs <= 0,
      ))
  )
    throw new Error('Incompatible or incomplete landed baseline')

  if (promote) {
    const report = JSON.parse(await readFile(resolve(root, 'passed.json'), 'utf8'))
    if (!report.passed || report.delayMs || !same(report.machine, baseline!.machine))
      throw new Error('Promotion needs an unmodified green same-machine capture')
    const landedRef = value('baseline-ref', baseline!.landedRef)
    git('merge-base', '--is-ancestor', report.sourceSha, landedRef)
    // Do not promote an older green result over a newer product landing.
    git('diff', '--exit-code', report.sourceSha, landedRef, '--', 'apps/web/src', 'packages')
    if (report.dirtyProduct)
      throw new Error('Commit the product change before capturing the run to promote')
    await writeFile(
      baselinePath,
      JSON.stringify(
        {
          ...baseline,
          sourceSha: report.sourceSha,
          actions: report.actions,
          targets: report.targets,
        },
        null,
        2,
      ) + '\n',
    )
    console.log(
      `Landed numbers promoted from ${report.sourceSha}; commit ${baselinePath}. No browser rerun.`,
    )
    process.exit(0)
  }

  const captureSha = git('rev-parse', 'HEAD')
  const sourceSha = calibrate
    ? git('rev-parse', value('baseline-ref', 'integrate/4286-pilot'))
    : captureSha
  const dirtyProduct =
    git('diff', '--name-only', 'HEAD', '--', 'apps/web/src', 'packages').length > 0
  if (calibrate) {
    if (dirtyProduct)
      throw new Error('First baseline must measure the unchanged landed integration product tree')
    // The committed measurement code may sit above the landing being measured.
    git('diff', '--exit-code', sourceSha, captureSha, '--', 'apps/web/src', 'packages')
  }
  await mkdir(root, { recursive: true })
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
  const deadline = setTimeout(() => {
    console.error(
      'speed:gate exceeded 285 seconds; reduce repetitions, keep all five actions. No baseline promoted.',
    )
    void cleanup().finally(() => process.exit(2))
  }, 285_000)
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(130))
    })

  async function openPage(surface: 'sidebar' | 'full', origin: string) {
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
    await page.addInitScript(
      ({ delayMs }) => {
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
        document.addEventListener(
          'click',
          () => {
            if (!delayMs || window.__speedCapture?.action !== 'sidebar-issue') return
            // The planted 50 ms is actual main-thread work before the app's click handler.
            const until = performance.now() + delayMs
            while (performance.now() < until) {
              /* planted regression */
            }
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
      { delayMs },
    )
    await page.goto(
      `${origin}/test/sidebar-acceptance.browser.html?mobxSidebar=1&scale=4&surface=${surface}&panelMode=chat`,
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
    }))
    if (
      state.mode !== 'pool' ||
      !state.pool ||
      (state.issues ?? 0) < 19_000 ||
      (state.sessions ?? 0) < 17_000
    )
      throw new Error(`Wrong 4× pool fixture: ${JSON.stringify(state)}`)
    return { page, cdp: await context.newCDPSession(page), context, errors }
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
      },
      { expected, trigger, action },
    )
    const stop = await traceStart(cdp)
    let events
    try {
      await perform()
      await page.waitForFunction(() => window.__speedCapture?.twoRaf)
    } finally {
      events = await stop()
      await page.evaluate(() => {
        window.__speedCapture = null
      })
    }
    const result = paintOf(events, 'speed:input', 'speed:dom')
    const errors = [...fixture.errors, ...(await page.evaluate(() => window.__acceptance.errors()))]
    if (errors.length) throw new Error(`Fixture errors: ${errors.join('; ')}`)
    return result.inputToPaintMs
  }

  async function suite(origin: string, fixed?: Targets) {
    const sidebar = await openPage('sidebar', origin)
    const full = await openPage('full', origin)
    const samples = Object.fromEntries(ACTIONS.map((action) => [action, [] as number[]])) as Record<
      Action,
      number[]
    >
    const loads: number[] = []
    try {
      const ids = await sidebar.page
        .locator('[data-issue-row]')
        .evaluateAll((nodes) => [
          ...new Set(
            nodes
              .filter((node) => node.getClientRects().length)
              .map((node) => node.getAttribute('data-issue-row')!),
          ),
        ])
      const shapes = (await sidebar.page.evaluate((ids) => window.__acceptance.shape(ids), ids))
        .filter((shape) => shape.root && shape.rows > 0)
        .sort((a, b) => b.rows - a.rows || a.id.localeCompare(b.id))
      const targets: Targets = fixed
        ? structuredClone(fixed)
        : {
            sidebar: shapes.slice(0, 2).map((shape) => shape.id),
            missions: shapes.slice(0, 2).map((shape) => shape.id),
            sessions: [],
            rename: shapes[0]!.id,
            background: shapes[1]!.id,
          }
      if (
        targets.sidebar.length !== 2 ||
        targets.missions.length !== 2 ||
        targets.sidebar.some((id) => !ids.includes(id))
      )
        throw new Error('The fixed target roots are missing')
      const measure = async (action: Action, run: (iteration: number) => Promise<number>) => {
        for (let i = -WARMUPS; i < REPETITIONS; i++) {
          const ms = await run(i + WARMUPS)
          await settle(
            action === 'sidebar-issue' || action === 'background-update' ? sidebar.page : full.page,
          )
          if (i >= 0) {
            samples[action].push(ms)
            loads.push(loadavg()[0]!)
          }
        }
        console.log(
          `${action}: median ${round(median(samples[action]))} ms, worst ${round(Math.max(...samples[action]))} ms (n=${REPETITIONS})`,
        )
      }
      await measure('sidebar-issue', async (i) => {
        const id = targets.sidebar[i % 2]!
        return capture(
          sidebar,
          'sidebar-issue',
          row(id),
          { selector: `${row(id)}[data-selected="true"]` },
          () => sidebar.page.locator(row(id)).first().click(),
        )
      })
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
      await settle(full.page)
      await measure('session-pane', async (i) => {
        const id = targets.sessions[i % 2]!
        const ms = await capture(
          full,
          'session-pane',
          deckSession(id),
          {
            selector: `[data-panel-resident][data-session="${id}"][data-pane] [data-testid="chat-surface"]`,
          },
          () => full.page.locator(deckSession(id)).first().click(),
        )
        if ((await full.page.evaluate(() => window.__acceptance.state().pane)) !== id)
          throw new Error('Session click routed to the wrong pane')
        return ms
      })
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
      await sidebar.page.locator(row(targets.sidebar[0]!)).first().click()
      await sidebar.page.locator(row(targets.background)).first().scrollIntoViewIfNeeded()
      await measure('background-update', async (i) => {
        const title = `Speed gate background ${i}`
        return capture(
          sidebar,
          'background-update',
          '',
          { selector: `${row(targets.background)} .shell-work-row-title`, text: title },
          () =>
            sidebar.page.evaluate(
              ({ id, title }) => {
                window.__speedCapture!.input = performance.now()
                performance.mark('speed:input')
                window.__acceptance.backgroundTitle(id, title)
              },
              { id: targets.background, title },
            ),
        )
      })
      const actions = Object.fromEntries(
        ACTIONS.map((action) => [
          action,
          {
            medianMs: round(median(samples[action])),
            worstMs: round(Math.max(...samples[action])),
          },
        ]),
      ) as Numbers
      return {
        targets,
        actions,
        samples,
        load: { min: Math.min(...loads), max: Math.max(...loads) },
      }
    } finally {
      await sidebar.context.close()
      await full.context.close()
    }
  }

  let exitCode = 2
  try {
    console.log(
      'Building ordinary, minified production web fixture (no profiling renderer or state instrumentation)…',
    )
    const { build } = await import('../node_modules/vite/dist/node/index.js')
    const { default: config } = await import('./sidebar-acceptance.vite')
    await build({
      ...config,
      configFile: false,
      logLevel: 'warn',
      plugins: config.plugins?.filter(
        (plugin) => (plugin as { name?: string })?.name !== 'acceptance-state-boundaries',
      ),
      build: { ...config.build, outDir: buildDir, sourcemap: false, minify: 'esbuild' },
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
    browser = await chromium.launch({
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
        '6m',
        '--wait',
        '--timeout',
        '30s',
        '--json',
      ])
      if (!grant?.granted) throw new Error('bench:flatblock was not granted')
      leased = !grant.alreadyHeld
    }
    const runs: Awaited<ReturnType<typeof suite>>[] = []
    for (let i = 0; i < (calibrate ? 3 : 1); i++) {
      console.log(`4× corpus, five actions; capture ${i + 1}/${calibrate ? 3 : 1}`)
      runs.push(await suite(origin, baseline?.targets ?? runs[0]?.targets))
    }
    const latest = runs[runs.length - 1]!
    const noise = calibrate
      ? (() => {
          const medianSpreadPercent = Object.fromEntries(
            ACTIONS.map((action) => {
              const medians = runs.map((run) => run.actions[action].medianMs)
              return [
                action,
                round(((Math.max(...medians) - Math.min(...medians)) / median(medians)) * 100),
              ]
            }),
          ) as Record<Action, number>
          return {
            runs: runs.length,
            medianSpreadPercent,
            maxPercent: Math.max(...Object.values(medianSpreadPercent)),
          }
        })()
      : baseline!.noise
    const regressions = calibrate
      ? []
      : ACTIONS.filter(
          (action) => latest.actions[action].medianMs > baseline!.actions[action].medianMs * 1.1,
        )
    const report = {
      version: 1,
      sourceSha,
      captureSha,
      dirtyProduct,
      machine,
      repetitions: REPETITIONS,
      warmups: WARMUPS,
      scale: 4,
      seed: 4443,
      metric:
        'trusted pointerdown (background: feed delivery) to first Chromium Paint after expected app DOM change',
      delayMs,
      ...latest,
      noise,
      calibrationMedians: calibrate ? runs.map((run) => run.actions) : undefined,
      baselineSha: baseline?.sourceSha,
      baselineActions: baseline?.actions,
      regressions,
      passed: !regressions.length,
      runtimeSeconds: round((performance.now() - began) / 1000),
    }
    await writeFile(resolve(root, 'last-run.json'), JSON.stringify(report, null, 2) + '\n')
    if (calibrate)
      await writeFile(
        baselinePath,
        JSON.stringify(
          {
            version: 1,
            sourceSha,
            landedRef: 'integrate/4286-pilot',
            machine,
            repetitions: REPETITIONS,
            scale: 4,
            seed: 4443,
            targets: latest.targets,
            actions: latest.actions,
            noise,
          } satisfies Baseline,
          null,
          2,
        ) + '\n',
      )
    if (report.passed && !delayMs)
      await writeFile(resolve(root, 'passed.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(
      `Measured same-code median spread: ${noise.maxPercent}% (three independent captures); fixed failure margin: 10%.`,
    )
    for (const action of ACTIONS)
      if (baseline)
        console.log(
          `${regressions.includes(action) ? 'RED' : 'green'} ${action}: ${latest.actions[action].medianMs} ms / landed ${baseline.actions[action].medianMs} ms (${round((latest.actions[action].medianMs / baseline.actions[action].medianMs - 1) * 100)}%)`,
        )
    console.log(
      `${report.passed ? 'SPEED GATE GREEN' : 'SPEED GATE RED'} — ${report.runtimeSeconds}s including production build; ${resolve(root, 'last-run.json')}`,
    )
    exitCode = report.passed ? 0 : 1
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
  console.error('SPEED GATE INVALID:', error)
  process.exit(2)
})
