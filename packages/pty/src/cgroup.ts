/**
 * CGROUP v2 OBSERVATION: what a session's scope actually costs, and whether the
 * kernel has killed anything in it (POD-2413; agent-runtime spec §6).
 *
 * The scope hierarchy in `scope.ts` is only half of "resource truth" — the
 * other half is reading back what the kernel recorded. Before this, `health()`
 * reported `oomEvents: 0` for every session on every driver, which is not a
 * measurement but a placeholder, and the memory number came from summing
 * `/proc/<pid>` across a guessed process subtree. A cgroup answers both
 * questions exactly, because a cgroup IS the session's process tree:
 *
 *  - `memory.current` / `memory.peak` — every process in the tree, no
 *    attribution heuristics and no double counting of shared pages.
 *  - `pids.current` against `pids.max` — how close the tree is to its task cap.
 *  - `memory.events`' `oom_kill` — a COUNTER of kernel OOM kills in this scope.
 *    That counter is the only trustworthy OOM evidence available to userspace:
 *    an exit code of 137 could be any SIGKILL, and dmesg needs privileges we do
 *    not have.
 *
 * FINDING THE CGROUP. The reliable route is `/proc/<pid>/cgroup`, which names
 * the process's own cgroup directly — no assumptions about where the user
 * manager puts a slice. (The obvious guess is wrong: a scope in
 * `podium-sessions.slice` lands under `…/user@<uid>.service/podium.slice/
 * podium-sessions.slice/…`, not beside the caller's own `app.slice` unit.) The
 * `systemctl show -p ControlGroup` route is kept as the fallback for when the
 * pid is unknown but the unit name is.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'

/** The cgroup2 mount. Overridable so tests can point at a fixture tree. */
export function cgroupRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PODIUM_CGROUP_ROOT || '/sys/fs/cgroup'
}

/**
 * One sample of a scope's cgroup. Every field is optional except the kill
 * counters: a missing file means "this kernel/controller does not report it",
 * and a zero there would be a claim we cannot support.
 */
export interface CgroupSample {
  /** Absolute path of the cgroup this sample came from. */
  path: string
  /**
   * When the kernel created this cgroup, in epoch ms — cgroupfs stamps the
   * directory's mtime at creation and never touches it again.
   *
   * It is what tells a session this supervisor STARTED from one it ADOPTED,
   * which the cumulative kill counter cannot: a scope older than the observer
   * carries history, a younger one carries only what happened on our watch.
   */
  createdAtMs?: number
  memoryBytes?: number
  peakMemoryBytes?: number
  swapBytes?: number
  /** `memory.swap.max`. Reported beside the memory ceiling because a budget
   *  whose swap half is invisible reads as half the real bound — the exact trap
   *  `MemorySwapMax` exists to close. */
  swapMaxBytes?: number
  memoryHighBytes?: number
  memoryMaxBytes?: number
  tasks?: number
  tasksMax?: number
  /** `memory.events` `oom_kill`: kernel OOM kills inside this scope, cumulative. */
  oomKills: number
  /** `oom_group_kill`: whole-cgroup kills — only possible under OOMPolicy=kill. */
  oomGroupKills: number
  /** `memory.events` `high`: reclaim-throttle hits. A large and growing number
   *  is a session crawling under its budget rather than progressing. */
  throttleEvents: number
}

/**
 * Parse a cgroup scalar file. `max` means unbounded, which is `undefined` here
 * and NOT `Infinity`: consumers format these as byte counts.
 */
export function parseCgroupScalar(text: string | undefined): number | undefined {
  const raw = text?.trim()
  if (!raw || raw === 'max') return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : undefined
}

/** Parse the `key value` lines of `memory.events` / `memory.stat`. */
export function parseCgroupKeyed(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/)
    if (!key || value === undefined) continue
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) out[key] = parsed
  }
  return out
}

/**
 * The cgroup path a `/proc/<pid>/cgroup` body names.
 *
 * cgroup v2 writes exactly one line, `0::<path>`. A v1-only host writes
 * numbered controller lines and no `0::` line at all — that answers
 * `undefined`, which is the honest reading: there is no unified hierarchy to
 * observe.
 */
export function parseProcCgroup(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^0::(.+)$/.exec(line.trim())
    if (match?.[1]) return match[1]
  }
  return undefined
}

/** Absolute cgroup directory for a live pid, or `undefined` off cgroup v2. */
export function cgroupPathForPid(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let body: string
  try {
    body = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
  } catch {
    // The process exited, or this is not Linux.
    return undefined
  }
  const relative = parseProcCgroup(body)
  if (!relative || relative === '/') return undefined
  return `${cgroupRoot(env)}${relative}`
}

function readNumber(path: string): number | undefined {
  try {
    return parseCgroupScalar(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Read one scope's resource truth.
 *
 * Returns `undefined` rather than a zeroed sample when the cgroup is gone: a
 * scope that has been garbage-collected has no numbers, and inventing some
 * would be exactly the "health always reports zero" lie this replaces.
 */
export function readCgroupSample(path: string): CgroupSample | undefined {
  let events: Record<string, number>
  try {
    events = parseCgroupKeyed(readFileSync(`${path}/memory.events`, 'utf8'))
  } catch {
    return undefined
  }
  let createdAtMs: number | undefined
  try {
    createdAtMs = statSync(path).mtimeMs
  } catch {
    // Collected between the read above and this stat.
  }
  const memoryBytes = readNumber(`${path}/memory.current`)
  const peakMemoryBytes = readNumber(`${path}/memory.peak`)
  const swapBytes = readNumber(`${path}/memory.swap.current`)
  const swapMaxBytes = readNumber(`${path}/memory.swap.max`)
  const memoryHighBytes = readNumber(`${path}/memory.high`)
  const memoryMaxBytes = readNumber(`${path}/memory.max`)
  const tasks = readNumber(`${path}/pids.current`)
  const tasksMax = readNumber(`${path}/pids.max`)
  return {
    path,
    ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    ...(memoryBytes !== undefined ? { memoryBytes } : {}),
    ...(peakMemoryBytes !== undefined ? { peakMemoryBytes } : {}),
    ...(swapBytes !== undefined ? { swapBytes } : {}),
    ...(swapMaxBytes !== undefined ? { swapMaxBytes } : {}),
    ...(memoryHighBytes !== undefined ? { memoryHighBytes } : {}),
    ...(memoryMaxBytes !== undefined ? { memoryMaxBytes } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...(tasksMax !== undefined ? { tasksMax } : {}),
    oomKills: events.oom_kill ?? 0,
    oomGroupKills: events.oom_group_kill ?? 0,
    throttleEvents: events.high ?? 0,
  }
}

/** `systemctl --user show` argv that answers a unit's cgroup path — the
 *  fallback route when only the unit name is known. */
export function controlGroupQueryArgv(unit: string): string[] {
  return ['--user', 'show', '--property=ControlGroup', '--value', unit]
}

/** Compose the absolute path from a `ControlGroup` property value. */
export function cgroupPathForControlGroup(
  controlGroup: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const relative = controlGroup.trim()
  if (!relative || relative === '/') return undefined
  return `${cgroupRoot(env)}${relative}`
}

/**
 * The cgroup directory chain a slice name expands to.
 *
 * systemd derives a slice's parent from its own name by cutting at the last
 * `-`, and materializes every ancestor: `podium-sessions.slice` becomes
 * `podium.slice/podium-sessions.slice` on disk. Reproducing that here is what
 * lets the supervisor find a session's cgroup without shelling out to
 * `systemctl show` for every session on every poll.
 */
export function sliceChainPath(slice: string): string {
  const base = slice.endsWith('.slice') ? slice.slice(0, -'.slice'.length) : slice
  const parts = base.split('-')
  const chain: string[] = []
  for (let i = 1; i <= parts.length; i++) chain.push(`${parts.slice(0, i).join('-')}.slice`)
  return chain.join('/')
}

/**
 * The user manager's cgroup root — the directory every `--user` unit hangs off.
 *
 * Derived from OUR OWN cgroup when we are inside the user manager (cut at
 * `user@<uid>.service`), because that is a fact rather than a convention. A
 * SYSTEM service with `User=` has no such component in its path, so it falls
 * back to logind's fixed layout — the same fallback `userRuntimeDir()` makes
 * for `XDG_RUNTIME_DIR`, and for the same reason.
 */
export function userManagerCgroupBase(uid: number, selfCgroup?: string): string {
  const own = selfCgroup ?? readSelfCgroup()
  const marker = `/user@${uid}.service`
  const at = own?.indexOf(marker)
  if (own && at !== undefined && at >= 0) return own.slice(0, at + marker.length)
  return `/user.slice/user-${uid}.slice/user@${uid}.service`
}

function readSelfCgroup(): string | undefined {
  try {
    return parseProcCgroup(readFileSync('/proc/self/cgroup', 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Where a session's transient scope keeps its cgroup files.
 *
 * Two candidates, in order, and BOTH are needed: a scope created since
 * POD-2413 sits in the instance's sessions slice, while one created before it
 * — a session adopted across a redeploy, which is exactly the long-lived
 * session whose resource use matters most — is still in the user manager's
 * default `app.slice`. Existence decides; nothing is assumed.
 */
export function sessionScopeCgroupPath(
  unit: string,
  options: { uid: number; slice?: string; env?: NodeJS.ProcessEnv; selfCgroup?: string },
): string | undefined {
  const root = cgroupRoot(options.env ?? process.env)
  const base = `${root}${userManagerCgroupBase(options.uid, options.selfCgroup)}`
  const candidates = [
    ...(options.slice ? [`${base}/${sliceChainPath(options.slice)}/${unit}`] : []),
    `${base}/app.slice/${unit}`,
    `${base}/${unit}`,
  ]
  return candidates.find((path) => existsSync(path))
}

/**
 * Parse a cgroup PSI file (`memory.pressure`) into its `some`/`full` averages.
 *
 * PSI IS THE ONLY CACHE-FREE PRESSURE SIGNAL A CGROUP OFFERS. `memory.current`
 * counts reclaimable page cache, and the kernel only reclaims cache AT the
 * `memory.high` line — so on any build-heavy host a slice settles pinned at its
 * high watermark with plenty of memory genuinely free, and "current >= high"
 * becomes chronically true while nothing is actually short of memory. `some
 * avg10` instead measures the share of the last ten seconds in which at least
 * one task STALLED waiting for memory, which is the thing worth acting on.
 *
 * `undefined` where the kernel was built without PSI: absent is honest, and a
 * zero would read as "measured, and there is no pressure".
 */
export function parseCgroupPressure(
  text: string,
): { some10?: number; full10?: number } | undefined {
  const out: { some10?: number; full10?: number } = {}
  for (const line of text.split('\n')) {
    const match = /^(some|full)\s+avg10=([\d.]+)/.exec(line.trim())
    if (!match?.[2]) continue
    const value = Number.parseFloat(match[2])
    if (!Number.isFinite(value)) continue
    if (match[1] === 'some') out.some10 = value
    else out.full10 = value
  }
  return out.some10 === undefined && out.full10 === undefined ? undefined : out
}

/** Read a cgroup's memory PSI, or `undefined` when the kernel has none. */
export function readCgroupPressure(path: string): { some10?: number; full10?: number } | undefined {
  try {
    return parseCgroupPressure(readFileSync(`${path}/memory.pressure`, 'utf8'))
  } catch {
    return undefined
  }
}
