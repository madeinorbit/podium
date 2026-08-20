/**
 * WHERE A DEVELOPMENT BUILD RUNS.
 *
 * The development host is the LIVE host. A build spawned as a plain child of the
 * server inherits the server's cgroup, and the server unit carries the
 * INTERACTIVE tier (CPUWeight=900 / IOWeight=500 — POD-598) precisely because a
 * wedged coordinator is what an operator notices first. So the compile inherited
 * eighteen times the CPU weight of the agent sessions it was competing with, and
 * a ~50 s build was measurably felt across the box (POD-1966).
 *
 * Fix: launch each build in its own transient `--user` SCOPE, in the BATCH tier,
 * with a quota. A slower build is explicitly fine; a build that slows the box is
 * not.
 *
 * ---------------------------------------------------------------------------
 * AND A MEMORY BOUND, WHICH THE CPU TIER IS NOT (POD-2472)
 * ---------------------------------------------------------------------------
 *
 * The scope above bounded a build's CPU and nothing else: no `MemoryMax`, no
 * swap bound, no OOM policy, and no slice. That is the same unbounded shape
 * agent sessions had before POD-2413, on the same live host, and it fails the
 * same way — a compile that wants more than the box has does not fail, it pages
 * the box into the ground, and the kernel's OOM killer then picks its victim by
 * badness score, which on this machine is as likely to be an agent or the
 * daemon as the build.
 *
 * So a build now runs in `podium[-<instance>]-builds.slice` with the budget
 * `@podium/runtime/scope` derives for it: `MemoryMax`, `MemorySwapMax=0`,
 * `TasksMax`, `OOMPolicy=continue`, and deliberately NO `MemoryHigh` — a `High`
 * throttles rather than kills, and a wedged build holding the update lock is
 * worse than a failed one. The slice is a SIBLING of the sessions slice, not a
 * member: the reclaim policy parks agents on that slice's pressure, and a build
 * inside it would make every redeploy look like agents starving.
 *
 * What an over-budget build looks like from here, driven end to end on this host
 * against a hog under a 256 MiB cap: the kernel SIGKILLs the build, `--scope`
 * having exec'd it in place so the signal reaches the process this module waits
 * on, and the rejection names the cap ({@link describeBuildExit}). The update
 * path reports a build failure, which is what an operator can act on.
 *
 * ---------------------------------------------------------------------------
 * SCOPE, NOT SERVICE — measured on ludovico (systemd 255), 2026-08-13
 * ---------------------------------------------------------------------------
 *
 * A transient service (`systemd-run --unit=x.service`) and a transient scope
 * (`--scope`) both create a SIBLING cgroup of the caller's unit, so either one
 * takes the build out of `podium-server.service`. The deciding question was what
 * happens to an in-flight build when the server restarts — which happens on
 * every move of main here, because redeploy watches git HEAD.
 *
 * Measured, by running a scope from inside a throwaway service and restarting
 * that service: the scoped process SURVIVES, reparented to the user manager,
 * with its scope still `active`. A transient service survives too. So survival
 * does not separate them — but survival is a HAZARD for a build rather than the
 * feature it is for an agent session (see the reclaim below), and on everything
 * else the scope wins: `--scope` execs the command in place, so the build stays
 * a real child of the server. Measured: exit status propagates verbatim (`sh -c
 * 'exit 7'` → 7) and stdout is inherited, which keeps build output in the
 * server's journal where operators already look for it. A transient service
 * needs `--wait` to report status at all and sends its output somewhere else.
 *
 * THE RECLAIM. Because the orphan survives, the next server would otherwise
 * build concurrently with it — and two `bun scripts/build-bun.ts` runs share
 * `dist-bun/podium` and `dist-bun/headless/`, so one build's tarball could carry
 * the other's binary. That is exactly the lie the dev+<sha> identity checks
 * exist to prevent. The unit name is therefore DETERMINISTIC and every launch
 * stops it first: a live orphan dies before the new build starts, and the name
 * doubles as a mutex two servers can both see. (`packages/pty/src/abduco.ts`
 * reclaims the same way and for the same "unit already exists" reason —
 * measured here: a second `systemd-run` at a live name exits 1, and `stop` +
 * `reset-failed` frees it.)
 *
 * IOWEIGHT IS INERT ON THIS HOST, and honestly so. `systemctl --user show`
 * reports `IOWeight=50`, but the user manager is delegated `cpu memory pids`
 * only (`systemctl show user@1000.service -p DelegateControllers`), so no
 * `io.weight` file is created for any `--user` unit — including today's
 * `podium-server.service` with IOWeight=500. It is set anyway: it costs nothing,
 * it states the intent, and it starts working the day `io` is delegated.
 * `CPUWeight` and `CPUQuota` DO take effect — verified in the live scope's
 * `cpu.weight` (50) and `cpu.max` (200000 100000).
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createLogger } from '@podium/logger'
import { instanceBuildSliceName } from '@podium/runtime/instance'
import {
  buildsSliceBudgetArgv,
  resolveBuildBudget,
  resolveBuildsSliceBudget,
  type ScopeBudget,
  type ScopeBudgetEnv,
  scopeBudgetProperties,
} from '@podium/runtime/scope'

const log = createLogger('server:updates')

/** The batch tier, matching a per-agent scope (`packages/pty/src/abduco.ts`). */
export const DEV_BUILD_CPU_WEIGHT = 50
export const DEV_BUILD_IO_WEIGHT = 50
/**
 * Two cores' worth. The host has 8, so a build can never take more than a
 * quarter of the machine no matter how idle CPUWeight says it may go. The
 * single-threaded `tar` step is unaffected by this; the parallel `bun build
 * --compile` is, deliberately.
 */
export const DEV_BUILD_CPU_QUOTA = '200%'

/** Transient unit names, instance-scoped like every other Podium unit. */
export function devBuildScopeUnit(role: string, instanceId: string): string {
  return instanceId === 'default' ? `podium-${role}.scope` : `podium-${instanceId}-${role}.scope`
}

/**
 * argv for `systemd-run` that runs `command` in its own batch-tier, budgeted
 * scope inside the instance's builds slice.
 *
 * Properties must precede the `--` separator or systemd-run reads them as
 * arguments to the command — which is why the budget is spliced in HERE and not
 * appended by a caller.
 *
 * WHY THIS IS NOT `systemdScopeArgv` (`packages/pty/src/abduco.ts`), which
 * assembles the same kind of argv for a session scope. POD-2413's reviewer
 * would rather one builder existed, and that is a fair thing to want. What the
 * two share is four constant flags; what they do not share is every line that
 * carries policy — a session takes CPUWeight=50/IOWeight=100 and no quota, a
 * build takes IOWeight=50 under a hard `CPUQuota` and a description, and the
 * budgets come from different resolvers. Unifying them means a builder
 * parameterised on each of those axes, which is one function answering two
 * questions and the shape that lets a session's policy change quietly alter a
 * build's. The BUDGET is shared, in `@podium/runtime/scope`, because that is
 * the part where drift would actually hurt.
 */
export function devBuildScopeArgv(
  unit: string,
  command: readonly string[],
  opts: { description?: string; slice?: string; budget?: ScopeBudget } = {},
): string[] {
  return [
    '--user',
    '--scope',
    '--collect',
    '--quiet',
    `--slice=${opts.slice ?? instanceBuildSliceName()}`,
    `--unit=${unit}`,
    ...(opts.description ? [`--description=${opts.description}`] : []),
    `--property=CPUWeight=${DEV_BUILD_CPU_WEIGHT}`,
    `--property=IOWeight=${DEV_BUILD_IO_WEIGHT}`,
    `--property=CPUQuota=${DEV_BUILD_CPU_QUOTA}`,
    ...scopeBudgetProperties(opts.budget ?? resolveBuildBudget()),
    '--',
    ...command,
  ]
}

/** `systemctl --user` argv pairs that free the name, live orphan included. */
export function devBuildScopeReclaimArgvs(unit: string): string[][] {
  return [
    ['--user', 'stop', unit],
    ['--user', 'reset-failed', unit],
  ]
}

/**
 * The user manager's runtime dir — `systemd-run --user` finds its bus through
 * `XDG_RUNTIME_DIR`, which a system service with `User=` never gets. Same
 * fallback, and the same reason, as `packages/pty/src/abduco.ts`.
 */
export function userRuntimeDir(): string | undefined {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return undefined
  const dir = `/run/user/${process.getuid()}`
  return existsSync(dir) ? dir : undefined
}

function scopeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dir = userRuntimeDir()
  return dir ? { ...base, XDG_RUNTIME_DIR: dir } : base
}

let scopeProbe: boolean | undefined

/**
 * Whether a build can be scoped at all: Linux, a reachable `--user` manager, and
 * a systemd-run that actually accepts a transient scope. The probe CREATES a
 * throwaway scope rather than reading `systemd-run --version`, because a present
 * binary with a dead user manager (a container, an unlingered account) must read
 * as NO here — otherwise every build takes the failure path instead of the
 * fallback. Memoized: the answer cannot change within a process.
 */
export function canScopeDevBuild(): boolean {
  if (scopeProbe !== undefined) return scopeProbe
  scopeProbe =
    !process.env.PODIUM_NO_SCOPE &&
    process.platform === 'linux' &&
    userRuntimeDir() !== undefined &&
    spawnSync('systemd-run', ['--user', '--scope', '--collect', '--quiet', '--', 'true'], {
      stdio: 'ignore',
      timeout: 8000,
      env: scopeEnv(process.env),
    }).status === 0
  return scopeProbe
}

/** Test seam: forget the memoized probe. */
export function resetDevBuildScopeProbe(): void {
  scopeProbe = undefined
}

export interface LowTierBuild {
  /** Deterministic transient unit name; reclaimed before launch. */
  unit: string
  /**
   * The instance's builds slice. Carried beside the unit rather than derived
   * here, because the unit name is already instance-derived at the call site
   * and a slice resolved separately could name a DIFFERENT instance — which
   * would put one instance's build under another's aggregate cap. Defaults to
   * this process's instance for callers that have no instance in hand.
   */
  slice?: string
  description?: string
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * Which bun the scoped build must exec.
 *
 * `systemd-run --user --scope` does not inherit the server's PATH. A bare
 * `bun` then fails with "Failed to find executable bun" — measured on the
 * source host after dest+HEAD restarted (POD-962). BUN_BIN wins; otherwise the
 * server's own executable, when it is bun; otherwise the name `bun` for the
 * unscopeable fallback (macOS, a container) where the parent PATH still works.
 */
export function devBuildCommand(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string {
  const configured = env.BUN_BIN?.trim()
  if (configured) return configured
  if (/(?:^|[/\\])bun(?:\.exe)?$/i.test(execPath)) return execPath
  return 'bun'
}

/**
 * What actually gets spawned. Pure, so the fallback is a table rather than a
 * branch nobody can see: without systemd we run the command exactly as before.
 */
export function lowTierSpawnPlan(
  build: LowTierBuild,
  scoped: boolean,
): { file: string; args: string[] } {
  if (!scoped) return { file: build.command, args: [...build.args] }
  return {
    file: 'systemd-run',
    args: devBuildScopeArgv(build.unit, [build.command, ...build.args], {
      ...(build.description ? { description: build.description } : {}),
      ...(build.slice ? { slice: build.slice } : {}),
      // The BUILD's env, not the process's: it is the env the build actually
      // runs with, so the cap the scope carries is the cap the failure message
      // later names.
      budget: resolveBuildBudget(build.env),
    }),
  }
}

/**
 * What to say when a build does not finish.
 *
 * THE KILL ARRIVES AS A SIGNAL, NOT AS A CODE — measured by driving this path
 * against a hog under a 256 MiB cap. `systemd-run --scope` execs the build in
 * place, so the process this module waits on IS the build: the kernel's SIGKILL
 * reaches it directly and node reports `code: null, signal: 'SIGKILL'`. A shell
 * would have shown 137 and the old message said "exited with status unknown",
 * which names neither the kill nor the cap — the operator's two facts. (137 is
 * still accepted here: a build the fallback path runs through a wrapper reports
 * it that way.)
 *
 * BOTH CAPS, BECAUSE ONLY THE KERNEL KNOWS WHICH ONE BOUND. Two limits can end
 * a build: its own scope's `MemoryMax` and the builds slice's aggregate. When
 * the SLICE cap is the binding one the kernel still attributes the kill to the
 * scope unit, so an earlier version of this message named the per-scope cap and
 * prescribed `PODIUM_BUILD_MEMORY_MAX` — a number the build never reached and a
 * knob that could not help. Reproduced by POD-2472's reviewer with two
 * concurrent builds under a tight slice cap: the victim died at a 378 MiB peak
 * and was told to raise a 500 MiB scope limit. An 8 GiB host hides it, because
 * there the two caps are the same number.
 *
 * So the message states every bound that is set and points at the peak, which
 * is the fact that separates them. Naming both is deliberate over guessing one:
 * `--collect` removes the scope the moment its last process exits, so its
 * `memory.peak` is gone before this line runs, and a guess that reads "no OOM
 * here" because the cgroup already vanished is worse than an honest pair.
 * systemd's own journal line for the unit records both the OOM kill and the
 * peak, and it is already where operators look.
 */
export function describeBuildExit(
  command: string,
  exit: { status: number | null; signal?: NodeJS.Signals | null },
  budget: ScopeBudget,
  sliceBudget: ScopeBudget = {},
): string {
  const base = exit.signal
    ? `${command} was killed by ${exit.signal}`
    : `${command} exited with status ${exit.status ?? 'unknown'}`
  const killed = exit.signal === 'SIGKILL' || exit.status === 137
  if (!killed) return base

  const bounds: string[] = []
  if (budget.memoryMaxBytes !== undefined) {
    bounds.push(`this build at ${formatCap(budget.memoryMaxBytes)} (PODIUM_BUILD_MEMORY_MAX)`)
  }
  if (sliceBudget.memoryMaxBytes !== undefined) {
    bounds.push(
      `all concurrent builds at ${formatCap(sliceBudget.memoryMaxBytes)} (PODIUM_BUILDS_MEMORY_MAX)`,
    )
  }
  if (bounds.length === 0) return base
  const swapOff = budget.memorySwapMaxBytes === 0 || sliceBudget.memorySwapMaxBytes === 0
  return (
    `${base} — memory is capped: ${bounds.join(', ')}${swapOff ? ', and swap is disabled' : ''}. ` +
    "The unit's journal line records the peak, which says which bound it hit."
  )
}

/** MiB below a GiB: an operator who set `256M` reads their own number back. */
function formatCap(bytes: number): string {
  return bytes < 1024 ** 3
    ? `${Math.round(bytes / 1024 ** 2)} MiB`
    : `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

function runQuietly(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'ignore', env })
    child.once('error', () => resolve())
    child.once('close', () => resolve())
  })
}

/**
 * Run one build step in the batch tier, or plainly where systemd cannot.
 *
 * Rejects with the command's own failure. A non-zero exit is treated as the
 * BUILD failing, never as the scope failing: the probe above already answered
 * whether scoping works, and the reclaim removes the one remaining way
 * `systemd-run` itself could refuse ("unit already exists"). Re-running a build
 * on the suspicion that systemd was at fault would double the cost of every
 * genuine compile error.
 */
export async function runLowTierBuild(build: LowTierBuild): Promise<void> {
  const scoped = canScopeDevBuild()
  const env = scoped ? scopeEnv(build.env) : build.env
  const budget = scoped ? resolveBuildBudget(build.env) : {}
  const sliceBudget = scoped ? resolveBuildsSliceBudget(build.env) : {}
  if (scoped) {
    await applyBuildsSliceBudget(build.slice ?? instanceBuildSliceName(), build.env, env)
    for (const args of devBuildScopeReclaimArgvs(build.unit)) {
      await runQuietly('systemctl', args, env)
    }
  } else if (process.platform === 'linux' && !process.env.PODIUM_NO_SCOPE) {
    log.warn("no systemd user manager reachable; this build runs UNBOUNDED at the server's tier", {
      unit: build.unit,
    })
  }
  const plan = lowTierSpawnPlan(build, scoped)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.file, plan.args, { cwd: build.cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (status, signal) => {
      if (status === 0) resolve()
      else {
        reject(new Error(describeBuildExit(build.command, { status, signal }, budget, sliceBudget)))
      }
    })
  })
}

/**
 * Put the aggregate cap on the instance's builds slice, best-effort.
 *
 * Once per build rather than once at boot, and idempotent: the slice is
 * transient, so it is GC'd whenever no build is live and takes its runtime
 * properties with it. Setting it here means the cap is in force for the build
 * about to start — verified on this host that `set-property --runtime` applies
 * to a slice with no members yet and survives into the first scope launched
 * into it. A failure is not fatal: every build scope still carries its own
 * `MemoryMax`, so losing the aggregate loses the bound on CONCURRENT builds,
 * not the bound.
 *
 * BUT IT IS SAID OUT LOUD. `runQuietly` (right for the reclaim calls beside it,
 * where "no such unit" is the normal answer) resolves on a non-zero exit too,
 * which left a refused `set-property` with no trace anywhere — the operator
 * would learn that concurrent builds were unbounded only from the outage. The
 * degraded state is worth one warn line.
 */
async function applyBuildsSliceBudget(
  slice: string,
  buildEnv: ScopeBudgetEnv,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const argv = buildsSliceBudgetArgv(slice, resolveBuildsSliceBudget(buildEnv))
  const status = await runReporting('systemctl', argv, env)
  if (status === 0) return
  log.warn('could not bound the builds slice; concurrent builds are capped only per build', {
    slice,
    status,
  })
}

/** Like {@link runQuietly}, but the caller is told how it went. */
function runReporting(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'ignore', env })
    child.once('error', () => resolve(null))
    child.once('close', (status) => resolve(status))
  })
}
