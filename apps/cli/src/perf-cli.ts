/**
 * `podium perf` — the reader's end of the event-loop instrument
 * (docs/internal/superpowers/specs/2026-09-10-loop-profile-levels-design.md §7.3).
 *
 * The instrument writes a minute file per component and a directory of CPU
 * profiles. Both are plain files under the state root, and every previous
 * investigation began by an agent guessing where they were and whether the
 * process was recording at all. These three commands answer exactly that: what
 * level is this install at and who decided, where are the files, and give me a
 * profile of the live process right now.
 *
 * The group is hidden from `podium --help` unless the `podium-development`
 * feature is on (§7.3), because a customer install at `off` has nothing here to
 * read. The COMMANDS run regardless — a support session raising the level on a
 * customer box must not also have to enable a feature flag to read the result.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_PROFILE_SAMPLE_US,
  JSC_SAMPLE_INTERVAL_ENV,
  LOOP_PROFILE_ENV,
  type LoopProfileLevel,
  loadConfig,
  PROFILE_ON_STALL_ENV,
  resolveLoopProfileLevel,
  stateDir,
} from '@podium/runtime/config'
import type { LoopComponent } from '@podium/runtime/loop-accounting'
import { loopMinutePath } from '@podium/runtime/loop-minute-sink'
import { profileDir, writeProfileRequest } from '@podium/runtime/loop-profile-capture'
import { liveRecord } from '@podium/runtime/run-registry'

export class PerfCliError extends Error {}

/** Exit codes the plan fixes, so a script can branch on them (plan D step 3). */
export const PERF_EXIT_LEVEL_TOO_LOW = 2
export const PERF_EXIT_NO_PROFILE = 3
/** The process wrote a record saying why it would not profile (POD-3834). */
export const PERF_EXIT_REFUSED = 4

/** Everything the commands touch, injected so the tests need no live install. */
export interface PerfCliDeps {
  perfDir: string
  level: () => { level: LoopProfileLevel; source: string }
  /** The component's live pid, or undefined when it is not running. */
  pid: (component: LoopComponent) => number | undefined
  signal: (pid: number, signal: NodeJS.Signals) => void
  listProfiles: (dir: string) => string[]
  /** The profile's bytes, so a refusal can be read out instead of pointed at. */
  readProfile: (path: string) => string
  writeRequest: (perfDir: string, seconds: number) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export function defaultPerfDeps(): PerfCliDeps {
  const dir = join(stateDir(), 'perf')
  return {
    perfDir: dir,
    level: () => {
      const resolved = resolveLoopProfileLevel(loadConfig())
      return { level: resolved.level, source: resolved.source }
    },
    pid: (component) => liveRecord(component)?.pid,
    signal: (pid, sig) => process.kill(pid, sig),
    listProfiles: (target) => (existsSync(target) ? readdirSync(target) : []),
    readProfile: (path) => readFileSync(path, 'utf8'),
    writeRequest: writeProfileRequest,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

export function perfHelpText(): string {
  return [
    'podium perf <command>',
    '',
    'Read this install’s event-loop instrument: the resolved profile level, the',
    'per-minute files both components write, and on-demand CPU profiles.',
    '',
    '  level [--json]        Print the resolved level and which layer decided it',
    '  paths [--json]        Print the minute files and the profile directory',
    '  profile <server|daemon> [--seconds N]',
    '                        Capture a CPU profile from the live process and print',
    '                        its path (default 10 s, 1–60)',
    '  --help                Show this help',
    '',
    `Levels, weakest first: off, accounting, attribution, full. ${LOOP_PROFILE_ENV} in the`,
    'environment overrides config.loopProfile, which overrides the channel default',
    '(attribution on dev and source runs, off elsewhere).',
    '',
    'Profiles need attribution or full: `profile` exits 2 below that, 3 when the',
    'process produced no file in time, and 4 when it wrote one saying why it would',
    'not — it prints that reason.',
    '',
    'A stall does NOT arm a profile by itself: the sampler cannot be stopped once',
    'armed, so automatic arming is a permanent cost. Set config.profileOnStall (or',
    `${PROFILE_ON_STALL_ENV}=1) for an investigation that needs it. The sampler's`,
    `period comes from ${JSC_SAMPLE_INTERVAL_ENV} in the process environment at`,
    `startup — ${DEFAULT_PROFILE_SAMPLE_US}us by default, and a period nothing asked`,
    'for is refused rather than paid for.',
  ].join('\n')
}

const COMPONENTS: readonly LoopComponent[] = ['server', 'daemon']

function isComponent(value: string | undefined): value is LoopComponent {
  return COMPONENTS.includes(value as LoopComponent)
}

/** The two levels that install the profile seams (spec §3.1). */
function capturesProfiles(level: LoopProfileLevel): boolean {
  return level === 'attribution' || level === 'full'
}

export interface PerfCommandResult {
  output: string
  exitCode?: number
}

function levelCommand(argv: string[], deps: PerfCliDeps): PerfCommandResult {
  const { level, source } = deps.level()
  return {
    output: argv.includes('--json')
      ? JSON.stringify({ level, source })
      : `level=${level} source=${source}`,
  }
}

function pathsCommand(argv: string[], deps: PerfCliDeps): PerfCommandResult {
  const minutes = {
    server: loopMinutePath(deps.perfDir, 'server'),
    daemon: loopMinutePath(deps.perfDir, 'daemon'),
  }
  const profiles = profileDir(deps.perfDir)
  return {
    output: argv.includes('--json')
      ? JSON.stringify({ minutes, profiles })
      : [minutes.server, minutes.daemon, profiles].join('\n'),
  }
}

/** `--seconds N`, validated here so a bad value never reaches the live process. */
function parseSeconds(argv: string[]): number {
  const index = argv.indexOf('--seconds')
  if (index === -1) return 10
  const raw = argv[index + 1]
  const seconds = Number(raw)
  if (!raw || !Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
    throw new PerfCliError(`--seconds must be a number from 1 to 60 (got ${raw ?? 'nothing'})`)
  }
  return seconds
}

/**
 * The refusal a profile records, when it records one. Anything unreadable is
 * treated as a real capture: a parse failure here must not turn a profile the
 * operator can use into an error message.
 */
function refusalIn(read: (path: string) => string, path: string): string | undefined {
  try {
    const envelope = JSON.parse(read(path)) as { refused?: unknown }
    return typeof envelope.refused === 'string' ? envelope.refused : undefined
  } catch {
    return undefined
  }
}

async function profileCommand(argv: string[], deps: PerfCliDeps): Promise<PerfCommandResult> {
  const component = argv[0]
  if (!isComponent(component)) {
    throw new PerfCliError(
      `profile needs a component: ${COMPONENTS.join(' or ')} (got ${component ?? 'nothing'})`,
    )
  }
  const seconds = parseSeconds(argv)

  // The level gate first: it is the answer that does not need the process to be
  // running, and it is the one an agent hits by default on a customer install.
  const { level, source } = deps.level()
  if (!capturesProfiles(level)) {
    return {
      output:
        `level=${level} (from ${source}) does not capture profiles — ` +
        `set config.loopProfile or ${LOOP_PROFILE_ENV} to attribution or full and restart ${component}`,
      exitCode: PERF_EXIT_LEVEL_TOO_LOW,
    }
  }

  const pid = deps.pid(component)
  if (pid === undefined) {
    throw new PerfCliError(`no live ${component} in the run registry — is it running?`)
  }

  const dir = profileDir(deps.perfDir)
  // Only files that appear AFTER the signal count. The directory holds up to 20
  // per component already, and reporting one of those as this capture would be
  // a stale answer that looks exactly like a fresh one.
  const before = new Set(deps.listProfiles(dir))
  const wanted = (name: string): boolean =>
    name.startsWith(`${component}-`) && name.endsWith('-signal.json') && !before.has(name)

  deps.writeRequest(deps.perfDir, seconds)
  deps.signal(pid, 'SIGUSR2')

  // The window plus slack for the drain and the write. A capture the process
  // refused (rate limit, one already running) never appears, and that is what
  // the timeout reports.
  const deadline = deps.now() + (seconds + 15) * 1000
  while (deps.now() < deadline) {
    await deps.sleep(250)
    const found = deps.listProfiles(dir).filter(wanted).sort().pop()
    if (found) {
      const path = join(dir, found)
      // A REFUSAL is a file too, and it is the answer — a path on its own would
      // read as a successful capture and send the operator to open megabytes of
      // stacks that are not there (POD-3834).
      const refused = refusalIn(deps.readProfile, path)
      if (refused) {
        return {
          output: `the ${component} refused this capture: ${refused}\n${path}`,
          exitCode: PERF_EXIT_REFUSED,
        }
      }
      return { output: path }
    }
  }
  return {
    output:
      `no profile appeared within ${seconds + 15}s — the ${component} may have refused it ` +
      '(one capture per five minutes per component), or it is not at attribution',
    exitCode: PERF_EXIT_NO_PROFILE,
  }
}

export async function runPerfCli(
  argv: string[],
  deps: PerfCliDeps = defaultPerfDeps(),
): Promise<PerfCommandResult> {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { output: perfHelpText() }
  }
  switch (command) {
    case 'level':
      return levelCommand(rest, deps)
    case 'paths':
      return pathsCommand(rest, deps)
    case 'profile':
      return await profileCommand(rest, deps)
    default:
      throw new PerfCliError(`unknown command '${command}' (see \`podium perf --help\`)`)
  }
}

export async function perfCliMain(argv: string[]): Promise<void> {
  try {
    const { output, exitCode } = await runPerfCli(argv)
    if (exitCode) {
      console.error(`podium perf: ${output}`)
      process.exitCode = exitCode
      return
    }
    console.log(output)
  } catch (error) {
    console.error(`podium perf: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
