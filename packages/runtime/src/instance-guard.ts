/**
 * WHO IS LIVE ON THIS IDENTITY RIGHT NOW (POD-2691).
 *
 * The state-root marker in `instance.ts` says which instance a directory
 * BELONGS to. That is a durable fact and it survives everything — including
 * being copied. Two questions it cannot answer are the ones that keep a reaper
 * honest:
 *
 *   1. Is a second daemon already running on this state root? (Two daemons on
 *      one root both believe they own every job the root records.)
 *   2. Is a second daemon already running on this INSTANCE UUID? (Which can
 *      only mean the root was copied — `rsync`ed to another host, restored
 *      beside the original, baked into an image — so two live daemons stamp
 *      their processes with the same owner id and each reads the other's
 *      strays as its own. That is a wrongful-kill bug, not a leak, and it is
 *      the one failure mode of UUID attribution.)
 *
 * WHY NOT flock. The design says flock, and flock would be the right primitive
 * — the kernel drops it when the holder dies, so "held" means "owner is live"
 * with no inference at all. Neither node nor bun exposes flock(2), and the only
 * ways to reach it are a native addon or holding a `flock(1)` child for the
 * daemon's whole life. Both cost more than they are worth here, so this module
 * reconstructs the same signal from a HOLDER RECORD plus the identity triple
 * the design already specifies for phase 2: pid, boot id, and the process's
 * start time.
 *
 * THE TRIPLE IS THE WHOLE POINT, because the obvious version of this file — a
 * pid file, and `kill(pid, 0)` to test it — is wrong in exactly the two states
 * that matter most. After a REBOOT every pid in every stale record is being
 * reused by something else, so a pid file left by the pre-reboot daemon reads
 * as held, forever, and the daemon never starts again. After a pid RECYCLE the
 * same thing happens transiently, and the holder we would refuse to displace is
 * some unrelated process. Comparing the boot id catches the first; comparing
 * `/proc/<pid>/stat`'s start time catches the second. A record only reads as
 * held when all three still agree.
 *
 * WHERE THE TRIPLE IS UNAVAILABLE (macOS, or any host without `/proc`) this
 * degrades to the bare pid check and SAYS SO on the handle, rather than
 * pretending to a precision it does not have. That is the honest reading until
 * phase 7 measures the darwin equivalents; a caller that must not act on a
 * guess can read `identityVerified` and decline.
 *
 * The daemon consumes these guards at startup and the session teardown path
 * consumes the resulting UUID to attribute process-table cleanup. The guard
 * remains a small primitive so those lifecycle decisions stay explicit at
 * their call sites.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type InstanceEnv,
  instanceStateDir,
  resolveInstanceId,
  validateInstanceUuid,
} from './instance'

/**
 * The identity triple. `pid` alone is a name that gets reused; the other two
 * pin it to one incarnation on one boot.
 *
 * Both companions are optional because both are Linux `/proc` facts. Absent
 * means "this host cannot tell me", which is different from "they did not
 * match" and is treated differently below.
 */
export interface ProcessIdentityTriple {
  pid: number
  /** `/proc/sys/kernel/random/boot_id` — changes on every boot. */
  bootId?: string | undefined
  /** `/proc/<pid>/stat` field 22, in clock ticks since boot. */
  startTime?: string | undefined
}

/** What a guard file contains. JSON, so an operator can read it. */
export interface InstanceGuardHolder extends ProcessIdentityTriple {
  instanceUuid: string
  /** The state root this holder is serving — the copied-root discriminator. */
  stateDir: string
  acquiredAtMs: number
}

/** Effects, injected so tests can stage a holder without staging a process. */
export interface InstanceGuardIo {
  pidAlive(pid: number): boolean
  bootId(): string | undefined
  startTime(pid: number): string | undefined
  now(): number
  selfPid(): number
}

/**
 * `/proc/<pid>/stat` field 22.
 *
 * Parsed from the LAST `)` rather than by splitting on whitespace: field 2 is
 * the executable's comm, in parentheses, and comm may itself contain spaces and
 * parentheses (`(my prog)`), which is precisely how naive stat parsers read the
 * wrong field for the wrong process.
 */
export function parseProcStatStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  // After comm the fields are: state(3) ppid(4) ... starttime(22). Splitting the
  // remainder makes starttime index 19 (field 22 minus the three consumed).
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const startTime = fields[19]
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined
}

export const defaultInstanceGuardIo: InstanceGuardIo = {
  pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM means it exists under another uid — alive, and emphatically not
      // ours to displace. Only ESRCH reads as gone.
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  bootId() {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
    } catch {
      return undefined
    }
  },
  startTime(pid) {
    try {
      return parseProcStatStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    } catch {
      return undefined
    }
  },
  now: () => Date.now(),
  selfPid: () => process.pid,
}

/** This process's triple, for writing into a guard file. */
export function selfIdentityTriple(
  io: InstanceGuardIo = defaultInstanceGuardIo,
): ProcessIdentityTriple {
  const pid = io.selfPid()
  return { pid, bootId: io.bootId(), startTime: io.startTime(pid) }
}

/**
 * Is the recorded holder still the process that wrote this record?
 *
 * DISAGREEMENT IS DEATH; ABSENCE IS NOT. A recorded boot id that differs from
 * the current one proves a reboot, and a recorded start time that differs from
 * the pid's current one proves a recycle — both are conclusive, and both mean
 * the record is a corpse we may displace. A recorded field that is MISSING (an
 * older record, or a host without `/proc`) proves nothing either way, so it is
 * skipped rather than counted as a mismatch: refusing to start because we
 * cannot verify would strand every non-Linux host, and displacing on the same
 * evidence would kill live daemons there.
 */
export function holderIsLive(
  holder: ProcessIdentityTriple,
  io: InstanceGuardIo = defaultInstanceGuardIo,
): boolean {
  if (!io.pidAlive(holder.pid)) return false
  const bootId = io.bootId()
  if (holder.bootId !== undefined && bootId !== undefined && holder.bootId !== bootId) return false
  const startTime = io.startTime(holder.pid)
  if (holder.startTime !== undefined && startTime !== undefined && holder.startTime !== startTime) {
    return false
  }
  return true
}

/** Whether a holder record was verified against the full triple, or only the
 *  pid. Carried onto the handle so a caller can tell a proof from a guess. */
export function identityIsVerifiable(
  holder: ProcessIdentityTriple,
  io: InstanceGuardIo = defaultInstanceGuardIo,
): boolean {
  return (
    holder.bootId !== undefined &&
    holder.startTime !== undefined &&
    io.bootId() !== undefined &&
    io.startTime(holder.pid) !== undefined
  )
}

/**
 * The machine-wide directory the per-UUID guards live in.
 *
 * `XDG_RUNTIME_DIR` is the right home on Linux because the kernel empties it at
 * logout and the tree cannot outlive a boot — a guard that survived a reboot
 * would be a lie by construction. A SYSTEM service with `User=` never receives
 * that variable, so the fixed logind path is the fallback, exactly as
 * `userRuntimeDir()` in `@podium/pty` does it and for the same reason.
 *
 * `machineWide: false` says the guard could not be placed anywhere two
 * different state roots would both find it, so the copied-root check below is
 * degraded to a same-root check. Reported rather than hidden.
 */
export function instanceGuardDir(
  env: InstanceEnv = process.env,
  home: string = env.HOME || homedir(),
): { dir: string; machineWide: boolean } {
  if (process.platform === 'darwin') {
    return { dir: join(home, 'Library', 'Caches', 'podium', 'instances'), machineWide: true }
  }
  const runtimeDir = env.XDG_RUNTIME_DIR
  if (runtimeDir) return { dir: join(runtimeDir, 'podium', 'instances'), machineWide: true }
  if (process.platform === 'linux' && typeof process.getuid === 'function') {
    const fallback = `/run/user/${process.getuid()}`
    if (existsSync(fallback)) {
      return { dir: join(fallback, 'podium', 'instances'), machineWide: true }
    }
  }
  // No machine-wide runtime tree we can reach. Keep the guard inside the state
  // root so the in-root question is still answered, and tell the caller the
  // cross-root question is not.
  return {
    dir: join(instanceStateDir(resolveInstanceId(env), env, home), 'runtime', 'instances'),
    machineWide: false,
  }
}

export interface InstanceGuardHandle {
  /** The guard file this handle holds. */
  path: string
  /** False when the holder record could only be checked by pid (no `/proc`). */
  identityVerified: boolean
  /** Idempotent; only removes the file while it still holds OUR record. */
  release(): void
}

export class InstanceGuardHeldError extends Error {
  constructor(
    message: string,
    readonly holder: InstanceGuardHolder,
  ) {
    super(message)
    this.name = 'InstanceGuardHeldError'
  }
}

function readHolder(path: string): InstanceGuardHolder | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // ENOENT is "free". A CORRUPT or truncated record is also free: it can only
    // have come from a holder that died mid-write, and a record we cannot read
    // is a record we cannot be bound by.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
  const holder = parsed as Partial<InstanceGuardHolder>
  if (typeof holder.pid !== 'number' || typeof holder.stateDir !== 'string') return undefined
  if (typeof holder.instanceUuid !== 'string') return undefined
  return {
    pid: holder.pid,
    bootId: typeof holder.bootId === 'string' ? holder.bootId : undefined,
    startTime: typeof holder.startTime === 'string' ? holder.startTime : undefined,
    instanceUuid: holder.instanceUuid,
    stateDir: holder.stateDir,
    acquiredAtMs: typeof holder.acquiredAtMs === 'number' ? holder.acquiredAtMs : 0,
  }
}

/**
 * Write our record so that a concurrent reader never sees a partial one.
 *
 * The temp name carries our pid, so two racing acquirers cannot collide on the
 * staging file itself, and the rename is atomic — the guard path always holds
 * one complete record or none.
 */
function writeHolder(path: string, holder: InstanceGuardHolder): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  const staging = `${path}.${holder.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(holder, null, 2)}\n`, { mode: 0o600 })
  renameSync(staging, path)
}

function acquireAt(
  path: string,
  holder: InstanceGuardHolder,
  refuse: (existing: InstanceGuardHolder) => InstanceGuardHeldError,
  io: InstanceGuardIo,
): InstanceGuardHandle {
  const existing = readHolder(path)
  if (existing && holderIsLive(existing, io)) {
    // Our own record from an earlier call in this process: acquiring twice is
    // idempotent, not a conflict with ourselves.
    if (existing.pid !== holder.pid) throw refuse(existing)
  }
  writeHolder(path, holder)
  // RE-READ AFTER WRITING, because the write is last-writer-wins and two
  // acquirers can both have found the slot free. Whoever's record is on disk
  // now is the holder; if it is not ours we lost and must refuse, rather than
  // returning a handle to a guard someone else owns.
  const settled = readHolder(path)
  if (!settled || settled.pid !== holder.pid) {
    throw refuse(settled ?? existing ?? holder)
  }
  return {
    path,
    identityVerified: identityIsVerifiable(holder, io),
    release(): void {
      const current = readHolder(path)
      if (current && current.pid !== holder.pid) return
      rmSync(path, { force: true })
    },
  }
}

/**
 * Refuse a second daemon on ONE state root.
 *
 * Two daemons here is the simplest and most damaging case: both read the same
 * binding journal, so each sees the other's live processes as its own orphans.
 */
export function acquireStateRootLock(opts: {
  stateDir: string
  instanceUuid: string
  io?: InstanceGuardIo
}): InstanceGuardHandle {
  const io = opts.io ?? defaultInstanceGuardIo
  const uuid = validateInstanceUuid(opts.instanceUuid)
  const path = join(opts.stateDir, 'daemon.lock')
  const holder: InstanceGuardHolder = {
    ...selfIdentityTriple(io),
    instanceUuid: uuid,
    stateDir: opts.stateDir,
    acquiredAtMs: io.now(),
  }
  return acquireAt(
    path,
    holder,
    (existing) =>
      new InstanceGuardHeldError(
        `another Podium daemon (pid ${existing.pid}) already holds the state root ${opts.stateDir}`,
        existing,
      ),
    io,
  )
}

/**
 * Refuse a second daemon on ONE instance UUID, anywhere on this machine.
 *
 * A held guard whose recorded state root is DIFFERENT from ours is the copied
 * root, and it is the only way one UUID can be live twice. The message names
 * the remedy, because the operator's instinct here — delete the guard and
 * retry — produces exactly the two-owners-one-uuid state the guard exists to
 * prevent, and produces it silently.
 */
export function acquireInstanceSingleton(opts: {
  instanceUuid: string
  stateDir: string
  env?: InstanceEnv
  home?: string
  io?: InstanceGuardIo
  /** Overrides the discovered machine-wide directory (tests, and callers
   *  that already resolved it). */
  guardDir?: string
}): InstanceGuardHandle & { machineWide: boolean } {
  const io = opts.io ?? defaultInstanceGuardIo
  const uuid = validateInstanceUuid(opts.instanceUuid)
  const env = opts.env ?? process.env
  const discovered = instanceGuardDir(env, opts.home ?? env.HOME ?? homedir())
  const dir = opts.guardDir ?? discovered.dir
  const machineWide = opts.guardDir ? true : discovered.machineWide
  const holder: InstanceGuardHolder = {
    ...selfIdentityTriple(io),
    instanceUuid: uuid,
    stateDir: opts.stateDir,
    acquiredAtMs: io.now(),
  }
  const handle = acquireAt(
    join(dir, uuid),
    holder,
    (existing) =>
      new InstanceGuardHeldError(
        existing.stateDir === opts.stateDir
          ? `another Podium daemon (pid ${existing.pid}) is already live on instance uuid ${uuid}`
          : `instance uuid ${uuid} is already live from a different state root (${existing.stateDir}, pid ${existing.pid}); this state root was copied — run \`podium instance rekey\` to mint a fresh uuid for it`,
        existing,
      ),
    io,
  )
  return { ...handle, machineWide }
}
