// Detached spawn + ensure-up for the split headless backend. In the non-systemd persistence
// mode, setup (and a bare `podium` on a configured box) launch `podium server` + `podium daemon`
// as independent, detached processes: setsid, stdio → ~/.podium/logs/<role>.log, unref'd so the
// launcher can exit. Spawn-and-forget (no auto-restart) — see the design spec:
// docs/superpowers/specs/2026-07-06-headless-process-model-design.md
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PodiumConfig } from '@podium/core/config'
import { liveRecord, logDir, type RunRole } from '@podium/core/run-registry'

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
export function spawnDetached(sub: 'server' | 'daemon', opts: SpawnOpts = {}): number | undefined {
  mkdirSync(logDir(), { recursive: true })
  const logFile = join(logDir(), `${sub}.log`)
  const fd = openSync(logFile, 'a')
  const extra = opts.local ? ['--local'] : opts.serverUrl ? ['--server', opts.serverUrl] : []
  const { cmd, args } = selfInvocation(sub, extra)
  const env: NodeJS.ProcessEnv = { ...process.env, PODIUM_RUN_MODE: 'detached' }
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

/** Poll http://localhost:<port>/health until it answers 200 or the budget runs out. */
export async function waitForHealth(
  port: number,
  budgetMs = 15_000,
  stepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}

/** Roles that should be running for a given host mode. */
export function rolesForMode(mode: PodiumConfig['mode']): RunRole[] {
  if (mode === 'all-in-one') return ['server', 'daemon']
  if (mode === 'server') return ['server']
  if (mode === 'daemon') return ['daemon']
  return []
}

/**
 * Start the detached split for a host box: server first (wait for /health), then the daemon
 * pointed at it. `mode='server'` starts only the server. Returns whether the server came up.
 */
export async function startDetachedStack(
  mode: PodiumConfig['mode'],
  port: number,
): Promise<{ serverUp: boolean }> {
  // Joined worker: a bare `podium daemon` reads serverUrl + pairCode from config and dials the
  // REMOTE server — no local server, no `--local`.
  if (mode === 'daemon') {
    spawnDetached('daemon', {})
    return { serverUp: true }
  }
  // Host modes: the local server first, then the LOCAL daemon (`--local`) pointed at it.
  const roles = rolesForMode(mode)
  let serverUp = true
  if (roles.includes('server')) {
    spawnDetached('server', { port })
    serverUp = await waitForHealth(port)
  }
  if (roles.includes('daemon') && serverUp) {
    spawnDetached('daemon', { port, local: true })
  }
  return { serverUp }
}

/**
 * Ensure the configured backend is running (bare `podium` on a configured, detached box). Starts
 * any role that the run registry shows down. systemd-managed installs are handled by the caller
 * via systemctl; this covers the detached case. Returns the roles it (re)started.
 */
export async function ensureDetachedUp(
  config: PodiumConfig,
  port: number,
): Promise<{ started: RunRole[] }> {
  const roles = rolesForMode(config.mode)
  const down = roles.filter((r) => !liveRecord(r))
  if (down.length === 0) return { started: [] }
  // Joined worker: bare `podium daemon` (remote, config-driven) — not the local `--local` split.
  if (config.mode === 'daemon') {
    spawnDetached('daemon', {})
    return { started: down }
  }
  if (down.includes('server')) {
    spawnDetached('server', { port })
    await waitForHealth(port)
  }
  if (down.includes('daemon')) {
    spawnDetached('daemon', { port, local: true })
  }
  return { started: down }
}
