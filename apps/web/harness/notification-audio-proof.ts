/** Cold pointer/keyboard audio comparison, using native contexts and a disposable page.
 * Run `bun run test:notification-audio -- --before=<base SHA>` on a test VM.
 * Only the two sound implementation files are replaced for the baseline.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { type BrowserType, chromium, webkit } from '@playwright/test'

const before = process.argv.find((arg) => arg.startsWith('--before='))?.slice(9)
if (!before) throw new Error('Pass --before=<base SHA> for the matched comparison')
const baseline = execFileSync('git', ['rev-parse', '--verify', `${before}^{commit}`], {
  encoding: 'utf8',
}).trim()
const out = resolve('.artifacts/notification-audio')
await mkdir(out, { recursive: true })
const sourceFiles = ['notification-sounds', 'cuelume'].map(
  (name) => `packages/client-core/src/sound/${name}.ts`,
)
const originals = new Map(
  sourceFiles.map((path) => [
    resolve(path),
    execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' }),
  ]),
)
const bundles: Record<string, string> = {}
for (const mode of ['before', 'after']) {
  const build = await Bun.build({
    entrypoints: [resolve('apps/web/harness/notification-audio-entry.ts')],
    conditions: ['@podium/source'],
    target: 'browser',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins:
      mode === 'before'
        ? [
            {
              name: 'baseline-audio',
              setup(builder) {
                builder.onLoad(
                  { filter: /\/sound\/(notification-sounds|cuelume)\.ts$/ },
                  async (args) => ({
                    contents: originals.get(args.path) ?? (await readFile(args.path, 'utf8')),
                    loader: 'ts',
                  }),
                )
              },
            },
          ]
        : [],
  })
  if (!build.success) throw new AggregateError(build.logs, `Build failed: ${mode}`)
  bundles[mode] = await build.outputs[0].text()
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/empty')
      return new Response('<!doctype html><title>Foreground tab</title>', {
        headers: { 'Content-Type': 'text/html' },
      })
    const mode = url.searchParams.get('mode') ?? 'after'
    if (url.pathname === '/bundle.js')
      return new Response(bundles[mode], { headers: { 'Content-Type': 'text/javascript' } })
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Notification audio probe</title><style>body{font:24px system-ui;padding:48px}button{font:inherit;padding:24px;background:#b8def8}</style><button>Change panel</button><script src="/bundle.js?mode=${mode}"></script>`,
      { headers: { 'Content-Type': 'text/html' } },
    )
  },
})
const browserEnv = { ...process.env }
const userLib = `${process.env.HOME}/.cache/podium-chromium-deps/root/usr/lib/x86_64-linux-gnu`
if (existsSync(userLib)) browserEnv.LD_LIBRARY_PATH = userLib
else delete browserEnv.LD_LIBRARY_PATH
const samples: unknown[] = []
async function measure(engine: BrowserType, mode: string, input: string, round: number) {
  const browser = await engine.launch({
    headless: true,
    env: browserEnv,
    args:
      engine === chromium
        ? ['--no-sandbox', '--autoplay-policy=document-user-activation-required']
        : [],
  })
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.port}/?mode=${mode}`)
    await page.waitForFunction(() => Reflect.get(window, '__audioProbe')?.started)
    await page.waitForTimeout(400)
    const before = await page.evaluate(() => ({
      data: Reflect.get(window, '__audioProbe'),
      states: Reflect.get(window, '__audioStates')(),
      activation: navigator.userActivation?.hasBeenActive,
    }))
    const trace: Array<{ name: string; dur?: number; args?: { data?: { type?: string } } }> = []
    const cdp = engine === chromium && round === 0 ? await context.newCDPSession(page) : null
    if (cdp) {
      cdp.on('Tracing.dataCollected', (event) => trace.push(...event.value))
      await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,blink.user_timing',
        transferMode: 'ReportEvents',
      })
    }
    if (input === 'pointer') await page.locator('button').click()
    else {
      await page.locator('button').focus()
      await page.keyboard.press('Enter')
    }
    await page.waitForFunction(() => Reflect.get(window, '__audioProbe').paints.length > 0)
    await page.waitForFunction(
      () =>
        Reflect.get(window, '__audioStates')().some(
          (state: { state: string }) => state.state === 'running',
        ),
      undefined,
      { timeout: 5000 },
    )
    const first = await page.evaluate(() => ({
      data: Reflect.get(window, '__audioProbe'),
      states: Reflect.get(window, '__audioStates')(),
    }))
    if (cdp) {
      const finished = new Promise<void>((resolve) =>
        cdp.once('Tracing.tracingComplete', () => resolve()),
      )
      await cdp.send('Tracing.end')
      await finished
      await writeFile(
        resolve(out, `${mode}-${input}-trace.json`),
        JSON.stringify({ traceEvents: trace }),
      )
    }
    // A later event-loop task, with the page behind another tab, must play a real cue.
    const front = await context.newPage()
    await front.goto(`http://127.0.0.1:${server.port}/empty`)
    await front.bringToFront()
    await page.evaluate(() => Reflect.get(window, '__emitNotification')())
    await page.waitForFunction(() => Reflect.get(window, '__audioProbe').oscillatorStarts > 0)
    await page.waitForTimeout(100)
    const later = await page.evaluate(() => ({
      data: Reflect.get(window, '__audioProbe'),
      states: Reflect.get(window, '__audioStates')(),
      visibility: document.visibilityState,
    }))
    const dispatch = trace
      .filter((event) => event.name === 'EventDispatch')
      .map((event) => ({ event: event.args?.data?.type, durationMs: (event.dur ?? 0) / 1000 }))
      .filter((event) => ['pointerdown', 'keydown', 'click'].includes(event.event))
    const sample = {
      engine: engine.name(),
      version: browser.version(),
      mode,
      input,
      round,
      before,
      first,
      later,
      errors,
      dispatch,
    }
    samples.push(sample)
    assert.equal(errors.length, 0, 'No browser exceptions')
    assert.notEqual(before.activation, true, 'No activation before the measured input')
    assert.equal(before.data.inputs.length, 0, 'No prior input in the measured tab')
    if (mode === 'after') {
      assert.equal(before.data.constructors.length, 1, 'Context prepared before input')
      assert.equal(first.data.constructors.length, 1, 'Input reuses the prepared context')
      assert.equal(first.data.constructors[0].event, null, 'Constructor ran outside input dispatch')
    }
    assert.ok(later.data.oscillatorStarts > 0, 'A later notification starts native sources')
    assert.ok(later.states[0].time > first.states[0].time, 'Audio clock advances after the gesture')
    console.log(
      JSON.stringify({
        engine: sample.engine,
        mode,
        inputType: input,
        round,
        preparedBeforeInput: before.data.constructors.length,
        constructor: first.data.constructors,
        events: first.data.inputs,
        dispatch,
        firstPaintMs: first.data.paints[0].time - (first.data.paints[0].input as number),
        cueStarts: later.data.oscillatorStarts,
        states: later.states,
        errors,
      }),
    )
  } finally {
    await browser.close()
  }
}
try {
  for (let round = 0; round < 3; round++) {
    for (const mode of round % 2 ? ['after', 'before'] : ['before', 'after']) {
      for (const input of ['pointer', 'keyboard']) await measure(chromium, mode, input, round)
    }
  }
  for (const input of ['pointer', 'keyboard']) {
    try {
      await measure(webkit, 'after', input, 0)
    } catch (error) {
      samples.push({ engine: 'webkit', input, error: String(error) })
      console.log(`WebKit ${input}: ${String(error).slice(0, 1200)}`)
    }
  }
} finally {
  server.stop(true)
  await writeFile(
    resolve(out, 'measurements.json'),
    JSON.stringify(
      {
        baseline,
        tip: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        comparisonFiles: sourceFiles,
        samples,
      },
      null,
      2,
    ),
  )
  console.log(`Evidence: ${relative(process.cwd(), out)}`)
}
