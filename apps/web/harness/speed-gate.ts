/** Fixed production-browser continuation of selection-runtime / POD-5077. */
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { arch, cpus, hostname, loadavg, platform } from 'node:os'
import { extname, resolve } from 'node:path'
import { type Browser, chromium, type Page } from '@playwright/test'
import { paintOf, traceStart } from './browser-paint'
import { promoteSpeedBaseline } from './speed-baseline'
import {
  assertSpeedSwitches,
  parseSpeedSwitches,
  speedSwitchReport,
  speedSwitchUrl,
} from './speed-switches'

const ACTIONS = [
  'sidebar-issue',
  'mission-switch',
  'session-pane',
  'issue-rename',
  'background-update',
] as const
type Action = (typeof ACTIONS)[number]
type MeasuredAction = Action | 'issue-page-open'
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
type MissionClicks = {
  scale: 1 | 4
  targets: string[]
  firstClickMs: number
  revisitMs: number
}
type MissionClickBaseline = {
  sourceSha: string
  machine: Machine
  seed: 4443
  missionClicks: MissionClicks[]
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
  action: MeasuredAction
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
const structuralOnly = args.includes('--structural-only')
const missionClicksOnly = args.includes('--mission-clicks-only')
const missionBaselinePath = value('mission-click-baseline', '')
const delayMs = Number(value('plant-delay-ms', '0'))
const root = resolve('.artifacts/speed-gate')
const buildDir = resolve(root, 'build')
const baselinePath = resolve('docs/measurements/click-speed-baseline.json')
// Ten samples in each of the three initial captures exceeded 285 s on flatblock.
const REPETITIONS = 6
const WARMUPS = 2
const NOISE_RUNS = 2
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
      'bun run speed:gate — flatblock, five actions × six samples; median > landed +10% exits 1.\n' +
        '--structural-only: focused 1×/4× reader/click/delta counts, parity and negative controls; no timing or lease.\n' +
        '--calibrate --baseline-ref=<landed SHA/ref>: initial baseline only, two runs to measure noise.\n' +
        '--plant-delay-ms=50: plant a synchronous delay in the sidebar click path (expected red).\n' +
        '--promote: commit-ready baseline from the saved green run after its source lands; no rerun.\n' +
        '--mission-clicks-only: diagnostic first click and revisit once at 1×/4×; no structural or five-action gate and no promotion.\n' +
        '--mission-click-baseline=<json>: add those cold captures to the normal gate and compare with the saved pre-change capture.\n' +
        '--switch=<urlKey>=<0|1>: repeatable startup URL overrides; other settings stay fixed.\n' +
        '--external-lease: signal CAPTURE_READY after preparation, then await the caller lease.json; signal CAPTURE_FINISHED after cleanup.\n' +
        '--lease-confirmed: caller already holds bench:flatblock (remote capture).',
    )
    process.exit(0)
  }
  for (const arg of args)
    if (
      ![
        '--calibrate', '--promote', '--lease-confirmed', '--external-lease', '--structural-only', '--mission-clicks-only',
      ].includes(arg) &&
      !arg.startsWith('--plant-delay-ms=') &&
      !arg.startsWith('--switch=') &&
      !arg.startsWith('--baseline-ref=') &&
      !arg.startsWith('--mission-click-baseline=')
    )
      throw new Error(`Unknown argument ${arg}`)
  const switches = parseSpeedSwitches(args)
  if (args.includes('--external-lease') && args.includes('--lease-confirmed'))
    throw new Error('Choose one caller-owned lease mode')
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
  if (structuralOnly && (calibrate || promote || delayMs))
    throw new Error('Structural-only cannot measure or promote timing')
  if (
    (missionClicksOnly || missionBaselinePath) &&
    (calibrate || promote || structuralOnly || delayMs)
  )
    throw new Error('Mission click capture cannot calibrate, promote, plant delays or run structural-only')

  // Structural work is a separate, untimed process: no instrumentation in the
  // production browser and no benchmark lease held across a focused test lane.
  if (!promote && !missionClicksOnly) {
    const status = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, ['run', 'speed:structural'], { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', done)
    })
    if (status !== 0) throw new Error(`Structural per-click guard failed (exit ${status})`)
    if (structuralOnly) {
      console.log(
        'STRUCTURAL WORK GATE GREEN — known failures retain their owning issues; no timings collected.',
      )
      return
    }
  }

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
      JSON.stringify(promoteSpeedBaseline(baseline!, report), null, 2) + '\n',
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
    git('status', '--porcelain', '--untracked-files=normal', '--', 'apps/web/src', 'packages')
      .length > 0
  if (calibrate) {
    if (dirtyProduct)
      throw new Error('First baseline must measure the unchanged landed integration product tree')
    // The committed measurement code may sit above the landing being measured.
    git('diff', '--exit-code', sourceSha, captureSha, '--', 'apps/web/src', 'packages')
  }
  await mkdir(root, { recursive: true })
  console.log(`SPEED_GATE_PID ${process.pid}`)
  const began = performance.now()
  let leased = false
  let externalGranted = false
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
      if (externalGranted) console.log('CAPTURE_FINISHED')
    })()
    await cleaning
  }
  const deadline = setTimeout(() => {
    console.error(`speed:gate exceeded 285 seconds. No baseline promoted.`)
    void cleanup().finally(() => process.exit(2))
  }, 285_000)
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(130))
    })

  async function openPage(
    surface: 'sidebar' | 'full' | 'page',
    origin: string,
    measured = false,
    scale: 1 | 4 = 4,
  ) {
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
      { delayMs: delayMs },
    )
    await page.goto(
      speedSwitchUrl(
        `${origin}/test/sidebar-acceptance.browser.html?scale=${scale}&surface=${surface}&panelMode=chat${measured ? '&measure=1' : ''}`,
        switches,
      ),
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
    assertSpeedSwitches(state.switches, switches)
    if (
      state.mode !== 'pool' ||
      !state.pool ||
      (state.issues ?? 0) < 4_750 * scale ||
      (state.sessions ?? 0) < 4_250 * scale
    )
      throw new Error(`Wrong ${scale}× pool fixture: ${JSON.stringify(state)}`)
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
    action: MeasuredAction,
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
    let events: Awaited<ReturnType<typeof stop>>
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
      throw new Error(`${action} did not paint: ${JSON.stringify({ ...diagnostic, browserErrors: fixture.errors })}`, { cause: error })
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
          await settle(action === 'sidebar-issue' ? sidebar.page : full.page)
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
      await full.page.waitForFunction(
        (id) => window.__acceptance.state().pane === id,
        targets.sessions[1]!,
      )
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

  async function coldMissions(origin: string, before?: MissionClickBaseline) {
    const results: MissionClicks[] = []
    for (const scale of [1, 4] as const) {
      // A fresh context starts with no selected mission, so the first click has
      // no observed pane/model. Switching away unmounts it before the revisit.
      const full = await openPage('full', origin, false, scale)
      try {
        if (await full.page.evaluate(() => window.__acceptance.state().selected))
          throw new Error('Cold mission capture needs an unselected fixture')
        const ids = await full.page.locator('[data-issue-row]').evaluateAll((nodes) => [
          ...new Set(nodes.filter((node) => node.getClientRects().length)
            .map((node) => node.getAttribute('data-issue-row')!)),
        ])
        const prior = before?.missionClicks.find((clicks) => clicks.scale === scale)
        // Run the same legacy shape preflight in both arms; it must not warm
        // only the old product while the new product starts with cold rows.
        const shapes = (await full.page.evaluate((ids) => window.__acceptance.shape(ids), ids))
          .filter((shape) => shape.root && shape.rows > 0)
          .sort((a, b) => b.rows - a.rows || a.id.localeCompare(b.id))
        const targets = prior?.targets ?? shapes.slice(0, 2).map((shape) => shape.id)
        if (targets.length !== 2 || targets.some((id) => !ids.includes(id)))
          throw new Error(`Missing cold mission targets at ${scale}×`)
        const click = async (id: string) => {
          const ms = await capture(
            full, 'mission-switch', row(id),
            { selector: `[data-fixture-mission="${id}"] [data-testid="flight-deck-scroller"]` },
            () => full.page.locator(row(id)).first().click(),
          )
          if ((await full.page.evaluate(() => window.__acceptance.state().selected)) !== id)
            throw new Error('Cold mission click routed to the wrong issue')
          return round(ms)
        }
        const firstClickMs = await click(targets[0]!)
        await full.page.locator(row(targets[1]!)).first().click()
        await settle(full.page)
        const revisitMs = await click(targets[0]!)
        results.push({ scale, targets, firstClickMs, revisitMs })
        console.log(`${scale}× mission: first ${firstClickMs} ms; revisit ${revisitMs} ms (one capture each)`)
      } finally {
        await full.context.close()
      }
    }
    return results
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
    const launchBrowser = () =>
      chromium.launch({
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
    const missionBefore: MissionClickBaseline | undefined = missionBaselinePath
      ? JSON.parse(await readFile(resolve(missionBaselinePath), 'utf8'))
      : undefined
    if (
      missionBefore &&
      (!same(machine, missionBefore.machine) || missionBefore.seed !== 4443 ||
        [1, 4].some((scale) => !missionBefore.missionClicks.some((clicks) =>
          clicks.scale === scale && clicks.targets.length === 2 &&
          clicks.firstClickMs > 0 && clicks.revisitMs > 0)))
    )
      throw new Error('Mission comparison needs both scales on the same machine/browser and seed')
    if (args.includes('--external-lease')) {
      // flatblock has no operator CLI. Its caller takes the existing benchmark
      // lock only after this production build/browser are ready, and releases
      // it immediately after CAPTURE_FINISHED, including a failed capture.
      const leasePath = resolve(root, 'lease.json')
      await rm(leasePath, { force: true })
      const token = crypto.randomUUID()
      console.log(`CAPTURE_READY ${token}`)
      const leaseDeadline = performance.now() + 60_000
      for (;;) {
        try {
          const lease = JSON.parse(await readFile(leasePath, 'utf8'))
          if (lease.token !== token || lease.name !== 'bench:flatblock' || !lease.grant?.data?.granted)
            throw new Error('Invalid caller benchmark lease')
          externalGranted = true
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (performance.now() >= leaseDeadline) throw new Error('Caller benchmark lease timed out')
          await new Promise((done) => setTimeout(done, 100))
        }
      }
    } else if (!args.includes('--lease-confirmed')) {
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
    console.log(`Production build and browser ready: ${round((performance.now() - began) / 1000)}s`)
    const missionClicks = missionClicksOnly || missionBefore
      ? await coldMissions(origin, missionBefore)
      : undefined
    const missionRegressions = missionBefore ? missionClicks?.flatMap((clicks) => {
      const prior = missionBefore.missionClicks.find((before) => before.scale === clicks.scale)!
      return (['firstClickMs', 'revisitMs'] as const)
        .filter((kind) => clicks[kind] > prior[kind])
        .map((kind) => ({ scale: clicks.scale, kind, beforeMs: prior[kind], afterMs: clicks[kind] }))
    }) ?? [] : []
    if (missionClicksOnly) {
      await writeFile(resolve(root, 'mission-clicks.json'), JSON.stringify({
        sourceSha, captureSha, dirtyProduct, machine, seed: 4443, missionClicks,
        missionBaselineSha: missionBefore?.sourceSha,
        missionRegressions,
        metric: 'trusted pointerdown to first Chromium Paint after expected mission DOM change',
        diagnosticOnly: true,
        runtimeSeconds: round((performance.now() - began) / 1000),
      }, null, 2) + '\n')
      console.log('MISSION CLICK CAPTURE ONLY — structural and five-action gates were not run; no baseline promoted.')
      exitCode = 0
      return
    }
    for (let i = 0; i < (calibrate ? NOISE_RUNS : 1); i++) {
      if (i) {
        await browser.close()
        browser = await launchBrowser()
      }
      console.log(`4× corpus, five actions; capture ${i + 1}/${calibrate ? NOISE_RUNS : 1}`)
      runs.push(await suite(origin, baseline?.targets ?? runs[0]?.targets))
      console.log(`Capture complete; elapsed ${round((performance.now() - began) / 1000)}s`)
    }
    const latest = runs[0]!
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
      missionClicks,
      missionBaselineSha: missionBefore?.sourceSha,
      missionRegressions,
      passed: !regressions.length && !missionRegressions.length,
      runtimeSeconds: round((performance.now() - began) / 1000),
      ...speedSwitchReport(switches),
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
      `Measured same-code median spread: ${noise.maxPercent}% (${noise.runs} independent captures); fixed failure margin: 10%.`,
    )
    for (const action of ACTIONS)
      if (baseline)
        console.log(
          `${regressions.includes(action) ? 'RED' : 'green'} ${action}: ${latest.actions[action].medianMs} ms / landed ${baseline.actions[action].medianMs} ms (${round((latest.actions[action].medianMs / baseline.actions[action].medianMs - 1) * 100)}%)`,
        )
    for (const regression of missionRegressions)
      console.log(`RED ${regression.scale}× mission ${regression.kind}: ${regression.afterMs} ms / before ${regression.beforeMs} ms`)
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
