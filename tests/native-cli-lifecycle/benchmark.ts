#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { cpus, hostname, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Terminal } from '@xterm/headless'

type Provider = 'claude' | 'codex' | 'grok' | 'opencode'

interface Config {
  providers: Provider[]
  runs: number
  workdir?: string
  timeoutMs: number
  attachTimeoutMs: number
  attachQuietMs: number
  native: boolean
  machine: boolean
  attach: boolean
  output?: string
  markdown?: string
}

interface StartTiming {
  sessionReadyMs?: number
  milestones: Record<string, number>
  evidence: string
}

interface DriveTiming {
  promptAcceptedMs?: number
  firstResponseMs?: number
  completeMs?: number
  evidence: string
}

interface AttachTiming {
  firstByteMs?: number
  initialPaintLastByteMs?: number
  initialPaintSettledMs?: number
  firstProbeSentMs?: number
  firstProbeEchoMs?: number
  inputReadyMs?: number
  invokedAfterSessionReadyMs?: number
  sessionReadyToInputReadyMs?: number
  sequence?: 'before-machine-turn' | 'after-machine-turn'
  firstProbeAccepted: boolean
  inputProbeAttempts: number
  setupGateMs?: number
  setupActions: number
  outputBytes: number
  evidence: string
  error?: string
}

interface NativeTiming {
  firstProbeAccepted: boolean
  inputProbeAttempts: number
  firstPostResponseProbeAccepted: boolean
  postResponseProbeAttempts: number
  setupActions: number
  outputBytes: number
  evidence: string
  firstByteMs?: number
  firstProbeSentMs?: number
  initialPaintLastByteMs?: number
  initialPaintSettledMs?: number
  inputReadyMs?: number
  promptSubmittedMs?: number
  responseVisibleMs?: number
  nextInputReadyMs?: number
  setupGateMs?: number
  error?: string
}

interface NativeSample {
  run: number
  workdir: string
  startedAt: string
  timing: NativeTiming
}

interface Sample {
  run: number
  workdir: string
  sessionId?: string
  startedAt: string
  start: StartTiming
  drive: DriveTiming
  attach?: AttachTiming
  error?: string
}

interface ProviderResult {
  executable: string
  version: string
  nativeMechanism: string
  machineMechanism: string
  attachMechanism: string
  model?: string
  nativeSamples: NativeSample[]
  samples: Sample[]
}

interface Report {
  schemaVersion: 2
  benchmark: 'native-cli-lifecycle'
  generatedAt: string
  runOrder: Provider[]
  prompt: string
  config: Omit<Config, 'output' | 'markdown' | 'workdir'> & { workdir: string }
  host: {
    hostname: string
    platform: string
    release: string
    runtime: string
    cpu: string
    cpuCount: number
    memoryBytes: number
    loadAverage: number[]
  }
  providers: Partial<Record<Provider, ProviderResult>>
}

type JsonFrame = {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

type TimestampedFrame = { at: number; frame: JsonFrame }

const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'grok', 'opencode']
const PROMPT = 'Reply with exactly BENCH_OK and nothing else. Do not use tools.'
const scriptPath = fileURLToPath(import.meta.url)

const round = (value: number): number => Math.round(value * 10) / 10
const elapsed = (since: number): number => round(performance.now() - since)
const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

function status(message: string): void {
  process.stderr.write(`[native-cli-bench] ${message}\n`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeTail(value: string, max = 2_000): string {
  return value.trim().slice(-max)
}

function stripEnv(source: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const name of names) delete env[name]
  return env
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function executableFromPath(name: string): string | undefined {
  if (name.includes('/')) {
    const candidate = resolve(name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      return undefined
    }
  }
  for (const root of (process.env.PATH ?? '').split(delimiter)) {
    if (!root) continue
    const candidate = join(root, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

function resolveExecutable(provider: Provider): string {
  const variable = `NATIVE_CLI_BENCH_${provider.toUpperCase()}_BIN`
  const configured = process.env[variable]
  if (configured) {
    const found = executableFromPath(configured)
    if (found) return found
    throw new Error(`${variable} does not name an executable: ${configured}`)
  }
  const name = provider === 'claude' ? 'claude' : provider
  const found = executableFromPath(name)
  if (found) return found
  if (provider === 'opencode') {
    const fallback = join(process.env.HOME ?? '', '.opencode', 'bin', 'opencode')
    const fallbackFound = executableFromPath(fallback)
    if (fallbackFound) return fallbackFound
  }
  throw new Error(`${name} is not installed (set ${variable} to override)`)
}

async function capture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-16_384)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16_384)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30_000)
    child.once('error', rejectCapture)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolveCapture({ stdout, stderr, code })
    })
  })
}

async function versionOf(executable: string): Promise<string> {
  const result = await capture(executable, ['--version'])
  const version = `${result.stdout}\n${result.stderr}`.trim().split('\n')[0]?.trim()
  if (!version) throw new Error(`${basename(executable)} --version returned no version`)
  return version
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('could not allocate a loopback port'))
        return
      }
      const port = address.port
      server.close((error) => (error ? rejectPort(error) : resolvePort(port)))
    })
  })
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.stdin?.end()
  } catch {
    // Already closing.
  }
  const closed = new Promise<void>((resolveClosed) => child.once('close', () => resolveClosed()))
  if ((await Promise.race([closed.then(() => true), delay(1_000).then(() => false)])) === true)
    return
  child.kill('SIGTERM')
  if ((await Promise.race([closed.then(() => true), delay(1_000).then(() => false)])) === true)
    return
  child.kill('SIGKILL')
  await Promise.race([closed, delay(1_000)])
}

class RpcPeer {
  readonly frames: TimestampedFrame[] = []
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly waiters = new Set<() => void>()
  private nextId = 1

  constructor(
    private readonly writeFrame: (line: string) => void,
    private readonly timeoutMs: number,
    private readonly onServerRequest?: (frame: JsonFrame) => void,
  ) {}

  ingest(raw: string): void {
    let frame: JsonFrame
    try {
      frame = JSON.parse(raw.trim()) as JsonFrame
    } catch {
      return
    }
    const at = performance.now()
    this.frames.push({ at, frame })
    if (frame.id !== undefined && frame.method !== undefined) {
      this.onServerRequest?.(frame)
    } else if (frame.id !== undefined) {
      const id = Number(frame.id)
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        if (frame.error) {
          pending.reject(
            new Error(
              `${frame.error.code ?? 'RPC'} ${frame.error.message ?? 'request failed'}${frame.error.data === undefined ? '' : `: ${JSON.stringify(frame.error.data)}`}`,
            ),
          )
        } else {
          pending.resolve(frame.result)
        }
      }
    }
    for (const wake of [...this.waiters]) wake()
  }

  send(frame: JsonFrame): void {
    this.writeFrame(JSON.stringify({ jsonrpc: '2.0', ...frame }))
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const result = new Promise<unknown>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectCall(new Error(`${method} did not answer within ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
    })
    this.send({ id, method, ...(params === undefined ? {} : { params }) })
    return await result
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result })
  }

  async waitFor(
    predicate: (entry: TimestampedFrame) => boolean,
    since: number,
    timeoutMs = this.timeoutMs,
  ): Promise<TimestampedFrame> {
    const existing = this.frames.find((entry) => entry.at >= since && predicate(entry))
    if (existing) return existing
    return await new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        rejectWait(new Error(`native event did not arrive within ${timeoutMs}ms`))
      }, timeoutMs)
      const check = (): void => {
        const match = this.frames.find((entry) => entry.at >= since && predicate(entry))
        if (!match) return
        clearTimeout(timer)
        this.waiters.delete(check)
        resolveWait(match)
      }
      this.waiters.add(check)
    })
  }

  close(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    for (const wake of [...this.waiters]) wake()
  }
}

interface AttachInput {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  quietMs: number
  acceptOwnedWorkspaceTrust?: boolean
}

function lineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = ''
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let boundary = buffer.indexOf('\n')
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 1)
      if (line.trim()) onLine(line)
      boundary = buffer.indexOf('\n')
    }
  })
}

async function measureAttach(input: AttachInput): Promise<AttachTiming> {
  const result: AttachTiming = {
    firstProbeAccepted: false,
    inputProbeAttempts: 0,
    setupActions: 0,
    outputBytes: 0,
    evidence:
      'util-linux script PTY; first byte; initial paint followed by configured output quiescence; non-submitted marker visibly echoed by the native composer',
  }
  const started = performance.now()
  const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 1_000, allowProposedApi: true })
  const command = `stty rows 40 cols 120; exec ${[input.executable, ...input.args].map(shellQuote).join(' ')}`

  await new Promise<void>((resolveAttach) => {
    const child = spawn('script', ['-qefc', command, '/dev/null'], {
      cwd: input.cwd,
      env: { ...input.env, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let finished = false
    let lastScreen = ''
    const probes: { marker: string; sentAt: number }[] = []
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    let probeTimer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout>

    const finish = (error?: string): void => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      if (quietTimer) clearTimeout(quietTimer)
      if (stopTimer) clearTimeout(stopTimer)
      if (forceTimer) clearTimeout(forceTimer)
      if (probeTimer) clearTimeout(probeTimer)
      terminal.dispose()
      if (error) result.error = error
      resolveAttach()
    }

    const stop = (): void => {
      try {
        child.stdin?.write('\x03')
      } catch {
        // The client may already have exited.
      }
      stopTimer = setTimeout(() => child.stdin?.write('\x03'), 250)
      forceTimer = setTimeout(() => child.kill('SIGTERM'), 750)
    }

    const stopWhenMeasured = (): void => {
      if (result.inputReadyMs !== undefined && result.initialPaintSettledMs !== undefined) stop()
    }

    const screenText = (): string => {
      const buffer = terminal.buffer.active
      let text = ''
      for (let index = buffer.baseY; index < buffer.baseY + terminal.rows; index += 1) {
        text += (buffer.getLine(index)?.translateToString(true) ?? '') + '\n'
      }
      return text
    }

    const sendProbe = (): void => {
      if (finished || result.inputReadyMs !== undefined) return
      const marker = Array.from(randomBytes(24), (byte) => (byte & 1 ? '.' : '_')).join('')
      const sentAt = performance.now()
      probes.push({ marker, sentAt })
      result.inputProbeAttempts = probes.length
      if (probes.length === 1) result.firstProbeSentMs = round(sentAt - started)
      child.stdin?.write(marker)
      probeTimer = setTimeout(sendProbe, 1_000)
    }

    const observe = (chunk: Buffer): void => {
      const at = performance.now()
      result.outputBytes += chunk.byteLength
      terminal.write(chunk.toString('utf8'), () => {
        const screen = screenText()
        lastScreen = screen
        if (result.inputReadyMs !== undefined) return
        if (
          input.acceptOwnedWorkspaceTrust &&
          result.setupActions === 0 &&
          screen.includes('Yes, I trust this folder')
        ) {
          result.setupGateMs = elapsed(started)
          result.setupActions = 1
          child.stdin?.write('\r')
        }
        const acceptedIndex = probes.findIndex((probe) => screen.includes(probe.marker))
        if (acceptedIndex < 0) return
        const observedAt = performance.now()
        result.inputReadyMs = round(observedAt - started)
        result.firstProbeAccepted = acceptedIndex === 0
        if (acceptedIndex === 0) result.firstProbeEchoMs = result.inputReadyMs
        if (probeTimer) clearTimeout(probeTimer)
        stopWhenMeasured()
      })
      if (result.firstByteMs === undefined) {
        result.firstByteMs = round(at - started)
        sendProbe()
      }
      if (result.initialPaintSettledMs === undefined) {
        result.initialPaintLastByteMs = round(at - started)
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(() => {
          result.initialPaintSettledMs = elapsed(started)
          stopWhenMeasured()
        }, input.quietMs)
      }
    }

    child.stdout?.on('data', observe)
    child.stderr?.on('data', observe)
    child.once('error', (error) => finish(`could not start native client PTY: ${error.message}`))
    child.once('close', (code, signal) => {
      if (finished) return
      if (result.inputReadyMs !== undefined && result.initialPaintSettledMs !== undefined) {
        finish()
        return
      }
      finish(
        `native client exited before attach became stable (${signal ? `signal ${signal}` : `code ${code}`}): ${safeTail(lastScreen, 1_000)}`,
      )
    })
    deadline = setTimeout(() => {
      child.kill('SIGTERM')
      finish(
        result.firstByteMs === undefined
          ? `native client produced no terminal output within ${input.timeoutMs}ms`
          : `native client did not echo the input marker within ${input.timeoutMs}ms`,
      )
    }, input.timeoutMs)
  })
  return result
}

async function measureSessionAttach(
  input: AttachInput & {
    sessionReadyAt: number
    sequence: 'before-machine-turn' | 'after-machine-turn'
  },
): Promise<AttachTiming> {
  const { sessionReadyAt, sequence, ...attachInput } = input
  const invokedAt = performance.now()
  const timing = await measureAttach(attachInput)
  timing.invokedAfterSessionReadyMs = round(invokedAt - sessionReadyAt)
  timing.sequence = sequence
  if (timing.inputReadyMs !== undefined) {
    timing.sessionReadyToInputReadyMs = round(
      timing.invokedAfterSessionReadyMs + timing.inputReadyMs,
    )
  }
  return timing
}

function nativeSetupAction(provider: Provider, screen: string): string | undefined {
  if (provider === 'claude' && screen.includes('Yes, I trust this folder')) return '\r'
  if (
    provider === 'codex' &&
    /Do you trust the contents of this directory\?/i.test(screen) &&
    /Yes, (?:proceed|continue)/i.test(screen)
  ) {
    return '1\r'
  }
  if (
    provider === 'grok' &&
    screen.includes("Don't ask me again") &&
    screen.includes('Type your answer here')
  )
    return 'X'
  return undefined
}

async function measureNativeTurn(input: {
  provider: Provider
  executable: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  quietMs: number
}): Promise<NativeTiming> {
  const expectedSuffix = randomBytes(5).toString('hex').toUpperCase()
  const expected = `NATIVE_OK_${expectedSuffix}`
  const prompt = `Reply with exactly NATIVE, then _, then OK, then _, then ${expectedSuffix}; no spaces. Do not use tools.`
  const result: NativeTiming = {
    firstProbeAccepted: false,
    inputProbeAttempts: 0,
    firstPostResponseProbeAccepted: false,
    postResponseProbeAttempts: 0,
    setupActions: 0,
    outputBytes: 0,
    evidence: `fresh stock CLI${input.provider === 'grok' ? ' with explicit --cwd; its delayed fresh-directory chooser is dismissed without persisting the dont-ask-again option' : ''} in a util-linux script PTY; non-submitted startup marker visibly echoed; prompt pasted and submitted with a delayed Enter (raw text for Grok first turn); unique assistant token rendered; non-submitted post-response marker visibly echoed`,
  }
  const started = performance.now()
  const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 1_000, allowProposedApi: true })
  const nativeArgs = input.provider === 'grok' ? ['--cwd', input.cwd] : []
  const command = `stty rows 40 cols 120; exec ${[input.executable, ...nativeArgs]
    .map(shellQuote)
    .join(' ')}`
  const env = {
    ...input.env,
    ...(input.provider === 'codex' ? { CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '1' } : {}),
  }

  await new Promise<void>((resolveNative) => {
    const child = spawn('script', ['-qefc', command, '/dev/null'], {
      cwd: input.cwd,
      env: { ...env, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const startupProbes: { marker: string; sentAt: number }[] = []
    const postResponseProbes: { marker: string; sentAt: number }[] = []
    let finished = false
    let lastScreen = ''
    let promptAt: number | undefined
    let promptScheduled = false
    let setupHandled = false
    let startupProbeTimer: ReturnType<typeof setTimeout> | undefined
    let postResponseProbeTimer: ReturnType<typeof setTimeout> | undefined
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout>

    const finish = (error?: string): void => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      if (startupProbeTimer) clearTimeout(startupProbeTimer)
      if (postResponseProbeTimer) clearTimeout(postResponseProbeTimer)
      if (quietTimer) clearTimeout(quietTimer)
      if (stopTimer) clearTimeout(stopTimer)
      if (forceTimer) clearTimeout(forceTimer)
      terminal.dispose()
      if (error) result.error = error
      resolveNative()
    }

    const stop = (): void => {
      try {
        child.stdin?.write('\x03')
      } catch {
        // The native client may already be closing.
      }
      stopTimer = setTimeout(() => child.stdin?.write('\x03'), 250)
      forceTimer = setTimeout(() => child.kill('SIGTERM'), 750)
    }

    const screenText = (): string => {
      const buffer = terminal.buffer.active
      let text = ''
      for (let index = buffer.baseY; index < buffer.baseY + terminal.rows; index += 1) {
        text += (buffer.getLine(index)?.translateToString(true) ?? '') + '\n'
      }
      return text
    }

    const submitPrompt = (): void => {
      if (promptScheduled || finished) return
      promptScheduled = true
      child.stdin?.write(input.provider === 'grok' ? '\x01\x0b' : '\x15')
      setTimeout(() => {
        if (finished) return
        child.stdin?.write(input.provider === 'grok' ? prompt : `\x1b[200~${prompt}\x1b[201~`)
        setTimeout(() => {
          if (finished) return
          promptAt = performance.now()
          result.promptSubmittedMs = round(promptAt - started)
          if (result.initialPaintSettledMs === undefined) {
            result.initialPaintSettledMs = result.promptSubmittedMs
          }
          child.stdin?.write('\r')
        }, 90)
      }, 75)
    }
    const submitWhenReady = (): void => {
      const floorRemaining = input.provider === 'grok' ? 1_250 - (performance.now() - started) : 0
      if (floorRemaining > 0) {
        setTimeout(submitWhenReady, floorRemaining)
        return
      }
      if (result.inputReadyMs !== undefined && result.initialPaintSettledMs !== undefined) {
        submitPrompt()
      }
    }

    const sendStartupProbe = (): void => {
      if (finished || result.inputReadyMs !== undefined) return
      const marker = Array.from(randomBytes(24), (byte) => (byte & 1 ? '.' : '_')).join('')
      const sentAt = performance.now()
      startupProbes.push({ marker, sentAt })
      result.inputProbeAttempts = startupProbes.length
      if (startupProbes.length === 1) result.firstProbeSentMs = round(sentAt - started)
      child.stdin?.write(marker)
      startupProbeTimer = setTimeout(sendStartupProbe, 1_000)
    }

    const sendPostResponseProbe = (): void => {
      if (finished || result.nextInputReadyMs !== undefined || promptAt === undefined) return
      const marker = Array.from(randomBytes(24), (byte) => (byte & 1 ? '.' : '_')).join('')
      const sentAt = performance.now()
      postResponseProbes.push({ marker, sentAt })
      result.postResponseProbeAttempts = postResponseProbes.length
      child.stdin?.write(marker)
      postResponseProbeTimer = setTimeout(sendPostResponseProbe, 1_000)
    }

    const inspectScreen = (): void => {
      if (finished) return
      const screen = screenText()
      lastScreen = screen
      if (!setupHandled) {
        const action = nativeSetupAction(input.provider, screen)
        if (action !== undefined) {
          setupHandled = true
          result.setupGateMs = elapsed(started)
          result.setupActions += 1
          if (action.length > 1 && action.endsWith('\r')) {
            child.stdin?.write(action.slice(0, -1))
            setTimeout(() => {
              if (!finished) child.stdin?.write(action.slice(-1))
            }, 50)
          } else {
            child.stdin?.write(action)
          }
          return
        }
      }
      if (result.inputReadyMs === undefined) {
        const acceptedIndex = startupProbes.findIndex((probe) => screen.includes(probe.marker))
        if (acceptedIndex >= 0 && (input.provider !== 'grok' || /Enter\s*:send/i.test(screen))) {
          result.inputReadyMs = elapsed(started)
          result.firstProbeAccepted = acceptedIndex === 0
          if (startupProbeTimer) clearTimeout(startupProbeTimer)
          submitWhenReady()
        }
      }
      if (
        promptAt !== undefined &&
        result.responseVisibleMs === undefined &&
        screen.includes(expected)
      ) {
        result.responseVisibleMs = round(performance.now() - promptAt)
        setTimeout(sendPostResponseProbe, 75)
      }
      if (promptAt !== undefined && result.responseVisibleMs !== undefined) {
        const acceptedIndex = postResponseProbes.findIndex((probe) => screen.includes(probe.marker))
        if (acceptedIndex >= 0 && (input.provider !== 'grok' || /Enter\s*:send/i.test(screen))) {
          result.nextInputReadyMs = round(performance.now() - promptAt)
          result.firstPostResponseProbeAccepted = acceptedIndex === 0
          if (postResponseProbeTimer) clearTimeout(postResponseProbeTimer)
          stop()
        }
      }
    }

    const observe = (chunk: Buffer): void => {
      const at = performance.now()
      result.outputBytes += chunk.byteLength
      terminal.write(chunk.toString('utf8'), inspectScreen)
      if (result.firstByteMs === undefined) {
        result.firstByteMs = round(at - started)
        sendStartupProbe()
      }
      if (promptAt === undefined && result.initialPaintSettledMs === undefined) {
        result.initialPaintLastByteMs = round(at - started)
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(() => {
          result.initialPaintSettledMs = elapsed(started)
          submitWhenReady()
        }, input.quietMs)
      }
    }

    child.stdout?.on('data', observe)
    child.stderr?.on('data', observe)
    child.once('error', (error) => finish(`could not start native CLI PTY: ${error.message}`))
    child.once('close', (code, signal) => {
      if (finished) return
      if (result.nextInputReadyMs !== undefined) {
        finish()
        return
      }
      finish(
        `native CLI exited before a complete human-style turn (${signal ? `signal ${signal}` : `code ${code}`}): ${safeTail(lastScreen, 1_000)}`,
      )
    })
    deadline = setTimeout(() => {
      child.kill('SIGTERM')
      const phase =
        result.inputReadyMs === undefined
          ? 'startup input readiness'
          : result.responseVisibleMs === undefined
            ? `the expected ${expected} response`
            : 'post-response input readiness'
      finish(`native CLI timed out waiting for ${phase}: ${safeTail(lastScreen, 1_000)}`)
    }, input.timeoutMs)
  })
  return result
}

interface ClaudeWorkerSpec {
  cwd: string
  executable: string
  prompt: string
  sessionId: string
  model?: string
}

async function claudeWorker(): Promise<void> {
  let input = ''
  for await (const chunk of process.stdin) input += String(chunk)
  const spec = JSON.parse(input) as ClaudeWorkerSpec
  const send = (frame: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(frame)}\n`)
  }
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const env = stripEnv(process.env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) as Record<
      string,
      string
    >
    const conversation = query({
      prompt: spec.prompt,
      options: {
        cwd: spec.cwd,
        sessionId: spec.sessionId,
        includePartialMessages: true,
        permissionMode: 'default',
        tools: [],
        allowedTools: [],
        settingSources: [],
        pathToClaudeCodeExecutable: spec.executable,
        env,
        ...(spec.model ? { model: spec.model } : {}),
      },
    })
    let firstResponse = false
    for await (const message of conversation) {
      if (message.type === 'system' && message.subtype === 'init') {
        send({ t: 'session-ready', sessionId: message.session_id })
      } else if (message.type === 'stream_event') {
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } }
        if (!firstResponse && event.type === 'content_block_delta' && event.delta?.text) {
          firstResponse = true
          send({ t: 'first-response' })
        }
      } else if (message.type === 'assistant' && !firstResponse) {
        firstResponse = true
        send({ t: 'first-response' })
      } else if (message.type === 'result') {
        if (message.subtype !== 'success') {
          throw new Error(message.errors.join('; ') || `Claude result: ${message.subtype}`)
        }
        if (!message.result.includes('BENCH_OK')) {
          throw new Error(
            `Claude completed without the expected BENCH_OK response: ${safeTail(message.result, 500)}`,
          )
        }
        send({ t: 'complete', sessionId: message.session_id })
      }
    }
  } catch (error) {
    send({ t: 'error', message: errorText(error) })
    process.exitCode = 1
  }
}

async function benchClaude(config: Config, executable: string, sample: Sample): Promise<void> {
  const sessionId = randomUUID()
  sample.sessionId = sessionId
  const model = process.env.NATIVE_CLI_BENCH_CLAUDE_MODEL
  const started = performance.now()
  const child = spawn(process.execPath, [scriptPath, '--claude-worker'], {
    cwd: sample.workdir,
    env: stripEnv(process.env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  let settled = false
  let firstResponseAt: number | undefined
  let sessionReadyAt: number | undefined

  try {
    const completed = new Promise<void>((resolveComplete, rejectComplete) => {
      const timeout = setTimeout(() => {
        rejectComplete(new Error(`Claude SDK turn did not complete within ${config.timeoutMs}ms`))
        child.kill('SIGKILL')
      }, config.timeoutMs)
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8_192)
      })
      lineReader(child.stdout as NodeJS.ReadableStream, (line) => {
        const frame = JSON.parse(line) as { t?: string; sessionId?: string; message?: string }
        if (frame.t === 'session-ready' && sessionReadyAt === undefined) {
          sessionReadyAt = performance.now()
          sample.sessionId = frame.sessionId ?? sessionId
          status(`claude run ${sample.run}: SDK session ready in ${elapsed(started)}ms`)
        } else if (frame.t === 'first-response' && firstResponseAt === undefined) {
          firstResponseAt = performance.now()
        } else if (frame.t === 'complete') {
          clearTimeout(timeout)
          settled = true
          resolveComplete()
        } else if (frame.t === 'error') {
          clearTimeout(timeout)
          settled = true
          rejectComplete(new Error(frame.message ?? 'Claude SDK worker failed'))
        }
      })
      child.once('error', rejectComplete)
      child.once('close', (code, signal) => {
        if (settled) return
        clearTimeout(timeout)
        rejectComplete(
          new Error(
            `Claude SDK worker exited before completion (${signal ? `signal ${signal}` : `code ${code}`})${stderr.trim() ? `: ${safeTail(stderr)}` : ''}`,
          ),
        )
      })
    })
    const spec: ClaudeWorkerSpec = {
      cwd: sample.workdir,
      executable,
      prompt: PROMPT,
      sessionId,
      ...(model ? { model } : {}),
    }
    child.stdin?.end(JSON.stringify(spec))
    let completionError: Error | undefined
    try {
      await completed
    } catch (error) {
      completionError = error instanceof Error ? error : new Error(String(error))
    }
    const completeAt = performance.now()
    sample.start = {
      sessionReadyMs: sessionReadyAt ? round(sessionReadyAt - started) : undefined,
      milestones: {
        ...(sessionReadyAt ? { sdkSessionReadyMs: round(sessionReadyAt - started) } : {}),
      },
      evidence: 'fresh Bun worker + Agent SDK query; SDK system/init with native session id',
    }
    sample.drive = completionError
      ? { evidence: 'provider turn failed before a verified BENCH_OK response' }
      : {
          promptAcceptedMs: sessionReadyAt ? round(sessionReadyAt - started) : undefined,
          firstResponseMs: firstResponseAt ? round(firstResponseAt - started) : undefined,
          completeMs: round(completeAt - started),
          evidence:
            'system/init; first assistant stream event; SDK success result (all relative to worker spawn)',
        }
    if (config.attach && sessionReadyAt) {
      sample.attach = await measureSessionAttach({
        sessionReadyAt,
        sequence: 'after-machine-turn',
        executable,
        args: ['--resume', sample.sessionId ?? sessionId],
        cwd: sample.workdir,
        env: stripEnv(process.env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
        timeoutMs: config.attachTimeoutMs,
        quietMs: config.attachQuietMs,
        acceptOwnedWorkspaceTrust: config.workdir === undefined,
      })
    }
    if (completionError) throw completionError
  } finally {
    await stopChild(child)
  }
}

async function connectCodexSocket(socketPath: string, child: ChildProcess, timeoutMs: number) {
  const { default: WebSocket } = await import('ws')
  const deadline = performance.now() + Math.min(timeoutMs, 30_000)
  let lastError = 'listener not ready'
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('codex app-server exited before its Unix listener opened')
    }
    try {
      return await new Promise<InstanceType<typeof WebSocket>>((resolveSocket, rejectSocket) => {
        const socket = new WebSocket(`ws+unix://${socketPath}:/rpc`, {
          maxPayload: 128 << 20,
          perMessageDeflate: false,
        })
        socket.on('error', () => undefined)
        const timer = setTimeout(() => {
          socket.terminate()
          rejectSocket(new Error('WebSocket upgrade timed out'))
        }, 5_000)
        socket.once('open', () => {
          clearTimeout(timer)
          resolveSocket(socket)
        })
        socket.once('error', (error) => {
          clearTimeout(timer)
          socket.terminate()
          rejectSocket(error)
        })
      })
    } catch (error) {
      lastError = errorText(error)
      await delay(25)
    }
  }
  throw new Error(`codex Unix WebSocket did not open: ${lastError}`)
}

async function benchCodex(
  config: Config,
  executable: string,
  sample: Sample,
  runtimeDir: string,
): Promise<void> {
  const started = performance.now()
  const socketPath = join(runtimeDir, `cx-${sample.run}-${randomBytes(4).toString('hex')}.sock`)
  const env = stripEnv(process.env, [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'OPENAI_ORGANIZATION',
    'OPENAI_ORG_ID',
    'OPENAI_BASE_URL',
  ])
  const child = spawn(
    executable,
    ['app-server', '-c', 'sandbox_mode="workspace-write"', '--listen', `unix://${socketPath}`],
    { cwd: sample.workdir, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-8_192)
  })
  let socket: Awaited<ReturnType<typeof connectCodexSocket>> | undefined
  try {
    socket = await connectCodexSocket(socketPath, child, config.timeoutMs)
    const transportReadyAt = performance.now()
    let rpc!: RpcPeer
    rpc = new RpcPeer(
      (line) => socket?.send(`${line}\n`),
      config.timeoutMs,
      (frame) => {
        if (frame.id === undefined) return
        if (frame.method?.includes('requestApproval')) {
          rpc.respond(frame.id, { decision: 'decline' })
        } else {
          rpc.respond(frame.id, {})
        }
      },
    )
    socket.on('message', (data) => rpc.ingest(data.toString()))
    socket.once('close', () => rpc.close(new Error('codex WebSocket closed')))
    await rpc.call('initialize', {
      clientInfo: {
        name: 'native-cli-lifecycle-bench',
        title: 'Native CLI benchmark',
        version: '1',
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    rpc.send({ method: 'initialized' })
    const protocolReadyAt = performance.now()
    const model = process.env.NATIVE_CLI_BENCH_CODEX_MODEL
    const startedThread = (await rpc.call('thread/start', {
      cwd: sample.workdir,
      ...(model ? { model } : {}),
    })) as { thread?: { id?: string } }
    const threadId = startedThread.thread?.id
    if (!threadId) throw new Error('codex thread/start returned no thread id')
    sample.sessionId = threadId
    const sessionReadyAt = performance.now()
    sample.start = {
      sessionReadyMs: round(sessionReadyAt - started),
      milestones: {
        unixWebSocketReadyMs: round(transportReadyAt - started),
        initializeReadyMs: round(protocolReadyAt - started),
        threadReadyMs: round(sessionReadyAt - started),
      },
      evidence: 'Unix WebSocket open; initialize response + initialized; thread/start response',
    }
    status(`codex run ${sample.run}: thread ready in ${sample.start.sessionReadyMs}ms`)

    const promptAt = performance.now()
    const turnResponse = (await rpc.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: PROMPT, text_elements: [] }],
      ...(model ? { model } : {}),
    })) as { turn?: { id?: string } }
    const acceptedAt = performance.now()
    const turnId = turnResponse.turn?.id
    const firstResponse = await rpc.waitFor(
      ({ frame }) =>
        frame.method === 'item/agentMessage/delta' &&
        (frame.params as { threadId?: string; turnId?: string; delta?: string } | undefined)
          ?.threadId === threadId &&
        (!turnId || (frame.params as { turnId?: string } | undefined)?.turnId === turnId) &&
        Boolean((frame.params as { delta?: string } | undefined)?.delta),
      promptAt,
    )
    const completed = await rpc.waitFor(
      ({ frame }) =>
        frame.method === 'turn/completed' &&
        (frame.params as { threadId?: string; turn?: { id?: string } } | undefined)?.threadId ===
          threadId &&
        (!turnId || (frame.params as { turn?: { id?: string } } | undefined)?.turn?.id === turnId),
      promptAt,
    )
    sample.drive = {
      promptAcceptedMs: round(acceptedAt - promptAt),
      firstResponseMs: round(firstResponse.at - promptAt),
      completeMs: round(completed.at - promptAt),
      evidence: 'turn/start response; first item/agentMessage/delta; turn/completed notification',
    }
    if (!JSON.stringify(completed.frame.params).includes('BENCH_OK')) {
      throw new Error('Codex completed without the expected BENCH_OK response')
    }
    if (config.attach) {
      sample.attach = await measureSessionAttach({
        sessionReadyAt,
        sequence: 'after-machine-turn',
        executable,
        args: ['resume', '-C', sample.workdir, threadId, '--remote', `unix://${socketPath}`],
        cwd: sample.workdir,
        env,
        timeoutMs: config.attachTimeoutMs,
        quietMs: config.attachQuietMs,
      })
    }
  } catch (error) {
    const detail = safeTail(stderr)
    throw new Error(`${errorText(error)}${detail ? `: ${detail}` : ''}`)
  } finally {
    socket?.close()
    await stopChild(child)
    await rm(socketPath, { force: true })
  }
}

async function benchGrok(config: Config, executable: string, sample: Sample): Promise<void> {
  const started = performance.now()
  const env = stripEnv(process.env, ['XAI_API_KEY'])
  const child = spawn(executable, ['agent', 'stdio'], {
    cwd: sample.workdir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-8_192)
  })
  let rpc!: RpcPeer
  rpc = new RpcPeer(
    (line) => child.stdin?.write(`${line}\n`),
    config.timeoutMs,
    (frame) => {
      if (frame.id === undefined) return
      const options = (
        frame.params as { options?: { optionId?: string; kind?: string }[] } | undefined
      )?.options
      const rejected = options?.find((option) => option.kind?.startsWith('reject'))?.optionId
      rpc.respond(
        frame.id,
        rejected ? { outcome: { outcome: 'selected', optionId: rejected } } : {},
      )
    },
  )
  lineReader(child.stdout as NodeJS.ReadableStream, (line) => rpc.ingest(line))
  child.once('close', () => rpc.close(new Error('grok ACP process closed')))
  try {
    await rpc.call('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'native-cli-lifecycle-bench', version: '1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    const protocolReadyAt = performance.now()
    const created = (await rpc.call('session/new', {
      cwd: sample.workdir,
      mcpServers: [],
    })) as { sessionId?: string }
    if (!created.sessionId) throw new Error('grok session/new returned no session id')
    const sessionId = created.sessionId
    sample.sessionId = sessionId
    await rpc.call('session/set_mode', { sessionId, modeId: 'default' }).catch(() => undefined)
    const sessionReadyAt = performance.now()
    sample.start = {
      sessionReadyMs: round(sessionReadyAt - started),
      milestones: {
        initializeReadyMs: round(protocolReadyAt - started),
        sessionReadyMs: round(sessionReadyAt - started),
      },
      evidence: 'ACP initialize response; session/new response; optional session/set_mode response',
    }
    status(`grok run ${sample.run}: session ready in ${sample.start.sessionReadyMs}ms`)
    if (config.attach) {
      sample.attach = await measureSessionAttach({
        sessionReadyAt,
        sequence: 'before-machine-turn',
        executable,
        args: ['--resume', sessionId],
        cwd: sample.workdir,
        env,
        timeoutMs: config.attachTimeoutMs,
        quietMs: config.attachQuietMs,
      })
    }

    const promptAt = performance.now()
    const completedPromise = rpc.call('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: PROMPT }],
    })
    const accepted = await rpc.waitFor(
      ({ frame }) =>
        frame.method === 'session/update' &&
        (frame.params as { sessionId?: string; update?: { sessionUpdate?: string } } | undefined)
          ?.sessionId === sessionId &&
        (frame.params as { update?: { sessionUpdate?: string } } | undefined)?.update
          ?.sessionUpdate === 'user_message_chunk',
      promptAt,
    )
    const firstResponsePromise = rpc.waitFor(({ frame }) => {
      if (frame.method !== 'session/update' && frame.method !== '_x.ai/session/update') return false
      const params = frame.params as
        | { sessionId?: string; update?: { sessionUpdate?: string } }
        | undefined
      return (
        params?.sessionId === sessionId && params.update?.sessionUpdate !== 'user_message_chunk'
      )
    }, promptAt)
    const [firstResponse] = await Promise.all([firstResponsePromise, completedPromise])
    const completeAt = performance.now()
    sample.drive = {
      promptAcceptedMs: round(accepted.at - promptAt),
      firstResponseMs: round(firstResponse.at - promptAt),
      completeMs: round(completeAt - promptAt),
      evidence: 'user_message_chunk update; first non-user session update; session/prompt response',
    }
    const grokTurnFrames = rpc.frames.filter((entry) => entry.at >= promptAt)
    if (!JSON.stringify(grokTurnFrames).includes('BENCH_OK')) {
      throw new Error('Grok completed without the expected BENCH_OK response')
    }
  } catch (error) {
    const detail = safeTail(stderr)
    throw new Error(`${errorText(error)}${detail ? `: ${detail}` : ''}`)
  } finally {
    await stopChild(child)
  }
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

async function openCodeRequest(input: {
  baseUrl: string
  username: string
  password: string
  directory?: string
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  signal?: AbortSignal
}): Promise<Response> {
  const url = input.directory
    ? input.baseUrl +
      input.path +
      (input.path.includes('?') ? '&' : '?') +
      'directory=' +
      encodeURIComponent(input.directory)
    : input.baseUrl + input.path
  const response = await fetch(url, {
    method: input.method,
    headers: {
      authorization: basicAuth(input.username, input.password),
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal: input.signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(
      `OpenCode ${input.method} ${input.path} returned ${response.status}: ${safeTail(await response.text(), 500)}`,
    )
  }
  return response
}

async function pumpSse(
  response: Response,
  onEvent: (event: { type?: string; properties?: Record<string, unknown> }) => void,
): Promise<void> {
  if (!response.body) throw new Error('OpenCode event response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          onEvent(
            JSON.parse(line.slice(5).trim()) as {
              type?: string
              properties?: Record<string, unknown>
            },
          )
        } catch {
          // Heartbeats and unknown log lines are irrelevant to timing evidence.
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

async function benchOpencode(config: Config, executable: string, sample: Sample): Promise<void> {
  const started = performance.now()
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const username = 'podium'
  const password = randomBytes(32).toString('hex')
  const env = stripEnv(process.env, [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GROQ_API_KEY',
    'XAI_API_KEY',
    'MISTRAL_API_KEY',
    'DEEPSEEK_API_KEY',
  ])
  env.OPENCODE_SERVER_USERNAME = username
  env.OPENCODE_SERVER_PASSWORD = password
  const child = spawn(executable, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: sample.workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-8_192)
  })
  child.stdout?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-8_192)
  })
  const abortEvents = new AbortController()
  try {
    const readyDeadline = performance.now() + Math.min(config.timeoutMs, 30_000)
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`opencode serve exited before health was ready: ${safeTail(stderr)}`)
      }
      try {
        await openCodeRequest({
          baseUrl,
          username,
          password,
          method: 'GET',
          path: '/global/health',
          signal: AbortSignal.timeout(250),
        })
        break
      } catch {
        if (performance.now() >= readyDeadline) {
          throw new Error(`opencode health did not answer within 30000ms: ${safeTail(stderr)}`)
        }
        await delay(25)
      }
    }
    const healthReadyAt = performance.now()
    const model = process.env.NATIVE_CLI_BENCH_OPENCODE_MODEL
    const modelParts = model?.split('/', 2)
    const createdResponse = await openCodeRequest({
      baseUrl,
      username,
      password,
      directory: sample.workdir,
      method: 'POST',
      path: '/session',
      body:
        modelParts?.length === 2 ? { model: { providerID: modelParts[0], id: modelParts[1] } } : {},
    })
    const created = (await createdResponse.json()) as { id?: string }
    if (!created.id) throw new Error('OpenCode POST /session returned no session id')
    const sessionId = created.id
    sample.sessionId = sessionId
    const sessionReadyAt = performance.now()

    const events: { at: number; type?: string; properties?: Record<string, unknown> }[] = []
    const eventWaiters = new Set<() => void>()
    const eventStreamRequestedAt = performance.now()
    const eventResponsePromise = openCodeRequest({
      baseUrl,
      username,
      password,
      directory: sample.workdir,
      method: 'GET',
      path: '/event',
      signal: abortEvents.signal,
    })

    const waitEvent = async (
      predicate: (event: (typeof events)[number]) => boolean,
      since: number,
    ): Promise<(typeof events)[number]> => {
      const existing = events.find((event) => event.at >= since && predicate(event))
      if (existing) return existing
      return await new Promise((resolveEvent, rejectEvent) => {
        const timer = setTimeout(() => {
          eventWaiters.delete(check)
          rejectEvent(new Error(`OpenCode event did not arrive within ${config.timeoutMs}ms`))
        }, config.timeoutMs)
        const check = (): void => {
          const match = events.find((event) => event.at >= since && predicate(event))
          if (!match) return
          clearTimeout(timer)
          eventWaiters.delete(check)
          resolveEvent(match)
        }
        eventWaiters.add(check)
      })
    }

    sample.start = {
      sessionReadyMs: round(sessionReadyAt - started),
      milestones: {
        healthReadyMs: round(healthReadyAt - started),
        sessionReadyMs: round(sessionReadyAt - started),
        eventStreamRequestedMs: round(eventStreamRequestedAt - started),
      },
      evidence: 'authenticated GET /global/health; POST /session; SSE request opened before prompt',
    }
    status(`opencode run ${sample.run}: session ready in ${sample.start.sessionReadyMs}ms`)
    if (config.attach) {
      sample.attach = await measureSessionAttach({
        sessionReadyAt,
        sequence: 'before-machine-turn',
        executable,
        args: ['attach', baseUrl, '--session', sessionId],
        cwd: sample.workdir,
        env,
        timeoutMs: config.attachTimeoutMs,
        quietMs: config.attachQuietMs,
      })
    }

    const messageRoles = new Map<string, string>()
    const promptAt = performance.now()
    const promptResponse = await openCodeRequest({
      baseUrl,
      username,
      password,
      directory: sample.workdir,
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      body: { parts: [{ type: 'text', text: PROMPT }] },
    })
    if (promptResponse.status !== 204) {
      throw new Error(`OpenCode async prompt returned ${promptResponse.status}, expected 204`)
    }
    const acceptedAt = performance.now()
    const eventResponse = await Promise.race([
      eventResponsePromise,
      delay(Math.min(config.timeoutMs, 30_000)).then(() => {
        throw new Error('OpenCode SSE response headers did not arrive after the prompt')
      }),
    ])
    const eventStreamReadyAt = performance.now()
    sample.start.milestones.eventStreamReadyMs = round(eventStreamReadyAt - started)
    void pumpSse(eventResponse, (event) => {
      events.push({ at: performance.now(), ...event })
      for (const wake of [...eventWaiters]) wake()
    }).catch((error) => {
      if (!abortEvents.signal.aborted) status('opencode event stream ended: ' + errorText(error))
    })
    const firstResponsePromise = waitEvent((event) => {
      const properties = event.properties
      if (properties?.sessionID !== sessionId) return false
      if (event.type === 'message.updated') {
        const info = properties.info as { id?: string; role?: string } | undefined
        if (info?.id && info.role) messageRoles.set(info.id, info.role)
        return false
      }
      if (event.type === 'message.part.delta') {
        const messageId = properties.messageID
        return typeof messageId === 'string' && messageRoles.get(messageId) === 'assistant'
      }
      if (event.type === 'message.part.updated') {
        const part = properties.part as { messageID?: string } | undefined
        return Boolean(part?.messageID && messageRoles.get(part.messageID) === 'assistant')
      }
      return false
    }, promptAt)
    const completePromise = waitEvent(
      (event) => event.type === 'session.idle' && event.properties?.sessionID === sessionId,
      promptAt,
    )
    const [firstResponse, completed] = await Promise.all([firstResponsePromise, completePromise])
    sample.drive = {
      promptAcceptedMs: round(acceptedAt - promptAt),
      firstResponseMs: round(firstResponse.at - promptAt),
      completeMs: round(completed.at - promptAt),
      evidence:
        '204 from prompt_async; first assistant message/part SSE event; session.idle SSE event',
    }
    const messages = await openCodeRequest({
      baseUrl,
      username,
      password,
      directory: sample.workdir,
      method: 'GET',
      path: '/session/' + encodeURIComponent(sessionId) + '/message',
    })
    if (!JSON.stringify(await messages.json()).includes('BENCH_OK')) {
      throw new Error('OpenCode completed without the expected BENCH_OK response')
    }
  } catch (error) {
    const detail = safeTail(stderr)
    throw new Error(`${errorText(error)}${detail ? `: ${detail}` : ''}`)
  } finally {
    abortEvents.abort()
    await stopChild(child)
  }
}

function defaultSample(run: number, workdir: string): Sample {
  return {
    run,
    workdir,
    startedAt: new Date().toISOString(),
    start: { milestones: {}, evidence: 'not reached' },
    drive: { evidence: 'not reached' },
  }
}

function parseArgs(args: string[]): Config {
  const config: Config = {
    providers: [...PROVIDERS],
    runs: 1,
    timeoutMs: 300_000,
    attachTimeoutMs: 30_000,
    attachQuietMs: 500,
    native: true,
    machine: true,
    attach: true,
  }
  const take = (index: number, name: string): string => {
    const value = args[index + 1]
    if (!value) throw new Error(`${name} requires a value`)
    return value
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--claude-worker') continue
    if (arg === '--providers') {
      const values = take(index, arg).split(',')
      if (values.some((value) => !PROVIDERS.includes(value as Provider))) {
        throw new Error(`--providers must contain only: ${PROVIDERS.join(',')}`)
      }
      config.providers = values as Provider[]
      index += 1
    } else if (arg === '--runs') {
      config.runs = Number.parseInt(take(index, arg), 10)
      index += 1
    } else if (arg === '--workdir') {
      config.workdir = resolve(take(index, arg))
      index += 1
    } else if (arg === '--timeout-ms') {
      config.timeoutMs = Number.parseInt(take(index, arg), 10)
      index += 1
    } else if (arg === '--attach-timeout-ms') {
      config.attachTimeoutMs = Number.parseInt(take(index, arg), 10)
      index += 1
    } else if (arg === '--attach-quiet-ms') {
      config.attachQuietMs = Number.parseInt(take(index, arg), 10)
      index += 1
    } else if (arg === '--output') {
      config.output = resolve(take(index, arg))
      index += 1
    } else if (arg === '--markdown') {
      config.markdown = resolve(take(index, arg))
      index += 1
    } else if (arg === '--no-attach') {
      config.attach = false
    } else if (arg === '--no-native') {
      config.native = false
    } else if (arg === '--no-machine') {
      config.machine = false
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: bun benchmark.ts [--providers claude,codex,grok,opencode] [--runs N] [--workdir DIR] [--output FILE] [--markdown FILE] [--timeout-ms N] [--attach-timeout-ms N] [--attach-quiet-ms N] [--no-native] [--no-machine] [--no-attach]\n',
      )
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!Number.isInteger(config.runs) || config.runs < 1) throw new Error('--runs must be >= 1')
  for (const [name, value] of [
    ['--timeout-ms', config.timeoutMs],
    ['--attach-timeout-ms', config.attachTimeoutMs],
    ['--attach-quiet-ms', config.attachQuietMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be >= 1`)
  }
  if (config.workdir && !existsSync(config.workdir)) {
    throw new Error(`--workdir does not exist: ${config.workdir}`)
  }
  return config
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const value =
    sorted.length % 2 === 1
      ? sorted[middle]
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  return round(value ?? 0)
}

function metric<T>(samples: T[], read: (sample: T) => number | undefined): string {
  const values = samples.map(read).filter((value): value is number => value !== undefined)
  const value = median(values)
  return value === undefined ? '—' : `${value.toFixed(1)} ms`
}

function renderMarkdown(report: Report): string {
  const lines = [
    '# Native, machine, and attach lifecycle baseline',
    '',
    `Measured ${report.generatedAt} on ${report.host.hostname} (${report.host.platform} ${report.host.release}, ${report.host.cpuCount} × ${report.host.cpu}, ${Math.round(report.host.memoryBytes / 2 ** 30)} GiB).`,
    `Run order: ${report.runOrder.join(' → ')}. Prompt: \`${report.prompt}\``,
    '',
    'Every table is a separate lane and every value is a median. Native timings come from a stock TUI creating and driving its own new session. Machine timings come from the vendor SDK/app-server/ACP/HTTP interface with no Podium process. Attach timings come from a stock TUI joining the session created by the machine lane.',
    '',
    '## 1. Native CLI used by a human',
    '',
    '| Provider | Samples | First byte | Paint settled | Initial input ready | Response visible | Next input ready | First startup keystroke |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const provider of report.runOrder) {
    const result = report.providers[provider]
    if (!result) continue
    const good = result.nativeSamples.filter((sample) => !sample.timing.error)
    const firstAccepted = good.filter((sample) => sample.timing.firstProbeAccepted).length
    lines.push(
      `| ${provider} | ${good.length}/${result.nativeSamples.length} | ${metric(good, (sample) => sample.timing.firstByteMs)} | ${metric(good, (sample) => sample.timing.initialPaintSettledMs)} | ${metric(good, (sample) => sample.timing.inputReadyMs)} | ${metric(good, (sample) => sample.timing.responseVisibleMs)} | ${metric(good, (sample) => sample.timing.nextInputReadyMs)} | ${firstAccepted}/${good.length} echoed |`,
    )
  }
  lines.push(
    '',
    'Native `Response visible` and `Next input ready` are relative to pressing Enter. Startup columns are relative to spawning the stock CLI.',
    '',
    '## 2. Machine interface',
    '',
    '| Provider | Samples | Session ready | Prompt accepted | First response | Turn complete | Cold → first response | Cold → complete |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const provider of report.runOrder) {
    const result = report.providers[provider]
    if (!result) continue
    const good = result.samples.filter((sample) => !sample.error)
    lines.push(
      `| ${provider} | ${good.length}/${result.samples.length} | ${metric(result.samples, (sample) => sample.start.sessionReadyMs)} | ${metric(good, (sample) => sample.drive.promptAcceptedMs)} | ${metric(good, (sample) => sample.drive.firstResponseMs)} | ${metric(good, (sample) => sample.drive.completeMs)} | ${metric(good, (sample) => (sample.start.sessionReadyMs !== undefined && sample.drive.firstResponseMs !== undefined ? (provider === 'claude' ? sample.drive.firstResponseMs : sample.start.sessionReadyMs + sample.drive.firstResponseMs) : undefined))} | ${metric(good, (sample) => (sample.start.sessionReadyMs !== undefined && sample.drive.completeMs !== undefined ? (provider === 'claude' ? sample.drive.completeMs : sample.start.sessionReadyMs + sample.drive.completeMs) : undefined))} |`,
    )
  }
  lines.push(
    '',
    '`Cold →` values add session startup and drive intervals, except Claude where SDK query starts the session and prompt together so its drive clock is already cold-to-response. They omit small orchestration gaps.',
    '',
    '## 3. Headless session → native attach',
    '',
    '| Provider | Samples | Sequence | Session ready → input ready | Attach invoked after ready | Attach first byte | Paint settled | Attach input ready | First attach keystroke |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  )
  for (const provider of report.runOrder) {
    const result = report.providers[provider]
    if (!result) continue
    const good = result.samples.filter((sample) => sample.attach && !sample.attach.error)
    const firstAccepted = good.filter((sample) => sample.attach?.firstProbeAccepted).length
    lines.push(
      `| ${provider} | ${good.length}/${result.samples.length} | ${good[0]?.attach?.sequence ?? '—'} | ${metric(good, (sample) => sample.attach?.sessionReadyToInputReadyMs)} | ${metric(good, (sample) => sample.attach?.invokedAfterSessionReadyMs)} | ${metric(good, (sample) => sample.attach?.firstByteMs)} | ${metric(good, (sample) => sample.attach?.initialPaintSettledMs)} | ${metric(good, (sample) => sample.attach?.inputReadyMs)} | ${firstAccepted}/${good.length} echoed |`,
    )
  }
  lines.push(
    '',
    'Grok and OpenCode attach immediately after machine session creation and before the machine turn. Claude attaches after its process-per-turn SDK query; Codex attaches after the first machine turn because app-server thread/start does not create a resumable rollout.',
  )
  lines.push('', '## Raw native samples', '')
  lines.push(
    '| Provider | Run | First byte | Paint settled | Initial input ready | Prompt submitted at | Response visible | Next input ready | Result |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  )
  for (const provider of report.runOrder) {
    const result = report.providers[provider]
    if (!result) continue
    for (const sample of result.nativeSamples) {
      const cell = (value: number | undefined): string =>
        value === undefined ? '—' : `${value.toFixed(1)} ms`
      lines.push(
        `| ${provider} | ${sample.run} | ${cell(sample.timing.firstByteMs)} | ${cell(sample.timing.initialPaintSettledMs)} | ${cell(sample.timing.inputReadyMs)} | ${cell(sample.timing.promptSubmittedMs)} | ${cell(sample.timing.responseVisibleMs)} | ${cell(sample.timing.nextInputReadyMs)} | ${sample.timing.error ?? 'ok'} |`,
      )
    }
  }
  lines.push('', '## Raw machine and attach samples', '')
  lines.push(
    '| Provider | Run | Session ready | Prompt accepted | First response | Complete | Attach sequence | Attach invoked | Session → input | Attach first byte | Paint settled | Input ready | Result |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  )
  for (const provider of report.runOrder) {
    const result = report.providers[provider]
    if (!result) continue
    for (const sample of result.samples) {
      const cell = (value: number | undefined): string =>
        value === undefined ? '—' : `${value.toFixed(1)} ms`
      lines.push(
        `| ${provider} | ${sample.run} | ${cell(sample.start.sessionReadyMs)} | ${cell(sample.drive.promptAcceptedMs)} | ${cell(sample.drive.firstResponseMs)} | ${cell(sample.drive.completeMs)} | ${sample.attach?.sequence ?? '—'} | ${cell(sample.attach?.invokedAfterSessionReadyMs)} | ${cell(sample.attach?.sessionReadyToInputReadyMs)} | ${cell(sample.attach?.firstByteMs)} | ${cell(sample.attach?.initialPaintSettledMs)} | ${cell(sample.attach?.inputReadyMs)} | ${sample.error ?? sample.attach?.error ?? 'ok'} |`,
      )
    }
  }
  lines.push('', '## Mechanisms and evidence', '')
  for (const provider of report.runOrder) {
    const result = report.providers[provider]
    if (!result) continue
    lines.push(
      `- **${provider} ${result.version}:** native = ${result.nativeMechanism}; machine = ${result.machineMechanism}; attach = \`${result.attachMechanism}\``,
    )
  }
  lines.push(
    '',
    'Input probes type unique markers without Enter and require those markers to appear in the rendered terminal composer. “First keystroke” therefore measures whether input sent immediately after the first terminal byte survived startup; it is not inferred from painted output.',
    '',
    'These are observations, not stable product budgets. Provider load, network conditions, model choice, account tier, local config/plugins, machine load, and OS cache state all affect them. Consult the sibling JSON for host load, exact per-stage evidence, executable paths, and partial failures.',
    '',
  )
  return lines.join('\n')
}

async function checkpointReport(report: Report, config: Config): Promise<void> {
  report.generatedAt = new Date().toISOString()
  const writes: Promise<void>[] = []
  if (config.output) {
    await mkdir(dirname(config.output), { recursive: true })
    writes.push(writeFile(config.output, JSON.stringify(report, null, 2) + String.fromCharCode(10)))
  }
  if (config.markdown) {
    await mkdir(dirname(config.markdown), { recursive: true })
    writes.push(writeFile(config.markdown, renderMarkdown(report)))
  }
  await Promise.all(writes)
}

async function main(): Promise<void> {
  if (process.argv.includes('--claude-worker')) {
    await claudeWorker()
    return
  }
  const config = parseArgs(process.argv.slice(2))
  const tempRoot = await mkdtemp(join(tmpdir(), 'native-cli-lifecycle-'))
  const runtimeDir = join(tempRoot, 'runtime')
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  const report: Report = {
    schemaVersion: 2,
    benchmark: 'native-cli-lifecycle',
    generatedAt: new Date().toISOString(),
    runOrder: [...config.providers],
    prompt: PROMPT,
    config: {
      providers: [...config.providers],
      runs: config.runs,
      timeoutMs: config.timeoutMs,
      attachTimeoutMs: config.attachTimeoutMs,
      attachQuietMs: config.attachQuietMs,
      native: config.native,
      machine: config.machine,
      attach: config.attach,
      workdir: config.workdir ?? '<fresh temporary directory per sample>',
    },
    host: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      runtime: `Bun ${process.versions.bun ?? 'unknown'}`,
      cpu: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
      loadAverage: loadavg().map(round),
    },
    providers: {},
  }
  let failed = false
  try {
    for (const provider of config.providers) {
      let executable: string
      let version: string
      try {
        executable = resolveExecutable(provider)
        version = await versionOf(executable)
      } catch (error) {
        failed = true
        report.providers[provider] = {
          executable: '',
          version: 'unavailable',
          nativeMechanism: 'not run',
          machineMechanism: 'not run',
          attachMechanism: 'not run',
          nativeSamples: [
            {
              run: 1,
              workdir: config.workdir ?? '',
              startedAt: new Date().toISOString(),
              timing: {
                firstProbeAccepted: false,
                inputProbeAttempts: 0,
                firstPostResponseProbeAccepted: false,
                postResponseProbeAttempts: 0,
                setupActions: 0,
                outputBytes: 0,
                evidence: 'not run',
                error: errorText(error),
              },
            },
          ],
          samples: [
            {
              ...defaultSample(1, config.workdir ?? ''),
              error: errorText(error),
            },
          ],
        }
        continue
      }
      const machineMechanism = {
        claude: 'process-per-turn Agent SDK query',
        codex: 'Unix WebSocket app-server JSON-RPC',
        grok: 'ACP stdio JSON-RPC',
        opencode: 'Basic-auth loopback HTTP/SSE server',
      }[provider]
      const attachMechanism = {
        claude: 'claude --resume <session>',
        codex: 'codex resume <thread> --remote unix://<socket>',
        grok: 'grok --resume <session>',
        opencode: 'opencode attach <url> --session <session>',
      }[provider]
      const result: ProviderResult = {
        executable,
        version,
        nativeMechanism: `stock ${provider} TUI creates and drives a new session`,
        machineMechanism,
        attachMechanism,
        ...(process.env[`NATIVE_CLI_BENCH_${provider.toUpperCase()}_MODEL`]
          ? { model: process.env[`NATIVE_CLI_BENCH_${provider.toUpperCase()}_MODEL`] }
          : {}),
        nativeSamples: [],
        samples: [],
      }
      report.providers[provider] = result
      status(`${provider}: ${version} (${executable})`)
      if (config.native) {
        for (let run = 1; run <= config.runs; run += 1) {
          const workdir = config.workdir ?? join(tempRoot, `${provider}-native-${run}`)
          if (!config.workdir) await mkdir(workdir, { recursive: true })
          const nativeSample: NativeSample = {
            run,
            workdir,
            startedAt: new Date().toISOString(),
            timing: await measureNativeTurn({
              provider,
              executable,
              cwd: workdir,
              env: process.env,
              timeoutMs: config.timeoutMs,
              quietMs: config.attachQuietMs,
            }),
          }
          result.nativeSamples.push(nativeSample)
          if (nativeSample.timing.error) failed = true
          status(
            `${provider} native run ${run}/${config.runs}: ${nativeSample.timing.error ? `FAILED: ${nativeSample.timing.error}` : 'complete'}`,
          )
          await checkpointReport(report, config)
        }
      }
      if (config.machine) {
        for (let run = 1; run <= config.runs; run += 1) {
          const workdir = config.workdir ?? join(tempRoot, `${provider}-machine-${run}`)
          if (!config.workdir) await mkdir(workdir, { recursive: true })
          const sample = defaultSample(run, workdir)
          result.samples.push(sample)
          status(`${provider} machine run ${run}/${config.runs}: starting`)
          try {
            if (provider === 'claude') await benchClaude(config, executable, sample)
            else if (provider === 'codex') await benchCodex(config, executable, sample, runtimeDir)
            else if (provider === 'grok') await benchGrok(config, executable, sample)
            else await benchOpencode(config, executable, sample)
            if (sample.attach?.error) failed = true
            status(
              `${provider} machine run ${run}/${config.runs}: complete${sample.attach?.error ? `; attach: ${sample.attach.error}` : ''}`,
            )
          } catch (error) {
            failed = true
            sample.error = errorText(error)
            status(`${provider} machine run ${run}/${config.runs}: FAILED: ${sample.error}`)
          }
          await checkpointReport(report, config)
        }
      }
    }
    await checkpointReport(report, config)
    if (config.output) {
      status('wrote ' + config.output)
    } else {
      process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10))
    }
    if (config.markdown) status('wrote ' + config.markdown)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
  if (failed) process.exitCode = 1
}

await main()
