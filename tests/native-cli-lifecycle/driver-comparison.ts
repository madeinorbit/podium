/**
 * Live comparison runner for Podium's headed and headless Agent Runtime drivers.
 *
 * Start an isolated source host with info logging and pass its NDJSON path. The
 * runner uses only the public tRPC and client WebSocket doors; lifecycle clocks
 * come back out of the structured daemon timing records added for this benchmark.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { hostname, loadavg, platform, release } from 'node:os'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import { TerminalProbe } from './terminal-probe'

const PROMPT = 'Reply with exactly BENCH_OK and nothing else. Do not use tools.'
const HEADED_EXPECTED = 'DRIVER_OK'
const HEADED_PROMPT = 'Reply with exactly DRIVER, then _, then OK; no spaces. Do not use tools.'
const TIMING_NAMESPACE = 'daemon:agent-runtime-timing'
const TIMING_MESSAGE = 'agent runtime timing stage'
const WIRE_VERSION = 2

type Provider = 'claude' | 'codex' | 'grok' | 'opencode'
type Mode = 'headed' | 'headless'

interface ProviderConfig {
  agentKind: 'claude-code' | 'codex' | 'grok' | 'opencode'
  headedDriver: string
  headlessDriver: string
  attach: boolean
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  claude: {
    agentKind: 'claude-code',
    headedDriver: 'claude-pty',
    headlessDriver: 'claude-sdk',
    attach: false,
  },
  codex: {
    agentKind: 'codex',
    headedDriver: 'generic-pty',
    headlessDriver: 'codex-app-server',
    attach: true,
  },
  grok: {
    agentKind: 'grok',
    headedDriver: 'generic-pty',
    headlessDriver: 'grok-acp',
    attach: true,
  },
  opencode: {
    agentKind: 'opencode',
    headedDriver: 'generic-pty',
    headlessDriver: 'opencode-server',
    attach: true,
  },
}

interface TimingRecord {
  ts: string
  ns: string
  msg: string
  sessionId: string
  stage: string
  lane: 'launch' | 'turn' | 'attach'
  durationMs: number
  harness: string
  driverId?: string
  runtimeMode?: Mode
  attempt?: number
  [field: string]: unknown
}

interface DriverSample {
  provider: Provider
  mode: Mode
  driverId: string
  run: number
  sessionId?: string
  startedAt: string
  outcome: 'ok' | 'failed'
  error?: string
  records: TimingRecord[]
  stages: Record<string, number>
  wall: {
    sessionReadyToAttachInputReadyMs?: number
    sessionRequestedToComposerReadyMs?: number
    sessionReadyToComposerReadyMs?: number
    attachRequestedToComposerReadyMs?: number
    promptSubmittedToNextComposerReadyMs?: number
    promptSubmittedToResponseVisibleMs?: number
  }
}

interface Options {
  baseUrl: string
  log: string
  output: string
  markdown: string
  baseline: string
  runs: number
  workdir: string
  providers: Provider[]
  modes: Mode[]
  mergeResults?: string[]
  timeoutMs: number
}

interface BaselineSample {
  start?: { sessionReadyMs?: number }
  drive?: { promptAcceptedMs?: number; firstResponseMs?: number; completeMs?: number }
  attach?: {
    firstByteMs?: number
    inputReadyMs?: number
    sessionReadyToInputReadyMs?: number
  }
}

interface NativeSample {
  timing?: {
    firstByteMs?: number
    inputReadyMs?: number
    responseVisibleMs?: number
    nextInputReadyMs?: number
  }
}

interface BaselineProvider {
  nativeSamples?: NativeSample[]
  samples?: BaselineSample[]
}

interface BaselineReport {
  generatedAt: string
  providers: Record<Provider, BaselineProvider>
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`)
    values.set(token.slice(2), value)
    index += 1
  }
  const output = resolve(values.get('output') ?? 'results/driver-comparison.json')
  return {
    baseUrl: values.get('base-url') ?? 'http://127.0.0.1:18828',
    log: resolve(values.get('log') ?? '/tmp/podium-driver-timing/logs/host.ndjson'),
    output,
    markdown: resolve(values.get('markdown') ?? output.replace(/\.json$/u, '.md')),
    baseline: resolve(values.get('baseline') ?? 'results/native-cli-lifecycle-2026-08-30.json'),
    runs: Number(values.get('runs') ?? 3),
    workdir: resolve(values.get('workdir') ?? process.cwd()),
    providers: (values.get('providers')?.split(',') ?? Object.keys(PROVIDERS)) as Provider[],
    modes: (values.get('modes')?.split(',') ?? ['headed', 'headless']) as Mode[],
    ...(values.get('merge-results')
      ? {
          mergeResults: values
            .get('merge-results')!
            .split(',')
            .map((path) => resolve(path)),
        }
      : {}),
    timeoutMs: Number(values.get('timeout-ms') ?? 300_000),
  }
}

async function trpc<T>(baseUrl: string, procedure: string, input: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/trpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as {
    result?: { data?: T | { json: T } }
    error?: { message?: string; json?: { message?: string } }
  }
  if (!response.ok || body.error) {
    throw new Error(
      body.error?.json?.message ?? body.error?.message ?? `${procedure}: HTTP ${response.status}`,
    )
  }
  const data = body.result?.data
  if (data && typeof data === 'object' && 'json' in data) return data.json
  return data as T
}

async function timingRecords(logPath: string, sessionId: string): Promise<TimingRecord[]> {
  const text = await readFile(logPath, 'utf8')
  const records: TimingRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.includes(TIMING_NAMESPACE) || !line.includes(sessionId)) continue
    try {
      const record = JSON.parse(line) as TimingRecord
      if (
        record.ns === TIMING_NAMESPACE &&
        record.msg === TIMING_MESSAGE &&
        record.sessionId === sessionId
      ) {
        records.push(record)
      }
    } catch {
      // The active file can end in an incomplete line while the sink appends.
    }
  }
  return records
}

async function waitForStage(
  options: Options,
  sessionId: string,
  stages: string[],
  timeoutMs = options.timeoutMs,
): Promise<TimingRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const records = await timingRecords(options.log, sessionId)
    const failure = records.find((record) =>
      [
        'session_failed',
        'turn_failed',
        'attach_refused',
        'prompt_refused',
        'prompt_unverified',
        'prompt_queued',
      ].includes(record.stage),
    )
    if (failure && !stages.includes(failure.stage)) {
      throw new Error(`${failure.stage}: ${String(failure.detail ?? failure.reason ?? 'unknown')}`)
    }
    const found = [...records].reverse().find((record) => stages.includes(record.stage))
    if (found) return found
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${stages.join(' or ')}`)
}

class NativeViewClient {
  readonly #socket: WebSocket
  readonly #probe = new TerminalProbe()

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on('message', (raw) => this.#probe.onMessage(raw))
  }

  static async connect(baseUrl: string): Promise<NativeViewClient> {
    const url = new URL(baseUrl)
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${url.host}/client?v=${WIRE_VERSION}`)
    await new Promise<void>((resolveOpen, reject) => {
      socket.once('open', resolveOpen)
      socket.once('error', reject)
    })
    socket.send(
      JSON.stringify({
        type: 'hello',
        clientId: `driver-comparison-${process.pid}`,
        viewport: { cols: 100, rows: 30, dpr: 1 },
        wireVersion: WIRE_VERSION,
      }),
    )
    await sleep(200)
    return new NativeViewClient(socket)
  }

  show(sessionId: string, mode: 'native' | 'chat'): void {
    if (mode === 'native') this.#probe.reset(sessionId)
    this.#socket.send(JSON.stringify({ type: 'attach', sessionId }))
    this.#socket.send(
      JSON.stringify({
        type: 'viewState',
        visible: [sessionId],
        focused: sessionId,
        modes: { [sessionId]: mode },
      }),
    )
  }

  async submitPrompt(provider: Provider, sessionId: string, prompt: string): Promise<number> {
    const send = (bytes: string): void =>
      this.#socket.send(
        JSON.stringify({
          type: 'input',
          sessionId,
          data: Buffer.from(bytes, 'utf8').toString('base64'),
        }),
      )
    send(provider === 'grok' ? '\x01\x0b' : '\x15')
    await sleep(75)
    send(provider === 'grok' ? prompt : '\x1b[200~' + prompt + '\x1b[201~')
    await sleep(250)
    const submittedAt = Date.now()
    send('\r')
    return submittedAt
  }

  waitForText(sessionId: string, expected: string, timeoutMs: number): Promise<number> {
    return this.#probe.waitForText(sessionId, expected, timeoutMs)
  }

  waitInputReady(provider: Provider, sessionId: string, timeoutMs: number): Promise<number> {
    return this.#probe.waitForInput(
      provider,
      sessionId,
      (bytes) =>
        this.#socket.send(
          JSON.stringify({
            type: 'input',
            sessionId,
            data: Buffer.from(bytes, 'utf8').toString('base64'),
          }),
        ),
      timeoutMs,
    )
  }

  clear(sessionId: string): void {
    this.#probe.dispose(sessionId)
    this.#socket.send(JSON.stringify({ type: 'detach', sessionId }))
    this.#socket.send(JSON.stringify({ type: 'viewState', visible: [], focused: null, modes: {} }))
  }

  close(): void {
    this.#probe.close()
    this.#socket.close()
  }
}

function stagesOf(records: TimingRecord[]): Record<string, number> {
  const stages: Record<string, number> = {}
  for (const record of records) stages[record.stage] ??= record.durationMs
  return stages
}

function wallDelta(records: TimingRecord[], from: string, to: string): number | undefined {
  const first = records.find((record) => record.stage === from)
  const last = records.find((record) => record.stage === to)
  if (!first || !last) return undefined
  return Math.round((Date.parse(last.ts) - Date.parse(first.ts)) * 1_000) / 1_000
}

function captureSample(
  sample: DriverSample,
  records: TimingRecord[],
  composerReadyAt: number | undefined,
): void {
  sample.records = records
  sample.stages = stagesOf(records)
  sample.wall.sessionReadyToAttachInputReadyMs = wallDelta(
    records,
    'session_ready',
    'native_cli_input_ready',
  )
  if (composerReadyAt === undefined) return
  const from = (stage: string): number | undefined => {
    const record = records.find((candidate) => candidate.stage === stage)
    return record
      ? Math.round((composerReadyAt - Date.parse(record.ts)) * 1_000) / 1_000
      : undefined
  }
  sample.wall.sessionRequestedToComposerReadyMs = from('session_requested')
  sample.wall.sessionReadyToComposerReadyMs = from('session_ready')
  sample.wall.attachRequestedToComposerReadyMs = from('attach_requested')
}

async function runSample(
  options: Options,
  view: NativeViewClient,
  provider: Provider,
  mode: Mode,
  run: number,
): Promise<DriverSample> {
  const config = PROVIDERS[provider]
  const driverId = mode === 'headed' ? config.headedDriver : config.headlessDriver
  const sample: DriverSample = {
    provider,
    mode,
    driverId,
    run,
    startedAt: new Date().toISOString(),
    outcome: 'failed',
    records: [],
    stages: {},
    wall: {},
  }
  let sessionId: string | undefined
  let composerReadyAt: number | undefined
  let promptSubmittedAt: number | undefined
  try {
    const created = await trpc<{ sessionId: string }>(options.baseUrl, 'sessions.create', {
      agentKind: config.agentKind,
      cwd: options.workdir,
      runtimeContract: driverId,
    })
    sessionId = created.sessionId
    sample.sessionId = sessionId
    await waitForStage(options, sessionId, ['session_ready'], 120_000)

    if (mode === 'headless' && config.attach) {
      view.show(sessionId, 'native')
      await waitForStage(options, sessionId, ['native_cli_input_ready'], 120_000)
      composerReadyAt = await view.waitInputReady(
        provider,
        sessionId,
        Math.min(options.timeoutMs, 120_000),
      )
      view.show(sessionId, 'chat')
      await sleep(500)
    } else if (mode === 'headed') {
      view.show(sessionId, 'native')
      composerReadyAt = await view.waitInputReady(
        provider,
        sessionId,
        Math.min(options.timeoutMs, 120_000),
      )
      await sleep(750)
    } else {
      view.show(sessionId, 'chat')
      await sleep(200)
    }
    if (mode === 'headed') {
      promptSubmittedAt = await view.submitPrompt(provider, sessionId, HEADED_PROMPT)
      const responseVisibleAt = await view.waitForText(
        sessionId,
        HEADED_EXPECTED,
        options.timeoutMs,
      )
      sample.wall.promptSubmittedToResponseVisibleMs = responseVisibleAt - promptSubmittedAt
      const nextReadyAt = await view.waitInputReady(
        provider,
        sessionId,
        Math.min(options.timeoutMs, 120_000),
      )
      sample.wall.promptSubmittedToNextComposerReadyMs = nextReadyAt - promptSubmittedAt
    } else {
      const receipt = await trpc<{ outcome?: string; ok?: boolean }>(
        options.baseUrl,
        'sessions.sendText',
        { sessionId, text: PROMPT },
      )
      if (receipt.outcome === 'refused' || receipt.ok === false) {
        throw new Error(`send refused: ${JSON.stringify(receipt)}`)
      }
      await waitForStage(options, sessionId, ['prompt_accepted'], 30_000)
      await waitForStage(options, sessionId, ['turn_completed'], options.timeoutMs)
    }
    captureSample(sample, await timingRecords(options.log, sessionId), composerReadyAt)
    sample.outcome = 'ok'
  } catch (error) {
    sample.error = error instanceof Error ? error.message : String(error)
    if (sessionId) {
      captureSample(sample, await timingRecords(options.log, sessionId), composerReadyAt)
    }
  } finally {
    if (sessionId) {
      view.clear(sessionId)
      try {
        await trpc(options.baseUrl, 'sessions.kill', { sessionId })
      } catch {
        // Preserve the measured result; teardown failure is visible in the host log.
      }
      await sleep(500)
    }
  }
  return sample
}

function median(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => Number.isFinite(value))
  if (present.length === 0) return undefined
  present.sort((left, right) => left - right)
  const middle = Math.floor(present.length / 2)
  return present.length % 2 === 1
    ? present[middle]
    : ((present[middle - 1] ?? 0) + (present[middle] ?? 0)) / 2
}

const format = (value: number | undefined): string =>
  value === undefined ? 'N/A' : `${value.toFixed(1)} ms`

const ratio = (actual: number | undefined, ideal: number | undefined): string =>
  actual === undefined || ideal === undefined || ideal === 0
    ? 'N/A'
    : `${(actual / ideal).toFixed(2)}×`

function baselineMedian<T>(
  samples: T[] | undefined,
  pick: (sample: T) => number | undefined,
): number | undefined {
  return median((samples ?? []).map(pick))
}

function renderMarkdown(
  generatedAt: string,
  options: Options,
  samples: DriverSample[],
  baseline: BaselineReport,
): string {
  const lines = [
    '# Podium driver timing comparison',
    '',
    `Measured ${generatedAt} on ${hostname()} (${platform()} ${release()}). Standalone baseline: ${baseline.generatedAt}.`,
    `Each cell is the median of up to ${options.runs} sequential live samples. Headed prompt: ${HEADED_PROMPT} Headless prompt: ${PROMPT}`,
    '',
    '## 1. Headed driver vs stock native CLI',
    '',
    '| Provider | Samples | Podium first output | Direct first byte | Ratio | Podium composer ready | Direct input ready | Ratio | Podium bind ready | Podium response visible | Direct response visible | Podium turn complete | Podium next composer | Direct next input |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]

  for (const provider of options.providers) {
    const actual = samples.filter(
      (sample) => sample.provider === provider && sample.mode === 'headed',
    )
    const ok = actual.filter((sample) => sample.outcome === 'ok')
    const native = baseline.providers[provider].nativeSamples
    const firstOutput = median(ok.map((sample) => sample.stages.native_cli_first_output))
    const directFirst = baselineMedian(native, (sample) => sample.timing?.firstByteMs)
    lines.push(
      `| ${provider} | ${ok.length}/${actual.length} | ${format(firstOutput)} | ${format(directFirst)} | ${ratio(firstOutput, directFirst)} | ${format(median(ok.map((sample) => sample.wall.sessionRequestedToComposerReadyMs)))} | ${format(baselineMedian(native, (sample) => sample.timing?.inputReadyMs))} | ${ratio(
        median(ok.map((sample) => sample.wall.sessionRequestedToComposerReadyMs)),
        baselineMedian(native, (sample) => sample.timing?.inputReadyMs),
      )} | ${format(median(ok.map((sample) => sample.stages.session_ready)))} | ${format(median(ok.map((sample) => sample.wall.promptSubmittedToResponseVisibleMs)))} | ${format(baselineMedian(native, (sample) => sample.timing?.responseVisibleMs))} | ${format(median(ok.map((sample) => sample.stages.turn_completed)))} | ${format(median(ok.map((sample) => sample.wall.promptSubmittedToNextComposerReadyMs)))} | ${format(baselineMedian(native, (sample) => sample.timing?.nextInputReadyMs))} |`,
    )
  }

  lines.push(
    '',
    'Podium composer readiness uses the same visible, non-submitted punctuation probe as the direct benchmark. Podium bind readiness remains separate because the first live sample proved a bound PTY can still be too early for input. Response clocks in both columns start at prompt submission.',
    '',
    '## 2. Headless driver vs direct machine interface',
    '',
    '| Provider | Samples | Podium session ready | Direct session ready | Podium accepted | Direct accepted | Podium first response | Direct first response | Ratio | Podium complete | Direct complete | Ratio |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  )

  for (const provider of options.providers) {
    const actual = samples.filter(
      (sample) => sample.provider === provider && sample.mode === 'headless',
    )
    const ok = actual.filter((sample) => sample.outcome === 'ok')
    const direct = baseline.providers[provider].samples
    const first = median(ok.map((sample) => sample.stages.turn_first_response))
    const directFirst = baselineMedian(direct, (sample) => sample.drive?.firstResponseMs)
    const complete = median(ok.map((sample) => sample.stages.turn_completed))
    const directComplete = baselineMedian(direct, (sample) => sample.drive?.completeMs)
    lines.push(
      `| ${provider} | ${ok.length}/${actual.length} | ${format(median(ok.map((sample) => sample.stages.session_ready)))} | ${format(baselineMedian(direct, (sample) => sample.start?.sessionReadyMs))} | ${format(median(ok.map((sample) => sample.stages.prompt_accepted)))} | ${format(baselineMedian(direct, (sample) => sample.drive?.promptAcceptedMs))} | ${format(first)} | ${format(directFirst)} | ${ratio(first, directFirst)} | ${format(complete)} | ${format(directComplete)} | ${ratio(complete, directComplete)} |`,
    )
  }

  lines.push(
    '',
    'All turn clocks start when Podium receives `sessions.sendText`. Claude SDK creates a lazy driver handle at launch, then starts its process-per-turn query on send; its direct baseline folds SDK initialization into the prompt clock, so turn first/complete are the comparable Claude values, not `session ready` or `accepted`.',
    '',
    '## 3. Podium headless session → native CLI attach',
    '',
    '| Provider | Samples | Podium session → composer | Direct session → input | Ratio | Podium attach → composer | Direct attach input | Ratio | Podium first output | Direct first byte | Internal writable | Endpoint ready |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  )

  for (const provider of options.providers) {
    const actual = samples.filter(
      (sample) => sample.provider === provider && sample.mode === 'headless',
    )
    const ok = actual.filter((sample) => sample.outcome === 'ok')
    const direct = baseline.providers[provider].samples
    if (!PROVIDERS[provider].attach) {
      lines.push(
        `| ${provider} | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |`,
      )
      continue
    }
    const attachInput = median(ok.map((sample) => sample.stages.native_cli_input_ready))
    const directInput = baselineMedian(direct, (sample) => sample.attach?.inputReadyMs)
    lines.push(
      `| ${provider} | ${ok.length}/${actual.length} | ${format(median(ok.map((sample) => sample.wall.sessionReadyToComposerReadyMs)))} | ${format(baselineMedian(direct, (sample) => sample.attach?.sessionReadyToInputReadyMs))} | ${ratio(
        median(ok.map((sample) => sample.wall.sessionReadyToComposerReadyMs)),
        baselineMedian(direct, (sample) => sample.attach?.sessionReadyToInputReadyMs),
      )} | ${format(median(ok.map((sample) => sample.wall.attachRequestedToComposerReadyMs)))} | ${format(directInput)} | ${ratio(median(ok.map((sample) => sample.wall.attachRequestedToComposerReadyMs)), directInput)} | ${format(median(ok.map((sample) => sample.stages.native_cli_first_output)))} | ${format(baselineMedian(direct, (sample) => sample.attach?.firstByteMs))} | ${format(attachInput)} | ${format(median(ok.map((sample) => sample.stages.attach_endpoint_ready)))} |`,
    )
  }

  const failures = samples.filter((sample) => sample.outcome === 'failed')
  lines.push(
    '',
    'Claude SDK native attach is N/A: the current embedded driver intentionally exposes no native CLI attach endpoint. Codex, Grok, and OpenCode attach through the same client-terminal path the native Podium view uses. Composer readiness is the human-usable probe; “Internal writable” and “Endpoint ready” expose how much earlier the driver considers the attach operational.',
    '',
    '## Sample failures',
    '',
  )
  if (failures.length === 0) lines.push('None.')
  else {
    for (const sample of failures) {
      lines.push(
        `- ${sample.provider} ${sample.mode} run ${sample.run}: ${sample.error ?? 'unknown'}`,
      )
    }
  }
  lines.push(
    '',
    'The sibling JSON contains every structured timing record and per-sample value. Provider load, account tier, page cache, host load, model choice, and workspace configuration remain part of this live observation.',
    '',
  )
  return lines.join('\n')
}

const options = parseArgs(process.argv.slice(2))
const baseline = JSON.parse(await readFile(options.baseline, 'utf8')) as BaselineReport
const samples: DriverSample[] = []
if (options.mergeResults) {
  for (const path of options.mergeResults) {
    const shard = JSON.parse(await readFile(path, 'utf8')) as { samples: DriverSample[] }
    samples.push(...shard.samples)
  }
} else {
  const view = await NativeViewClient.connect(options.baseUrl)
  try {
    for (const provider of options.providers) {
      for (const mode of options.modes) {
        for (let run = 1; run <= options.runs; run += 1) {
          process.stdout.write(`${provider} ${mode} ${run}/${options.runs} ... `)
          const sample = await runSample(options, view, provider, mode, run)
          samples.push(sample)
          console.log(sample.outcome === 'ok' ? 'ok' : `failed (${sample.error})`)
        }
      }
    }
  } finally {
    view.close()
  }
}

const generatedAt = new Date().toISOString()
const report = {
  schemaVersion: 1,
  benchmark: 'podium-driver-comparison',
  generatedAt,
  prompt: PROMPT,
  config: options,
  host: { hostname: hostname(), platform: platform(), release: release(), loadAverage: loadavg() },
  samples,
}
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
await writeFile(options.markdown, renderMarkdown(generatedAt, options, samples, baseline))
console.log(`wrote ${options.output}`)
console.log(`wrote ${options.markdown}`)
