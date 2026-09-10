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
import {
  defaultInstanceGuardIo,
  type InstanceGuardIo,
  selfIdentityTriple,
  writerLiveness,
} from './instance-guard'

export const RunRole = z.enum(['parent', 'server', 'janitor', 'daemon', 'all-in-one'])
export type RunRole = z.infer<typeof RunRole>

export const RunRecord = z.object({
  role: RunRole,
  pid: z.number().int().positive(),
  port: z.number().int().positive().optional(),
  /** How this process was launched — for `status` reporting + `stop` routing. */
  mode: z.enum(['systemd', 'detached', 'foreground']).optional(),
  /** ISO timestamp; human-facing uptime in `podium status`. */
  startedAt: z.string(),
  /**
   * The two companions that pin `pid` to ONE incarnation (POD-3837). Stamped
   * only when a process is recording its OWN pid, because neither can be
   * observed for another process without guessing.
   *
   * `bootId` is `/proc/sys/kernel/random/boot_id`; `procStartTime` is
   * `/proc/<pid>/stat` field 22. Both are Linux `/proc` facts, so both are
   * optional, and absent means "this host could not tell us" rather than "they
   * disagreed" — see {@link liveRecord}.
   */
  bootId: z.string().optional(),
  procStartTime: z.string().optional(),
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

/**
 * Read + validate a role's pidfile; missing or corrupt → undefined (never throws).
 *
 * UNFENCED: the PID it names may be dead, so this does NOT answer "is a process of
 * this role running" — {@link liveRecord} does.
 *
 * MODULE-PRIVATE ON PURPOSE (POD-3838). Two callers legitimately want the raw record:
 * {@link liveRecord}, which applies the fence itself, and `registerProcess`'s exit
 * cleanup, which must compare the record's PID to our own whether or not that PID is
 * still alive. Everyone outside wants the fenced reader, and offering both under the
 * more natural name is exactly how the sibling connectivity module shipped a stale
 * status (POD-3826). Tests asserting what was WRITTEN use {@link readRecordForTest}.
 */
function readRecord(role: RunRole): RunRecord | undefined {
  const path = recordPath(role)
  if (!existsSync(path)) return undefined
  try {
    return RunRecord.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * The raw, UNFENCED record — for tests that assert what {@link writeRecord} put on disk,
 * which is a question the fence would answer wrongly. Production code wants
 * {@link liveRecord}; see {@link readRecord} for why the raw reader is not exported under
 * its own name.
 */
export const readRecordForTest = readRecord

export function writeRecord(rec: RunRecord): void {
  const parsed = RunRecord.parse(rec)
  // A SELF-attestation, stamped here rather than at each caller so no writer can
  // forget it. Recording our boot id against someone else's pid would
  // manufacture exactly the false agreement the triple exists to detect.
  const identity = parsed.pid === process.pid ? selfIdentityTriple() : undefined
  const written: RunRecord = {
    ...parsed,
    ...(identity?.bootId ? { bootId: identity.bootId } : {}),
    ...(identity?.startTime ? { procStartTime: identity.startTime } : {}),
  }
  mkdirSync(runDir(), { recursive: true })
  writeFileSync(recordPath(written.role), `${JSON.stringify(written, null, 2)}\n`)
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

/**
 * The role's record iff the process that WROTE it is still running; else undefined.
 *
 * THE PIDFILE OUTLIVES THE BOOT (POD-3837). It lives in the state root
 * (`~/.podium/run`), not in a runtime tree the kernel empties, so a record
 * survives a reboot — and after one, every pid it names is being reused by
 * something unrelated. A bare `kill(pid, 0)` therefore reads EVERY stale record
 * as live, and {@link reclaim} then SIGTERMs and SIGKILLs the stranger holding
 * that pid. So the fence compares the identity triple `instance-guard.ts`
 * argues for, not just the name.
 *
 * SUPPRESSION IS ONLY EVER ON PROOF, the rule POD-3815 set for the sibling
 * connectivity fence: a record with no `bootId` (written before the stamp
 * existed), or one read on a host with no `/proc`, still reads as live. "We
 * cannot tell" must not become "this is stale" — that would strand every
 * non-Linux host and make a component refuse to find its own running self.
 *
 * `io` overrides the `/proc` probes; production passes none. `kill` stays the
 * pid probe so the many existing callers that inject it are unaffected.
 */
export function liveRecord(
  role: RunRole,
  kill: KillFn = process.kill,
  io: Partial<InstanceGuardIo> = {},
): RunRecord | undefined {
  const rec = readRecord(role)
  if (!rec) return undefined
  const { live } = writerLiveness(
    { pid: rec.pid, bootId: rec.bootId, startTime: rec.procStartTime },
    { ...defaultInstanceGuardIo, pidAlive: (pid) => isAlive(pid, kill), ...io },
  )
  return live ? rec : undefined
}

/** Every role with a live process, for `podium status`. */
export function listLive(
  kill: KillFn = process.kill,
  io: Partial<InstanceGuardIo> = {},
): RunRecord[] {
  return RunRole.options
    .map((r) => liveRecord(r, kill, io))
    .filter((r): r is RunRecord => Boolean(r))
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
  /** Overrides the `/proc` identity probes {@link liveRecord} fences with. */
  io?: Partial<InstanceGuardIo>
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
  const { graceMs = 3000, pollMs = 100, kill = process.kill, sleepFn = sleep, io = {} } = opts
  // Fenced by IDENTITY, not by pid: everything below this line sends signals, so
  // a record from a previous boot must never get past here (POD-3837). Once it
  // has, the pid names the process we just proved is ours to stop, and the wait
  // below is a within-boot "is it gone yet" — the bare check, correctly.
  const rec = liveRecord(role, kill, io)
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
  /**
   * Reclaim (SIGTERM, then SIGKILL) a live holder before claiming the role.
   * Default true — the normal "there can be only one" semantics.
   *
   * FALSE FOR EXACTLY ONE CALLER: a successor parent during self-handover
   * (POD-2505). Its predecessor is alive ON PURPOSE, still supervising a serving
   * stack, and owns the decision about when to exit. Reclaiming it would SIGTERM
   * it mid-handover, and its shutdown would take the children down with it — the
   * precise failure this flag exists to make impossible.
   */
  reclaimExisting?: boolean
}

/**
 * Claim a role for THIS process: reclaim any stale/live holder, write our pidfile, and install
 * cleanup so the pidfile is removed on actual process exit. Returns a cleanup fn (idempotent) the
 * caller may also invoke explicitly. Call this once, at component boot, before binding the port.
 *
 * A delivered signal is not an exit: components can install asynchronous signal handlers and stay
 * alive while they drain children. Removing the record on signal delivery makes a still-running
 * supervisor undiscoverable during that interval, so signal handlers must never unregister it.
 */
export async function registerProcess(
  role: RunRole,
  opts: RegisterOptions = {},
): Promise<() => void> {
  const {
    port,
    mode,
    kill = process.kill,
    nowIso = () => new Date().toISOString(),
    reclaimExisting = true,
  } = opts
  if (reclaimExisting) await reclaim(role, { kill })
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
  return cleanup
}
