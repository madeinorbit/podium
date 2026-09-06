/**
 * Cached-by-default typecheck entry point (POD-1378). `bun run typecheck` lands here.
 *
 * Turbo's cache key covers tracked file content (`$TURBO_DEFAULT$`, bun.lock,
 * tooling/tsconfig) but is blind to the install environment: bunfig.toml and the
 * node_modules layout are never hashed, so a linker flip or a broken install keeps
 * reporting a stale green. This wrapper closes that hole and makes uncached
 * runs deliberate:
 *
 *   1. Resolves every declared workspace edge and every exercised @podium subpath
 *      from its owning workspace, and walks the linked tree for third-party
 *      breakage the workspace census cannot see. Missing, dangling, undeclared, or
 *      external resolutions are refused regardless of the installer's linker topology.
 *   2. Fingerprints the environment (the effective install configuration and the
 *      topology it produced, plus the resolution census) into PODIUM_CHECK_ENV_HASH,
 *      declared in turbo.json `globalEnv`, so any environment drift is an automatic
 *      cache MISS — no --force needed. Fingerprinting the tracked bunfig.toml alone
 *      was not enough: an install driven by an external `--config` leaves that file
 *      untouched, so hoisted and global-store layouts shared one identity (POD-2774).
 *   3. Refuses --force / TURBO_FORCE unless an explicit reason is given via
 *      --uncached-because="<reason>". A forced 22-package run costs ~3m of CPU
 *      (110x the cached 2s) on a host shared with a live Podium instance.
 *   4. Runs every project and makes the run account for itself (POD-3517). Turbo
 *      fail-fasts by default and abandons whatever it had not started, while its
 *      footer keeps counting those tasks in the total — "23 successful, 26 total"
 *      with one failure named is a run that silently dropped two projects. So the
 *      wrapper passes --continue=always and then checks the run summary: if any
 *      task in the graph reported no result, it says which, and an unverifiable
 *      green is refused outright.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { arch, cpus, freemem, homedir, platform } from 'node:os'
import { join } from 'node:path'
import { type InstallTopology, readInstallTopology } from './install-topology'
import { sharedCacheDir } from './shared-cache-dir'
import { readWorkspaceResolutionCensus, workspaceDirectories } from './workspace-resolution-census'

export interface ForceDecision {
  forceRequested: boolean
  reason: string | null
  /** args to forward to turbo (reason flag stripped, --force re-added iff allowed) */
  forwardArgs: string[]
  error: string | null
}

const REFUSAL = `\
uncached typecheck refused.

A forced run recomputes every package (24 of them; ~3m14s of CPU when that was
last measured at 22) instead of reusing the cache (~2s) on a host shared with a
live Podium instance.

WHAT THE KEY COVERS: each package's own tracked files; the task hashes of the
packages it depends on; bun.lock and tooling/tsconfig; the effective install
configuration, install topology, and workspace resolution census (via
PODIUM_CHECK_ENV_HASH), so installs, linker changes and base swaps are noticed
automatically; and, for packages that import sources outside their own directory
by relative path, those directories as explicit turbo inputs.

WHAT IT STILL CANNOT SEE (POD-2807). That last clause is hand-maintained in
turbo.json, and the guard that keeps it honest — "keeps every typecheck cache
key over the sources that task actually reads", in scripts/test-configuration.test.ts
— runs under 'bun run test', not here. It reads relative imports statically, so
a package that escapes its directory some other way (a tsconfig "paths" alias, an
"include" glob pointing outside, a computed specifier) is still invisible to it.
This refusal used to claim the key covered source files full stop; it did not,
and a red sat behind a replayed green for three days on the strength of that
sentence. Treat the list above as the limit of what is checked, not as proof
that nothing is missing.

If you still believe the cache is wrong, state why:

  bun run typecheck -- --uncached-because="<what the cache is missing>"

and consider filing the reason as an issue — a real gap in the cache key should
be closed there, not worked around with --force forever.`

/** Pure decision: does this invocation get to skip the cache? */
export function decideForce(
  args: string[],
  env: Record<string, string | undefined>,
): ForceDecision {
  const forward: string[] = []
  let reason: string | null = null
  let forceRequested = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--uncached-because') {
      reason = args[++i] ?? ''
    } else if (a.startsWith('--uncached-because=')) {
      reason = a.slice('--uncached-because='.length)
    } else if (a === '--force' || a.startsWith('--force=')) {
      forceRequested = true
    } else if (a.startsWith('--cache=')) {
      // e.g. --cache=local:w,remote:w — no store readable means --force by another spelling
      const readable = a
        .slice('--cache='.length)
        .split(/[,;]/)
        .some((pair) => (pair.split(':')[1] ?? '').includes('r'))
      if (!readable) forceRequested = true
      else forward.push(a)
    } else {
      forward.push(a)
    }
  }
  if (env.TURBO_FORCE && env.TURBO_FORCE !== '0' && env.TURBO_FORCE !== 'false') {
    forceRequested = true
  }
  if (reason !== null && reason.trim() === '') {
    return {
      forceRequested,
      reason,
      forwardArgs: forward,
      error: 'empty --uncached-because reason',
    }
  }
  if (forceRequested && reason === null) {
    return { forceRequested, reason, forwardArgs: forward, error: REFUSAL }
  }
  if (reason !== null) forward.push('--force')
  return {
    forceRequested: forceRequested || reason !== null,
    reason,
    forwardArgs: forward,
    error: null,
  }
}

export interface EnvCensus {
  /** effective install configuration and the topology it produced */
  install: InstallTopology
  /** sorted owner/specifier/relative-realpath records */
  resolutions: string[]
  /** every reason this environment may not serve or produce a cached result */
  admissionErrors: string[]
  runtime: {
    bun: string
    platform: string
    arch: string
  }
}

/** Environment fingerprint: hashed into the turbo cache key via globalEnv. */
export function fingerprint(census: EnvCensus): string {
  return createHash('sha256')
    .update(census.install.config.join('\0'))
    .update('\0')
    .update(census.install.layout.join('\0'))
    .update('\0')
    .update(census.resolutions.join('\0'))
    .update('\0')
    .update(`${census.runtime.bun}:${census.runtime.platform}:${census.runtime.arch}`)
    .digest('hex')
}

export function readCensus(root: string): EnvCensus {
  const install = readInstallTopology(root)
  const resolution = readWorkspaceResolutionCensus(root)
  return {
    install,
    resolutions: resolution.records,
    admissionErrors: [...resolution.errors, ...install.errors],
    runtime: {
      bun: Bun.version,
      platform: platform(),
      arch: arch(),
    },
  }
}

/**
 * One refusal for every cached entry point. A cached green is a claim about an
 * environment; if the environment is already broken the claim is not evidence,
 * so this has to run before turbo can serve or record a hit.
 */
export function admissionRefusal(census: EnvCensus, lane: string): string | null {
  if (census.admissionErrors.length === 0) return null
  return (
    `${lane} refused: this install cannot produce or replay a trustworthy cached ` +
    `result (POD-1343, POD-2774).\n- ${census.admissionErrors.join('\n- ')}`
  )
}

/**
 * The Turbo cache lane of the shared durable cache root (see scripts/shared-cache-dir.ts,
 * which holds the reasoning about the common-git-dir key and the base directory).
 */
export function sharedTurboCacheDir(root: string, env = process.env, home = homedir()): string {
  return sharedCacheDir('turbo', root, env, home)
}

/** Peak RSS of one tsgo, rounded up from 817MB measured on this repo. The cap is
 *  built on this number rather than on core count because RAM, not CPU, is what
 *  runs out first: a 28-task graph at turbo's default of 10 wants ~8GB. */
const COMPILER_MB = 900

/** Headroom this gate refuses to spend. The daemon, every other agent session and
 *  any live Podium instance share this machine, and a typecheck that takes the box
 *  to the edge kills them rather than itself. 1.5GB is the floor below which work
 *  on this host has been measured going bad — starved vitest runs taking minutes of
 *  wall time for seconds of CPU, and tsgo dying with exit 144 and an empty log. */
const RESERVE_MB = 1500

/** MemAvailable, which is what the kernel thinks is obtainable without swapping —
 *  `freemem()` undercounts badly because it ignores reclaimable page cache, and a
 *  cap built on it would serialise a machine that is actually fine. */
export function availableMb(meminfo?: string): number {
  const text = meminfo ?? (existsSync('/proc/meminfo') ? readFileSync('/proc/meminfo', 'utf8') : '')
  const match = text.match(/^MemAvailable:\s+(\d+) kB$/m)
  if (match?.[1]) return Math.floor(Number(match[1]) / 1024)
  return Math.floor(freemem() / 1024 / 1024)
}

/**
 * How many compilers this machine can run at once, right now.
 *
 * Nothing capped this before. Turbo's default is 10, the graph has 28 tasks, and
 * each tsgo peaks near a gigabyte — on a six-core box with 12GB shared between the
 * daemon, every agent session and any live instance, that is how the machine dies.
 * Two at 817MB and 739MB were measured together while the host sat at load 90 with
 * 859MB free.
 *
 * The alternative that does NOT work is telling agents to check free memory and
 * wait: nothing schedules them, so the outcome is an idle machine and work that
 * never starts. The tool has the numbers, so the tool decides.
 *
 * An explicit `--concurrency` from the caller always wins — this only fills in a
 * default that was never sensible.
 */
export function decideConcurrency(args: string[], env: { cores: number; availableMb: number }) {
  if (args.some((a) => a === '--concurrency' || a.startsWith('--concurrency='))) {
    return { cap: null as number | null, reason: 'caller set --concurrency' }
  }
  const byMemory = Math.floor(Math.max(0, env.availableMb - RESERVE_MB) / COMPILER_MB)
  // Leave a core for the daemon and whatever else is live; never propose zero,
  // because refusing to run at all is the failure mode we are avoiding, not a
  // safety feature. One at a time is slow; it still finishes.
  const byCores = Math.max(1, env.cores - 1)
  const cap = Math.max(1, Math.min(byCores, byMemory))
  return {
    cap,
    reason:
      `${env.cores} cores, ${env.availableMb}MB available, ` +
      `~${COMPILER_MB}MB per compiler, ${RESERVE_MB}MB reserved`,
  }
}

/**
 * Turbo's `--continue` defaults to "never": the run stops at the first failing task and
 * every task it had not started is abandoned. The footer does not say so. A real run of
 * this gate printed
 *
 *   Tasks:    23 successful, 26 total
 *   Failed:   @podium/scripts#typecheck
 *
 * which accounts for 24 of 26 tasks and says nothing about the other two — @podium/web
 * and @podium/mobile, both of them red, one of them literally mid-compile ("cache miss,
 * executing") when the run was cancelled. apps/web had been red behind that silence
 * since the async flip (POD-3516), and scripts/ before it (POD-3508).
 *
 * "always" rather than "dependencies-successful", because a typecheck task consumes no
 * artifact from the task it depends on: every package runs `tsgo --noEmit` and declares
 * no outputs, and workspace imports resolve to a dependency's SOURCE. `^typecheck` is an
 * ordering edge, so a red dependency does not make a dependent's own errors any less
 * true — and under "dependencies-successful" a single red package near the root of the
 * graph hides every package downstream of it, which is the defect this fixes, not a
 * milder version of it.
 *
 * A caller who spells their own `--continue` means it and gets it.
 */
export function decideContinue(args: string[]): string[] {
  const spelled = args.some((a) => a === '--continue' || a.startsWith('--continue='))
  return spelled ? [] : ['--continue=always']
}

/** `--summarize` is how this wrapper reads what ran; a caller who asked for it keeps the file. */
export function decideSummarize(args: string[]): { add: string[]; callerOwnsFile: boolean } {
  const spelled = args.some((a) => a === '--summarize' || a.startsWith('--summarize='))
  return spelled
    ? { add: [], callerOwnsFile: true }
    : { add: ['--summarize'], callerOwnsFile: false }
}

/** What a run summary says about coverage: the size of the graph, and who reported back. */
export interface RunAccounting {
  /** Turbo's own count of the tasks in the graph — present even when the run was cut short. */
  attempted: number
  /** Task ids that carry an execution record. A task turbo never started has none. */
  reported: string[]
}

/**
 * Read `--summarize` output for coverage, not for timings.
 *
 * The load-bearing detail: a task turbo never started is ABSENT from `tasks` altogether
 * — the truncated run above wrote 24 task records for a graph of 26 — so the shortfall
 * has to be counted against `execution.attempted` and cannot be read off the task list.
 * A task that is listed but carries no execution record (a shape a later turbo could
 * emit for a cancelled task) counts as unreported too, which is the same question asked
 * the other way round.
 */
export function readRunAccounting(text: string): RunAccounting | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const summary = parsed as { execution?: { attempted?: unknown }; tasks?: unknown }
  const attempted = summary.execution?.attempted
  if (typeof attempted !== 'number' || !Array.isArray(summary.tasks)) return null
  const reported: string[] = []
  for (const entry of summary.tasks) {
    if (typeof entry !== 'object' || entry === null) return null
    const task = entry as { taskId?: unknown; execution?: { exitCode?: unknown } | null }
    if (typeof task.taskId !== 'string') return null
    if (task.execution && typeof task.execution.exitCode === 'number') reported.push(task.taskId)
  }
  return { attempted, reported }
}

/**
 * Every task `turbo run typecheck` will attempt: one per workspace declaring the script.
 *
 * Derived from the manifests rather than from a second `turbo --dry` run, because the
 * graph is a fact about the workspace and a dry run costs about what the cached gate it
 * guards costs. It is used only to NAME what went missing; the count that decides the
 * refusal is turbo's own, so a wrong universe cannot invent or suppress a refusal.
 */
export function expectedTypecheckTasks(root: string): string[] {
  const tasks: string[] = []
  for (const directory of workspaceDirectories(root)) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name?: string
      scripts?: Record<string, string>
    }
    if (typeof manifest.name === 'string' && manifest.scripts?.typecheck) {
      tasks.push(`${manifest.name}#typecheck`)
    }
  }
  return tasks.sort()
}

/**
 * The other half of the fix, and the half that survives a turbo upgrade.
 *
 * `--continue=always` means nothing is skipped for a sibling's failure, but "nothing was
 * skipped" is then an assumption, and this gate exists precisely because an assumption
 * about coverage went unchecked for three days. So the run is made to account for itself:
 * every task in the graph reports a result, or the gate says which ones did not and why
 * that makes the run worthless as evidence.
 *
 * A green that cannot be verified is refused; a red that cannot be verified is annotated
 * and keeps turbo's exit code. The asymmetry is deliberate — a red is already loud, and
 * the failure this guards against is a truncated run being read as an all-clear.
 */
export function accountingRefusal(
  accounting: RunAccounting | null,
  expected: string[],
  turboExitCode: number,
): string | null {
  const preamble =
    turboExitCode === 0
      ? 'typecheck refused: this run reported success for fewer projects than it had.'
      : 'typecheck: the failure above is not the whole picture.'
  if (!accounting) {
    return (
      `${preamble}\n` +
      'No readable turbo run summary was produced, so there is no evidence that every ' +
      'project ran. Re-run the gate; if the summary is still missing, the wrapper and ' +
      "turbo's --summarize output have diverged and this check needs updating (POD-3517)."
    )
  }
  const missing = accounting.attempted - accounting.reported.length
  if (missing <= 0) return null
  const seen = new Set(accounting.reported)
  const unreported = expected.filter((task) => !seen.has(task))
  const named =
    unreported.length === missing
      ? `Never ran: ${unreported.join(', ')}`
      : `The workspace declares these typecheck tasks that this run did not report: ` +
        `${unreported.join(', ') || '(none)'}. That list is a guide and not the graph — ` +
        `a --filter narrows what turbo attempts.`
  return (
    `${preamble}\n` +
    `${accounting.attempted} typecheck tasks were in the graph and ${accounting.reported.length} ` +
    `reported a result. ${missing} never ran, so this run says NOTHING about ` +
    `${missing === 1 ? 'it' : 'them'} — not that ${missing === 1 ? 'it is' : 'they are'} green.\n` +
    `${named}\n` +
    'Turbo abandons unstarted tasks when a task fails and its footer still counts them ' +
    'in the total, which is how apps/web stayed red and unnoticed (POD-3516, POD-3517).'
  )
}

export function turboEnv(root: string, census: EnvCensus): NodeJS.ProcessEnv {
  const cacheDir = process.env.TURBO_CACHE_DIR ?? sharedTurboCacheDir(root)
  const existed = existsSync(cacheDir)
  mkdirSync(cacheDir, { recursive: true })
  // Say it once, and require NOTHING of the reader. A cold cache is not a
  // decision anyone has to make — turbo computes and fills it, which is correct
  // and needs no help. The line exists only because the alternative is an agent
  // watching an unusually slow run, inferring the cache is broken, and acting on
  // it: re-running, forcing, or writing "a fresh worktree is a cold start" into a
  // brief. That inference is what cost this epic time, not the run.
  if (!existed || readdirSync(cacheDir).length === 0) {
    console.error(
      `cache at ${cacheDir} is empty — this run fills it. Nothing to do; the next run is fast.`,
    )
  }
  return {
    ...process.env,
    PODIUM_CHECK_ENV_HASH: fingerprint(census),
    TURBO_CACHE_DIR: cacheDir,
    TURBO_FORCE: undefined,
  }
}

/**
 * The summary turbo just wrote, identified by being new since the run started and by
 * naming this task. Concurrent runs in one worktree share `.turbo/runs`, so the newest
 * file is not necessarily ours; the command line pins it.
 */
function findRunSummary(directory: string, before: Set<string>): string | null {
  if (!existsSync(directory)) return null
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith('.json') && !before.has(name))
    .map((name) => join(directory, name))
    .filter((path) => {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
          execution?: { command?: unknown }
        }
        return typeof parsed.execution?.command === 'string'
          ? parsed.execution.command.includes('run typecheck')
          : false
      } catch {
        return false
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return candidates[0] ?? null
}

function summaryNames(directory: string): Set<string> {
  return new Set(existsSync(directory) ? readdirSync(directory) : [])
}

async function main() {
  const root = join(import.meta.dir, '..')
  const census = readCensus(root)
  const refusal = admissionRefusal(census, 'typecheck')
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  const decision = decideForce(
    process.argv.slice(2),
    process.env as Record<string, string | undefined>,
  )
  if (decision.error) {
    console.error(decision.error)
    process.exit(1)
  }
  if (decision.reason) console.error(`uncached run, reason: ${decision.reason}`)
  const limit = decideConcurrency(decision.forwardArgs, {
    cores: cpus().length,
    availableMb: availableMb(),
  })
  const concurrencyArgs = limit.cap === null ? [] : [`--concurrency=${limit.cap}`]
  if (limit.cap !== null) console.error(`typecheck concurrency ${limit.cap} (${limit.reason})`)
  const summarize = decideSummarize(decision.forwardArgs)
  const runsDir = join(root, '.turbo', 'runs')
  const before = summaryNames(runsDir)
  const proc = Bun.spawn(
    [
      join(root, 'node_modules', '.bin', 'turbo'),
      'run',
      'typecheck',
      ...concurrencyArgs,
      ...decideContinue(decision.forwardArgs),
      ...summarize.add,
      ...decision.forwardArgs,
    ],
    {
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: turboEnv(root, census),
    },
  )
  const exitCode = await proc.exited
  const summaryPath = findRunSummary(runsDir, before)
  const accounting = summaryPath ? readRunAccounting(readFileSync(summaryPath, 'utf8')) : null
  if (summaryPath && !summarize.callerOwnsFile) rmSync(summaryPath, { force: true })
  const coverage = accountingRefusal(accounting, expectedTypecheckTasks(root), exitCode)
  if (coverage) {
    console.error(coverage)
    process.exit(exitCode === 0 ? 1 : exitCode)
  }
  process.exit(exitCode)
}

if (import.meta.main) await main()
