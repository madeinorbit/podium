/**
 * Posture probe (POD-6879, Task 0 of the session posture plan): start one agent
 * CLI in a PTY and report what it draws at startup. A measuring tool for the
 * spike and for the acceptance run, not product code.
 *
 *   bun scripts/posture-probe.ts --harness <kind> --home <dir> --cwd <dir>
 *       [--seconds 10] [--cols 120] [--rows 40] [--bin <path>] [--env K=V]... [-- <extra args>]
 *
 * Prints one JSON line: `{ "screenTail": string, "exitCode": number | null }`.
 * `screenTail` is the visible screen when the time ran out (or when the process
 * exited), trailing blank rows dropped.
 *
 * The child gets a scrubbed environment: everything from this process except
 * `PODIUM_*`, `CLAUDE_CODE_*`, `CLAUDECODE` and `XDG_*`, with `HOME` set to
 * `--home`. A harness that keys its folders off XDG then lands inside the fresh
 * home too. `--env` adds or overrides variables after the scrub.
 *
 * It never sends a key. A prompt the CLI needs answering stays on screen, which
 * is what the probe is for.
 */
// Relative imports: the root package does not depend on @podium/process.
import { AGENT_MANIFESTS } from '../packages/harness/src/registry.js'
import {
  type BuiltinHarnessKind,
  CLAUDE_CODE_HARNESS_KIND,
  HarnessAgent,
} from '../packages/model/src/entities/agent.js'
import { defaultPtyBackend } from '../packages/pty/src/backends/index.js'
import { createHeadlessScreen } from '../packages/pty/src/screen-model.js'

/** Keep the tool's existing aliases while reading executable names from their owner. */
function declaredBinary(kind: BuiltinHarnessKind): string {
  const executable = AGENT_MANIFESTS[kind].inventory.executable.names[0]
  if (!executable) throw new Error(`${kind} declares no executable`)
  return executable
}

const BINARIES: Record<string, string> = {
  claude: declaredBinary(CLAUDE_CODE_HARNESS_KIND),
  codex: declaredBinary(HarnessAgent.enum.codex),
  opencode: declaredBinary(HarnessAgent.enum.opencode),
  grok: declaredBinary(HarnessAgent.enum.grok),
  pi: declaredBinary(HarnessAgent.enum.pi),
  cursor: declaredBinary(HarnessAgent.enum.cursor),
}

interface Options {
  harness: string
  home: string
  cwd: string
  seconds: number
  cols: number
  rows: number
  bin?: string
  env: Record<string, string>
  extra: string[]
}

function parse(argv: string[]): Options {
  const split = argv.indexOf('--')
  const own = split < 0 ? argv : argv.slice(0, split)
  const extra = split < 0 ? [] : argv.slice(split + 1)
  const opts: Partial<Options> & { env: Record<string, string> } = {
    seconds: 10,
    cols: 120,
    rows: 40,
    env: {},
  }
  for (let i = 0; i < own.length; i += 1) {
    const flag = own[i]
    const value = own[i + 1]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    i += 1
    switch (flag) {
      case '--harness':
        opts.harness = value
        break
      case '--home':
        opts.home = value
        break
      case '--cwd':
        opts.cwd = value
        break
      case '--seconds':
        opts.seconds = Number(value)
        break
      case '--cols':
        opts.cols = Number(value)
        break
      case '--rows':
        opts.rows = Number(value)
        break
      case '--bin':
        opts.bin = value
        break
      case '--env': {
        const eq = value.indexOf('=')
        if (eq < 1) throw new Error(`--env wants KEY=VALUE, got ${value}`)
        opts.env[value.slice(0, eq)] = value.slice(eq + 1)
        break
      }
      default:
        throw new Error(`unknown flag ${flag}`)
    }
  }
  if (!opts.harness || !(opts.harness in BINARIES))
    throw new Error(`--harness must be one of ${Object.keys(BINARIES).join(', ')}`)
  if (!opts.home || !opts.cwd) throw new Error('--home and --cwd are required')
  return { ...(opts as Options), extra }
}

function scrubbedEnv(home: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('PODIUM_') || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE')
      continue
    if (key.startsWith('XDG_')) continue
    env[key] = value
  }
  env.HOME = home
  env.TERM = 'xterm-256color'
  return { ...env, ...extra }
}

async function main(): Promise<void> {
  const opts = parse(process.argv.slice(2))
  const file = opts.bin ?? Bun.which(BINARIES[opts.harness] as string)
  if (!file) throw new Error(`${BINARIES[opts.harness]} is not on PATH; pass --bin`)
  const screen = createHeadlessScreen(opts.cols, opts.rows)
  const child = defaultPtyBackend().spawn({
    file,
    args: opts.extra,
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: scrubbedEnv(opts.home, opts.env),
  })
  // Answer the cursor-position query some TUIs send before drawing: that is the
  // terminal's own reply, not a key press.
  child.onData((bytes) => {
    screen.write(bytes)
    if (Buffer.from(bytes).includes('\x1b[6n')) child.write(new TextEncoder().encode('\x1b[1;1R'))
  })
  let exitCode: number | null = null
  const exited = new Promise<void>((resolve) =>
    child.onExit((e) => {
      exitCode = e.exitCode
      resolve()
    }),
  )
  await Promise.race([exited, Bun.sleep(opts.seconds * 1000)])
  await screen.flush()
  const lines = screen.lines(false)
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
  if (exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([exited, Bun.sleep(1500)])
    if (exitCode === null) child.kill('SIGKILL')
  }
  process.stdout.write(`${JSON.stringify({ screenTail: lines.join('\n'), exitCode })}\n`)
  screen.dispose()
  process.exit(0)
}

main().catch((error: unknown) => {
  process.stderr.write(`posture-probe: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
})
