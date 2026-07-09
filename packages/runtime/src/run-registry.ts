// Per-machine run registry: one pidfile per long-lived Podium component, under
// <stateDir>/run/<role>.pid. It lets any launcher (the CLI, a detached spawn, the desktop
// sidecar) answer "is this component already running?", reclaim a stale/orphaned holder before
// binding, and drive `podium status` / `podium stop`. Keyed by ROLE, not port, so the desktop's
// free-port-per-launch strategy still reclaims correctly.
//
// Design: docs/internal/superpowers/specs/2026-07-06-headless-process-model-design.md
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { stateDir } from './config'

export const RunRole = z.enum(['server', 'daemon', 'all-in-one'])
export type RunRole = z.infer<typeof RunRole>

export const RunRecord = z.object({
  role: RunRole,
  pid: z.number().int().positive(),
  port: z.number().int().positive().optional(),
  /** How this process was launched — for `status` reporting + `stop` routing. */
  mode: z.enum(['systemd', 'detached', 'foreground']).optional(),
  /** ISO timestamp; also guards against PID reuse when compared to the OS process start. */
  startedAt: z.string(),
})
export type RunRecord = z.infer<typeof RunRecord>

/** <stateDir>/run — home for the pidfiles. */
export function runDir(): string {
  return join(stateDir(), 'run')
}

/** <stateDir>/logs — home for detached component stdout/stderr. */
export function logDir(): string {
  return join(stateDir(), 'logs')
}

export function recordPath(role: RunRole): string {
  return join(runDir(), `${role}.pid`)
}

/** Read + validate a role's pidfile; missing or corrupt → undefined (never throws). */
export function readRecord(role: RunRole): RunRecord | undefined {
  const path = recordPath(role)
  if (!existsSync(path)) return undefined
  try {
    return RunRecord.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

export function writeRecord(rec: RunRecord): void {
  const parsed = RunRecord.parse(rec)
  mkdirSync(runDir(), { recursive: true })
  writeFileSync(recordPath(parsed.role), `${JSON.stringify(parsed, null, 2)}\n`)
}

export function removeRecord(role: RunRole): void {
  rmSync(recordPath(role), { force: true })
}

/** Signal function shape (injectable for tests): mirrors `process.kill`. */
export type KillFn = (pid: number, signal?: number | string) => void

/**
 * Is `pid` a live process? `kill(pid, 0)` throws ESRCH when the PID is dead and EPERM when it
 * exists but isn't ours — EPERM still means alive. Any other error → treat as not-alive.
 */
export function isAlive(pid: number, kill: KillFn = process.kill): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** The role's record iff its PID is currently alive; else undefined. */
export function liveRecord(role: RunRole, kill: KillFn = process.kill): RunRecord | undefined {
  const rec = readRecord(role)
  return rec && isAlive(rec.pid, kill) ? rec : undefined
}

/** Every role with a live process, for `podium status`. */
export function listLive(kill: KillFn = process.kill): RunRecord[] {
  return RunRole.options.map((r) => liveRecord(r, kill)).filter((r): r is RunRecord => Boolean(r))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface ReclaimResult {
  /** True if a live holder was found and terminated. */
  reclaimed: boolean
  /** The PID that was terminated, when reclaimed. */
  pid?: number
}

export interface ReclaimOptions {
  /** Total time to wait for a graceful SIGTERM before escalating to SIGKILL. */
  graceMs?: number
  pollMs?: number
  kill?: KillFn
  sleepFn?: (ms: number) => Promise<void>
}

/**
 * Reclaim a role before (re)binding it: if a live process holds the pidfile, SIGTERM it, wait up
 * to `graceMs` for it to die, then SIGKILL. Removes the pidfile on success. No live holder →
 * `{reclaimed:false}` (a stale pidfile is left for the caller's own writeRecord to overwrite).
 *
 * Throws if the holder is alive but unkillable (EPERM) — the caller must NOT proceed to bind, to
 * avoid a double-run.
 */
export async function reclaim(role: RunRole, opts: ReclaimOptions = {}): Promise<ReclaimResult> {
  const { graceMs = 3000, pollMs = 100, kill = process.kill, sleepFn = sleep } = opts
  const rec = liveRecord(role, kill)
  if (!rec) return { reclaimed: false }

  const signal = (sig: number | string): void => {
    try {
      kill(rec.pid, sig)
    } catch (err) {
      // ESRCH => already gone (fine). EPERM => we can't kill it; refuse to double-run.
      if ((err as NodeJS.ErrnoException)?.code === 'EPERM') {
        throw new Error(
          `run-registry: a live ${role} (pid ${rec.pid}) is not killable from this user — refusing to start a second one. Stop it manually, then retry.`,
        )
      }
    }
  }

  signal('SIGTERM')
  const deadline = Math.max(1, Math.ceil(graceMs / pollMs))
  for (let i = 0; i < deadline; i++) {
    if (!isAlive(rec.pid, kill)) break
    await sleepFn(pollMs)
  }
  if (isAlive(rec.pid, kill)) signal('SIGKILL')
  removeRecord(role)
  return { reclaimed: true, pid: rec.pid }
}

export interface RegisterOptions {
  port?: number
  mode?: RunRecord['mode']
  kill?: KillFn
  /** Injectable clock (ISO string) for tests. */
  nowIso?: () => string
}

/**
 * Claim a role for THIS process: reclaim any stale/live holder, write our pidfile, and install
 * cleanup so the pidfile is removed on exit. Returns a cleanup fn (idempotent) the caller may also
 * invoke explicitly. Call this once, at component boot, before binding the port.
 */
export async function registerProcess(
  role: RunRole,
  opts: RegisterOptions = {},
): Promise<() => void> {
  const { port, mode, kill = process.kill, nowIso = () => new Date().toISOString() } = opts
  await reclaim(role, { kill })
  writeRecord({
    role,
    pid: process.pid,
    startedAt: nowIso(),
    ...(port ? { port } : {}),
    ...(mode ? { mode } : {}),
  })

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    // Only remove the pidfile if it still describes US (avoid clobbering a successor that
    // reclaimed us and wrote its own).
    const cur = readRecord(role)
    if (cur?.pid === process.pid) removeRecord(role)
  }
  process.once('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, cleanup)
  return cleanup
}
