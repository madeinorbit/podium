// A measurement, not a repository test (POD-5923). Types attachment paths +
// text into a real CLI through Podium's production typing path — the terminal
// driver's `[...paths, text].join('\n')` composition, `createTerminalInjection`
// (bracketed paste, 90 ms CR) and the Bun PTY backend — and saves the program's
// own history records for each send. Scratch HOME, credential-free environment
// allowlist, a localhost fake model, and cleanup by recorded PID / by PORT.
//
//   bun docs/measurements/pod-5923-image-attachments/measure.ts \
//     --program claude|codex|grok --binary <path> --label <label> [--port 45923]

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { classifyClaudeScreen } from '../../../packages/harness/src/adapters/claude-code/state.ts'
import {
  createTerminalInjection,
  type TerminalInjectionPorts,
} from '../../../packages/harness/src/driver/families/terminal/injection.ts'
import { bunTerminalBackend } from '../../../packages/pty/src/backends/bun-terminal-backend.ts'

const { Terminal } = createRequire(new URL('../../../packages/pty/package.json', import.meta.url))(
  '@xterm/headless',
)
const args = process.argv.slice(2)
const option = (name: string, fallback?: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1]! : fallback!
const program = option('--program') as 'claude' | 'codex' | 'grok'
const binary = option('--binary')
const label = option('--label', program)
const port = Number(option('--port', '45923'))
const only = option('--cases', '')
if (!['claude', 'codex', 'grok'].includes(program) || !binary)
  throw new Error('--program claude|codex|grok --binary <path>')
const here = import.meta.dir
const output = join(here, `${label}.jsonl`)
const scratch = mkdtempSync(join(tmpdir(), `pod5923-${label}-`))
const home = join(scratch, 'home'),
  work = join(scratch, 'work')
for (const dir of [
  home,
  work,
  `${home}/.claude`,
  `${home}/.codex`,
  `${home}/.grok`,
  `${home}/.config`,
  `${home}/.cache`,
  `${home}/.local/share`,
  `${home}/.local/state`,
])
  mkdirSync(dir, { recursive: true })
execFileSync('git', ['init', '-q', work])

// ---- attachments: real PNGs and a text file, where Podium's uploads live ----
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = Buffer.concat(
    Array.from({ length: height }, () =>
      Buffer.concat([
        Buffer.from([0]),
        Buffer.from(Array.from({ length: width }, () => rgb).flat()),
      ]),
    ),
  )
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const uploads = join(home, '.podium', 'uploads', randomUUID())
mkdirSync(uploads, { recursive: true })
const file = (name: string, bytes: Buffer | string) => {
  const p = join(uploads, name)
  writeFileSync(p, bytes)
  return p
}
const png1 = file(`${randomUUID()}.png`, png(32, 24, [200, 30, 30]))
const png2 = file(`${randomUUID()}.png`, png(24, 32, [30, 30, 200]))
const txt1 = file(`${randomUUID()}.txt`, 'plain text attachment body\n')

// ---- the cases: synthetic text only --------------------------------------
const long = Array.from(
  { length: 14 },
  (_, i) =>
    `IMGLONG line ${i + 1}: ${'synthetic words for a paste longer than eight hundred characters '.slice(0, 60)}`,
).join('\n')
const cases: { name: string; paths: string[]; text: string; busy?: boolean }[] = [
  { name: 'one-image', paths: [png1], text: 'IMG1 what colour is this image?' },
  { name: 'two-images', paths: [png1, png2], text: 'IMG2 compare these two images' },
  {
    name: 'trailing-spaces',
    paths: [png1],
    text: 'IMG3 first line ends with a space \nsecond line ends with two  \nthird line',
  },
  { name: 'path-only', paths: [png1], text: '' },
  { name: 'two-images-path-only', paths: [png1, png2], text: '' },
  { name: 'long-text', paths: [png1], text: long },
  { name: 'text-file', paths: [txt1], text: 'TXT1 read this attachment' },
  {
    name: 'no-attachment-trailing-spaces',
    paths: [],
    text: 'PLAIN1 first line ends with a space \nsecond line',
  },
  { name: 'image-then-text-file', paths: [png1, txt1], text: 'MIX1 an image then a text file' },
  { name: 'text-file-then-image', paths: [txt1, png1], text: 'MIX2 a text file then an image' },
  {
    name: 'two-images-long-text',
    paths: [png1, png2],
    text: long.replaceAll('IMGLONG', 'IMG2LONG'),
  },
  {
    name: 'busy-one-image',
    paths: [png1],
    text: 'BUSY1 typed while the program is busy',
    busy: true,
  },
  { name: 'busy-path-only', paths: [png2], text: '', busy: true },
].filter((c) => !only || only.split(',').includes(c.name))
/** Exactly the terminal driver's composition (runtime.ts send()). */
const typed = (c: { paths: string[]; text: string }) =>
  [...c.paths, c.text].filter(Boolean).join('\n')

// ---- per-program configuration -------------------------------------------
const fakeKey = 'fake-key-for-the-local-fake-server-not-a-credential'
// WHITELIST: no credentials, live session hooks, or operator config are inherited.
const env: Record<string, string> = {
  PATH: process.env.PATH!,
  HOME: home,
  SHELL: '/bin/bash',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'C.UTF-8',
  XDG_CONFIG_HOME: `${home}/.config`,
  XDG_CACHE_HOME: `${home}/.cache`,
  XDG_DATA_HOME: `${home}/.local/share`,
  XDG_STATE_HOME: `${home}/.local/state`,
}
let argv: string[] = []
if (program === 'claude') {
  const config = `${home}/.claude`
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: [] } }))
  // tengu_virtual_pancake on: the paste-wrapper form the live session had (POD-4982).
  writeFileSync(
    join(config, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] },
      cachedGrowthBookFeatures: { tengu_virtual_pancake: true },
      projects: {
        [work]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
          allowedTools: [],
        },
      },
    }),
  )
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: fakeKey,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: '1',
  })
  argv = ['--model', 'claude-sonnet-4-6']
} else if (program === 'codex') {
  writeFileSync(
    `${home}/.codex/config.toml`,
    `model = "fake"\nmodel_provider = "fake"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\ncheck_for_update_on_startup = false\n[model_providers.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "FAKE_KEY"\nwire_api = "responses"\n[projects."${work}"]\ntrust_level = "trusted"\n`,
  )
  Object.assign(env, { CODEX_HOME: `${home}/.codex`, FAKE_KEY: 'dummy-not-a-key' })
} else {
  writeFileSync(
    `${home}/.grok/config.toml`,
    `[models]\ndefault = "fake"\n[model.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "FAKE_KEY"\n`,
  )
  Object.assign(env, { GROK_HOME: `${home}/.grok`, FAKE_KEY: 'dummy-not-a-key' })
  argv = ['-m', 'fake', '--always-approve', '--trust']
}
const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim()

// ---- native history --------------------------------------------------------
const historyRoot =
  program === 'claude'
    ? `${home}/.claude/projects`
    : program === 'codex'
      ? `${home}/.codex/sessions`
      : `${home}/.grok/sessions`
function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? (name === 'subagents' ? [] : files(p)) : [p]
    })
    .sort()
}
type Row = { source: string; line: number; record: any }
function records(): Row[] {
  return files(historyRoot)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => {
          if (!line) return []
          try {
            return [{ source: f.slice(home.length + 1), line: i + 1, record: JSON.parse(line) }]
          } catch {
            return []
          }
        }),
    )
}
/** A record that is (part of) a prompt entry, per program. */
function isPromptRecord(record: any): boolean {
  if (program === 'claude')
    return (
      record.type === 'user' ||
      (record.type === 'attachment' && record.attachment?.type === 'queued_command')
    )
  if (program === 'codex')
    return (
      record.type === 'event_msg' &&
      (record.payload?.type === 'user_message' ||
        (record.payload?.type === 'item_completed' && record.payload?.item?.type === 'UserMessage'))
    )
  return record.params?.update?.sessionUpdate === 'user_message_chunk'
}
/** Image data is replaced by size and digest; nothing else is changed. */
function redact(value: unknown, key = ''): unknown {
  if (
    typeof value === 'string' &&
    value.length > 512 &&
    (key === 'data' || key === 'image_url' || key === 'url' || /^data:image\//.test(value))
  )
    return `<redacted base64: ${value.length} chars sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}>`
  if (Array.isArray(value)) return value.map((v) => redact(v, key))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  return value
}

// ---- terminal ---------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(predicate: () => unknown, timeout = 30_000): Promise<boolean> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return true
    await sleep(50)
  }
  return false
}
const terminal = new Terminal({ cols: 160, rows: 45, allowProposedApi: true, scrollback: 2000 })
const flush = () => new Promise<void>((resolve) => terminal.write('', resolve))
function screen(): string[] {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let i = buffer.baseY; i < buffer.baseY + 45; i++)
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  return lines
}
let pty: ReturnType<ReturnType<typeof bunTerminalBackend>['spawn']> | undefined
let running = true
let lastOutput = Date.now()
let firstTurn = true

function inject(text: string, baseline: number, busy = false): Promise<unknown> {
  const abort = new AbortController()
  const cancel = setTimeout(() => abort.abort(), 15_000)
  const ports: TerminalInjectionPorts = {
    now: Date.now,
    running: () => running,
    live: () => true,
    phase: () => (busy ? 'working' : 'idle'),
    lastOutputAtMs: () => lastOutput,
    write(bytes) {
      appendFileSync(
        join(scratch, 'writes.jsonl'),
        `${JSON.stringify({ at: Date.now(), bytes })}\n`,
      )
      pty!.write(bytes)
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    rawFirstTurn: () => program === 'grok' && firstTurn,
    needsSubmitVerification: () => false,
    observedTurnEpoch: () => 0,
    echoAccept: {
      watch() {
        // Any new prompt record after the baseline: the measurement reads the
        // shape afterwards; it does not judge here.
        let accept!: (seen: {}) => void
        const accepted = new Promise<{}>((resolve) => {
          accept = resolve
        })
        const poll = setInterval(() => {
          if (
            records()
              .slice(baseline)
              .some((r) => isPromptRecord(r.record))
          )
            accept({})
        }, 50)
        return {
          accepted,
          typingStartedAtMs: Date.now(),
          cancel() {
            clearInterval(poll)
          },
        }
      },
    },
  }
  const machine = createTerminalInjection(ports)
  return machine
    .deliver(text, {
      origin: 'human',
      delivery: busy ? 'steer' : 'when-ready',
      signal: abort.signal,
    })
    .finally(() => {
      clearTimeout(cancel)
      machine.dispose()
      firstTurn = false
    })
}
const fakeLog = join(scratch, 'requests.jsonl')
const requests = () =>
  existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).length : 0
async function settle(): Promise<void> {
  // Records, model requests and screen quiet for 2.5 s (Claude: not working).
  let last = '',
    stable = 0
  await until(async () => {
    await flush()
    const busy = program === 'claude' && classifyClaudeScreen(screen()).turnRunning
    const sig = `${records().length}:${requests()}:${busy}`
    if (sig === last && !busy && Date.now() - lastOutput > 800) stable += 1
    else {
      stable = 0
      last = sig
    }
    return stable >= 50
  }, 60_000)
}

let fake: ReturnType<typeof Bun.spawn> | undefined
const pids: Record<string, unknown> = { port }
try {
  // Refuse an owned port; never kill a server this run did not start.
  if (Bun.spawnSync(['fuser', `${port}/tcp`], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0)
    throw new Error(`Port ${port} is occupied`)
  fake = Bun.spawn([process.execPath, join(here, 'fake-model-server.ts')], {
    env: { PATH: env.PATH!, FAKE_PORT: String(port), FAKE_LOG: fakeLog },
    stdout: Bun.file(join(scratch, 'fake.stdout')),
    stderr: Bun.file(join(scratch, 'fake.stderr')),
  })
  pids.fake = fake.pid
  if (
    !(await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok
      } catch {
        return false
      }
    }))
  )
    throw new Error('fake not up')
  pty = bunTerminalBackend().spawn({
    file: binary,
    args: argv,
    cwd: work,
    env,
    cols: 160,
    rows: 45,
  })
  pids.cli = pty.pid
  writeFileSync(join(scratch, 'pids.json'), JSON.stringify(pids))
  pty.onData((bytes) => {
    lastOutput = Date.now()
    terminal.write(bytes)
  })
  pty.onExit(() => {
    running = false
  })
  terminal.onData((bytes: string) => pty!.write(bytes))
  console.log(JSON.stringify({ label, program, version, scratch, pids }))
  const ready = await until(async () => {
    await flush()
    const text = screen().join('\n')
    if (program === 'claude') return screen().some((line) => line.trimStart().startsWith('❯'))
    if (program === 'codex') return /context left|OpenAI Codex|›/.test(text)
    return /fake|Type a message|Grok/.test(text)
  }, 45_000)
  if (!ready) throw new Error(`not ready:\n${screen().join('\n')}`)
  await sleep(2500)
  // Warm-up: a plain first turn (Grok's is raw keystrokes; attachments are refused there).
  await inject(`WARMUP ${label} hello`, records().length)
  await settle()
  const run = {
    label,
    program,
    version,
    binary,
    sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    startedAt: new Date().toISOString(),
    scratch,
    port,
    env: Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'PATH')),
    argv,
    attachments: { png1, png2, txt1 },
  }
  writeFileSync(join(here, `${label}.run.json`), `${JSON.stringify(run, null, 2)}\n`)
  writeFileSync(output, '')
  for (const c of cases) {
    let setup: Promise<unknown> | undefined
    if (c.busy) {
      // Busy: a setup prompt whose reply the fake holds for 8 s; type the case
      // once that request is streaming.
      const seen = requests()
      setup = inject(`SLOWSETUP ${c.name}`, records().length)
      await setup
      await until(
        () =>
          existsSync(fakeLog) &&
          readFileSync(fakeLog, 'utf8')
            .split('\n')
            .slice(seen)
            .some((l) => l.includes('SLOWSETUP')),
        15_000,
      )
      await sleep(700)
    }
    const before = records()
    const text = typed(c)
    const sentAt = Date.now()
    const receipt = await inject(text, before.length, c.busy)
    await settle()
    await flush()
    const after = records()
    const known = new Set(before.map((r) => `${r.source}:${r.line}`))
    const fresh = after.filter((r) => !known.has(`${r.source}:${r.line}`))
    const row = {
      case: c.name,
      program,
      version,
      busy: c.busy === true,
      paths: c.paths,
      text: c.text,
      typed: text,
      sentAt,
      receipt: (receipt as { outcome?: string })?.outcome,
      // Records between the send and settle, in file order; the preceding record
      // too (Grok's prompt id rides on the record before the chunk).
      previous: before.at(-1) ? redact(before.at(-1)!.record) : null,
      records: fresh.map((r) => ({ source: r.source, line: r.line, record: redact(r.record) })),
      screen: screen().filter((line) => line.trim()),
    }
    appendFileSync(output, `${JSON.stringify(row)}\n`)
    console.log(
      JSON.stringify({
        case: c.name,
        receipt: row.receipt,
        records: fresh.length,
        prompts: fresh.filter((r) => isPromptRecord(r.record)).length,
      }),
    )
  }
} finally {
  // Stop only the PIDs recorded for this run. The fake is stopped by its PORT.
  if (pty) {
    try {
      pty.kill('SIGTERM')
    } catch {}
  }
  // Codex 0.162.0 starts a managed app-server daemon from a copy of itself
  // under CODEX_HOME that outlives its TUI. Stop exactly the processes whose
  // command line names this run's unique scratch directory.
  await sleep(500)
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      if (
        Number(pid) !== process.pid &&
        readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(scratch)
      )
        process.kill(Number(pid), 'SIGTERM')
    } catch {}
  }
  if (fake) {
    const owners = Bun.spawnSync(['fuser', `${port}/tcp`], { stdout: 'pipe', stderr: 'pipe' })
    const ids = Buffer.from(owners.stdout)
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
    if (ids.length === 1 && ids[0] === fake.pid)
      Bun.spawnSync(['fuser', '-k', `${port}/tcp`], { stdout: 'pipe', stderr: 'pipe' })
    else fake.kill('SIGTERM')
  }
  terminal.dispose()
  // The scratch HOME can reach hundreds of MB (Codex); keep it only on request.
  if (!args.includes('--keep')) {
    await sleep(500)
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(JSON.stringify({ finished: label, scratch, output }))
}
