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
 * argv for `systemd-run` that runs `command` in its own batch-tier scope.
 * Properties must precede the `--` separator or systemd-run reads them as
 * arguments to the command.
 */
export function devBuildScopeArgv(
  unit: string,
  command: readonly string[],
  opts: { description?: string } = {},
): string[] {
  return [
    '--user',
    '--scope',
    '--collect',
    '--quiet',
    `--unit=${unit}`,
    ...(opts.description ? [`--description=${opts.description}`] : []),
    `--property=CPUWeight=${DEV_BUILD_CPU_WEIGHT}`,
    `--property=IOWeight=${DEV_BUILD_IO_WEIGHT}`,
    `--property=CPUQuota=${DEV_BUILD_CPU_QUOTA}`,
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
    }),
  }
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
  if (scoped) {
    for (const args of devBuildScopeReclaimArgvs(build.unit)) {
      await runQuietly('systemctl', args, env)
    }
  } else if (process.platform === 'linux' && !process.env.PODIUM_NO_SCOPE) {
    log.warn("no systemd user manager reachable; this build runs at the server's CPU tier", {
      unit: build.unit,
    })
  }
  const plan = lowTierSpawnPlan(build, scoped)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.file, plan.args, { cwd: build.cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (status) => {
      if (status === 0) resolve()
      else reject(new Error(`${build.command} exited with status ${status ?? 'unknown'}`))
    })
  })
}
