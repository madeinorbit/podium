// Detached spawn + ensure-up for the split headless backend. Under the parent
// model [POD-2505] a host box starts one detached `parent` which supervises
// server (+ janitor worker) and optional daemon. Daemon-only joins still spawn
// a bare daemon. See docs/internal/superpowers/specs/2026-08-20-updater-convergence-spec.md
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localServerUrl, type PodiumConfig } from '@podium/runtime/config'
import { liveRecord, logDir, type RunRole } from '@podium/runtime/run-registry'
import { unsupervisedEnv } from '@podium/runtime/supervisor'
import { rolesForMode } from '@podium/runtime/transfer-lifecycle'

/** True when running inside a `bun build --compile` binary (execPath IS `podium`). */
const COMPILED = import.meta.url.includes('/$bunfs/')

/**
 * How to re-invoke THIS binary in a single-component mode. Compiled: `podium <sub>`. From source:
 * `bun --conditions=@podium/source scripts/cli.ts <sub>` so workspace packages resolve.
 */
export function selfInvocation(sub: string, extra: string[] = []): { cmd: string; args: string[] } {
  if (COMPILED) return { cmd: process.execPath, args: [sub, ...extra] }
  // The runnable entry is scripts/cli.ts (the composition root that injects the
  // in-process host modules); this file lives in apps/cli/src.
  const cliPath = fileURLToPath(new URL('../../../scripts/cli.ts', import.meta.url))
  return { cmd: process.execPath, args: ['--conditions=@podium/source', cliPath, sub, ...extra] }
}

export interface SpawnOpts {
  port?: number
  /** Daemon on a host box → `--local` (auth as the local machine, dial the local server). */
  local?: boolean
  /** For a remote/join daemon: an explicit server URL to dial. */
  serverUrl?: string
}

/** Spawn one component detached, logging to ~/.podium/logs/<role>.log. Returns its PID. */
export function spawnDetached(
  sub: 'parent' | 'server' | 'janitor' | 'daemon',
  opts: SpawnOpts = {},
): number | undefined {
  mkdirSync(logDir(), { recursive: true })
  const logFile = join(logDir(), `${sub}.log`)
  const fd = openSync(logFile, 'a')
  // `--takeover`: these spawns are deliberate management actions (setup's detached start,
  // ensureDetachedUp on roles the registry shows down) — keep the pre-#18 reclaim
  // semantics for a stale-but-alive holder instead of failing the managed start.
  const extra = [
    ...(opts.local ? ['--local'] : opts.serverUrl ? ['--server', opts.serverUrl] : []),
    '--takeover',
  ]
  const { cmd, args } = selfInvocation(sub, extra)
  // `unsupervisedEnv`: this spawn is detached ON PURPOSE — it must outlive the launcher, so it
  // must not inherit the launcher's supervisor pid and take itself down with a desktop shell
  // that has nothing to do with it (POD-1228).
  const env: NodeJS.ProcessEnv = { ...unsupervisedEnv(process.env), PODIUM_RUN_MODE: 'detached' }
  // Not under systemd — make sure a stray NOTIFY_SOCKET (inherited from a parent unit) doesn't
  // mislabel the run mode or try to talk to a watchdog that isn't there.
  delete env.NOTIFY_SOCKET
  // The local split daemon resolves its server URL from PODIUM_PORT (ws://localhost:<port>), so
  // both components must carry it.
  if (opts.port) env.PODIUM_PORT = String(opts.port)
  const child: ChildProcess = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env,
  })
  child.unref()
  return child.pid ?? undefined
}

/** Poll the local server's <host>:<port>/health until it answers 200 or the budget runs out. */
export async function waitForHealth(
  port: number,
  budgetMs = 15_000,
  stepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${localServerUrl(port)}/health`)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}

// Roles that should be running for a given host mode.
export { rolesForMode } from '@podium/runtime/transfer-lifecycle'

/**
 * Start the detached parent-supervised stack. Daemon-only joins also go through
 * the parent (daemon-only role config); the parent replaces the run-registry trio.
 */
export async function startDetachedStack(
  mode: PodiumConfig['mode'],
  port: number,
): Promise<{ serverUp: boolean }> {
  if (mode === 'client') return { serverUp: false }
  spawnDetached('parent', { port })
  if (mode === 'daemon') return { serverUp: true }
  return { serverUp: await waitForHealth(port) }
}

/**
 * Ensure the configured backend is running (bare `podium` on a configured, detached box).
 * Every managed mode starts/restarts the parent when it is down; the parent owns children.
 */
export async function ensureDetachedUp(
  config: PodiumConfig,
  port: number,
): Promise<{ started: RunRole[] }> {
  if (config.mode === 'client') return { started: [] }
  if (liveRecord('parent')) return { started: [] }
  spawnDetached('parent', { port })
  if (config.mode !== 'daemon') await waitForHealth(port)
  return { started: ['parent'] }
}

