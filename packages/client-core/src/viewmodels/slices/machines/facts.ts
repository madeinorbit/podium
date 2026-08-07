/**
 * MACHINES SLICE — the FACTS about a machine (POD-330).
 *
 * Per `docs/multi-user-readiness.md` §3.1.1 a machine is **owned compute**, not
 * tenant-visible infrastructure, and repos/prefixes, worktrees, harness + model
 * inventory and host metrics are per-machine FACTS that inherit that machine's
 * scoping rather than carrying visibility of their own. They have no separate
 * visibility: if you can SEE the machine you can see its facts, and if you
 * cannot, they never arrive.
 *
 * That is why the repo/worktree structure lives here and not in the worklist —
 * the worklist DECORATES this structure with sessions and issues, which is the
 * one-way `worklist -> machines` edge.
 *
 * WHY THIS IS A SEPARATE FILE FROM `authority.ts`. The machines slice answers
 * two different questions, and the ~400-line criterion was the prompt to notice
 * rather than the reason to cut: "what is on this machine" is a FACT the
 * authority sends, while "what may this principal do with it" is a DECISION the
 * authority made. Splitting there keeps the code-execution boundary in a file of
 * its own; splitting by line count would have put half the verbs in each.
 *
 * Depends on nothing in `viewmodels/` except the shared view types.
 * Platform-neutral: no DOM, no storage.
 */
import {
  isIssueClosed,
  normalizeOriginUrl,
  repoNameFromOrigin,
  type GitRepositoryWire,
  type HostMetricsWire,
  type SessionMeta,
  type SessionStatus,
} from '@podium/model'
import type { RepoView, WorktreeView } from '../../types'

/** Path containment (POSIX) — same rule as dock-panel's cwdInWorktree, local so
 *  this facts module stays free of other viewmodel edges. */
function cwdUnderRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
}

// ---------------------------------------------------------------------------
// Repo / worktree structure. A machine fact.
// ---------------------------------------------------------------------------

export function reposToViews(repos: GitRepositoryWire[]): RepoView[] {
  // Scanning a path that contains worktrees returns both the parent repo (with its
  // worktrees[]) and each worktree as its own top-level entry. Drop the standalone
  // duplicates so each worktree shows once, nested under its parent.
  const linkedWorktreePaths = new Set(repos.flatMap((r) => r.worktrees.map((w) => w.path)))
  const candidates = repos.filter((r) => !linkedWorktreePaths.has(r.path))

  // Group by the server-stamped repoId when present. That lets the server's
  // stable cross-machine identity win even when an older/remote scan lacks an
  // originUrl on the wire. Fall back to normalized origin, then (machineId,path)
  // for local repos without a remote so unrelated originless repos never merge.
  const groups = new Map<string, GitRepositoryWire[]>()
  for (const r of candidates) {
    const origin = normalizeOriginUrl(r.originUrl)
    const key =
      r.repoId ?? (origin !== '' ? origin : `__no_remote__:${r.machineId ?? ''}:${r.path}`)
    const existing = groups.get(key)
    if (existing) {
      existing.push(r)
    } else {
      groups.set(key, [r])
    }
  }

  const views: RepoView[] = []
  for (const [, group] of groups) {
    // Use the first repo's path/name as the canonical identity for the RepoView.
    // The group is always non-empty (we only insert when we have a repo to key).
    if (group.length === 0) continue
    const first: GitRepositoryWire = group[0] as GitRepositoryWire
    const originUrl = group.map((r) => normalizeOriginUrl(r.originUrl)).find((u) => u !== '')
    const repoId = group.find((r) => r.repoId !== undefined)?.repoId

    const worktrees: WorktreeView[] = []
    const machines: { machineId: string; path: string }[] = []

    for (const r of group) {
      const machineId = r.machineId
      if (machineId !== undefined) {
        machines.push({ machineId, path: r.path })
      }
      const main: WorktreeView = {
        path: r.path,
        ...(r.branch !== undefined ? { branch: r.branch } : {}),
        repoPath: r.path,
        isMain: true,
        ...(machineId !== undefined ? { machineId } : {}),
        ...(r.repoId !== undefined ? { repoId: r.repoId } : {}),
      }
      worktrees.push(main)
      for (const w of r.worktrees) {
        worktrees.push({
          path: w.path,
          ...(w.branch !== undefined ? { branch: w.branch } : {}),
          repoPath: r.path,
          isMain: false,
          ...(machineId !== undefined ? { machineId } : {}),
          ...(r.repoId !== undefined ? { repoId: r.repoId } : {}),
        })
      }
    }

    views.push({
      path: first.path,
      // Name the repo by its ORIGIN, not the folder it happens to sit in: a backup
      // clone at ~/bak_podium of .../podium.git is still "podium", and this name is
      // what the sidebar's "New <agent> in <repo>" and the rail/palette show. Only
      // an originless repo is named after its folder — that is all we know about it.
      // `originUrl` here is already normalized (host/owner/repo); the helper is
      // idempotent over that. [spec:SP-3701]
      name: repoNameFromOrigin(originUrl) ?? (first.path.split('/').pop() || first.path),
      worktrees,
      machines,
      ...(originUrl !== undefined ? { originUrl } : {}),
      ...(repoId !== undefined ? { repoId } : {}),
    })
  }

  return views
}

/** Resolve a session's cwd to its repo name + branch, for the pinned-panel
 *  badge — pinned panels span repos/worktrees, so "which repo/branch" is what
 *  tells them apart. Null when the cwd isn't a known worktree (e.g. a session
 *  spawned in a path discovery hasn't indexed). */
export function repoBranchForCwd(
  repos: GitRepositoryWire[],
  cwd: string,
): { repo: string; branch?: string } | null {
  for (const repo of reposToViews(repos)) {
    for (const worktree of repo.worktrees) {
      if (worktree.path === cwd) {
        return {
          repo: repo.name,
          ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
        }
      }
    }
  }
  return null
}

/*
 * `isKnownWorktreePath` USED TO LIVE HERE, and it is deliberately gone (POD-1704).
 *
 * It answered `repoBranchForCwd(...) !== null` and its one caller read the FALSE
 * as "this session's worktree was deleted", then offered to destroy the session
 * row. That inverts what this index can support. The scan is a POSITIVE index:
 * it says where a worktree IS. It cannot say one does not exist, because "absent
 * from the snapshot" also covers a scan that timed out, a machine that went
 * offline, a fan-out narrowed by `use` authz, and the boot window before the
 * first scan lands — none of which are facts about the directory.
 *
 * Whether a path exists is observable, and observable by exactly one party: the
 * daemon on that machine. Ask it (`ensureWorktree` already does, and rebuilds
 * from the branch when it is really missing) instead of inferring it from a list
 * that was never complete by contract.
 *
 * `repoBranchForCwd` below stays, because its callers use it POSITIVELY — a
 * match names the repo/branch badge, and a miss simply means no badge.
 */

/** Most-recent session activity per raw repo wire (containment over the repo
 *  root and its linked worktrees) — for sorting repo pickers by recent use. */
export function repoUsageAt(
  repo: GitRepositoryWire,
  sessions: { cwd: string; lastActiveAt: string }[],
): number {
  const roots = [repo.path, ...repo.worktrees.map((w) => w.path)]
  let max = 0
  for (const s of sessions) {
    if (!roots.some((r) => s.cwd === r || s.cwd.startsWith(`${r}/`))) continue
    const ts = Date.parse(s.lastActiveAt) || 0
    if (ts > max) max = ts
  }
  return max
}

// ---------------------------------------------------------------------------
// Host metrics — a per-machine fact, inheriting that machine's scoping.
// ---------------------------------------------------------------------------

export type MemorySeverity = 'ok' | 'warn' | 'critical'

export interface HostMemoryView {
  hostname: string
  /** Headline: `used/total GB`, e.g. "12.3/32 GB". RAM only — swap never bleeds in. */
  label: string
  /** Used percentage, 0–100. */
  pct: number
  severity: MemorySeverity
  /** Tooltip: hostname + the full numbers, including swap when the host has any. */
  title: string
}

const GIB = 1024 ** 3
const usedGib = (bytes: number): string => (bytes / GIB).toFixed(1)
// Totals are installed capacity — print "32", not "32.0".
const totalGib = (bytes: number): string => {
  const v = bytes / GIB
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** Human size for breakdown rows: "12.3 GB" from 1 GiB up, whole "512 MB" below. */
export function formatMemBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/**
 * Present one host's memory sample. Used = total − available (the kernel's
 * "allocatable without swapping" estimate), the convention of free/htop/Activity
 * Monitor — counting page cache as used would peg every warm box near 100%.
 */
export function hostMemoryView(host: HostMetricsWire): HostMemoryView {
  const m = host.memory
  const usedBytes = Math.max(0, m.totalBytes - m.availableBytes)
  const pct = m.totalBytes > 0 ? Math.round((usedBytes / m.totalBytes) * 100) : 0
  const severity: MemorySeverity = pct >= 90 ? 'critical' : pct >= 75 ? 'warn' : 'ok'
  const label = `${usedGib(usedBytes)}/${totalGib(m.totalBytes)} GB`
  const swap =
    m.swapTotalBytes > 0
      ? ` · swap ${usedGib(Math.max(0, m.swapTotalBytes - m.swapFreeBytes))}/${totalGib(m.swapTotalBytes)} GB`
      : ''
  return {
    hostname: host.hostname,
    label,
    pct,
    severity,
    title: `${host.hostname} — memory ${label} used (${pct}%)${swap}`,
  }
}

// ---------------------------------------------------------------------------
// Host pressure (POD-563 / POD-554 PR 6) — load + residency + reclaimable inventory.
// Pure derivations from the streamed host sample and the client sessions/issues
// slices. No new streaming channel; inventory is not GiB (no du probe yet).
// ---------------------------------------------------------------------------

/** Default load-per-core the meter fills against when policy has load pressure off. */
export const DEFAULT_LOAD_PER_CORE = 1.5

/** Amber health-dot threshold: reclaimable worktree count past this asks the operator. */
export const RECLAIMABLE_WORKTREE_THRESHOLD = 20

const RESIDENT_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'live',
  'starting',
  'reconnecting',
])

export interface HostLoadView {
  /** load1 ÷ cores, or null when the daemon has not shipped `load`. */
  perCore: number | null
  /** 0–100 meter fill against the parking threshold (clamped). */
  meterPct: number
  /** Display value, e.g. `1.8×` or `—`. */
  label: string
  severity: MemorySeverity
  title: string
}

/**
 * Present one host's load sample. The meter fills against `loadPerCore` (full =
 * parking is happening), not against a notional 100%. Past threshold clamps at
 * 100% and the value takes critical tone.
 */
export function hostLoadView(
  host: HostMetricsWire,
  loadPerCore: number | null = DEFAULT_LOAD_PER_CORE,
): HostLoadView {
  const load = host.load
  if (!load || load.cpuCount <= 0) {
    return {
      perCore: null,
      meterPct: 0,
      label: '—',
      severity: 'ok',
      title: `${host.hostname} — load unavailable`,
    }
  }
  const perCore = load.one / load.cpuCount
  const threshold = loadPerCore ?? DEFAULT_LOAD_PER_CORE
  const ratio = threshold > 0 ? perCore / threshold : 0
  const meterPct = Math.min(100, Math.round(ratio * 100))
  const severity: MemorySeverity = ratio >= 1 ? 'critical' : ratio >= 0.8 ? 'warn' : 'ok'
  const label = `${perCore.toFixed(1)}×`
  return {
    perCore,
    meterPct,
    label,
    severity,
    title: `${host.hostname} — load ${label} per core (threshold ${threshold.toFixed(1)}×)`,
  }
}

/** Sessions whose process is resident on this machine (not working-count). */
export function residentSessionsOnMachine(
  sessions: readonly SessionMeta[],
  machineId: string | undefined,
): SessionMeta[] {
  if (!machineId) return []
  return sessions.filter(
    (s) => s.machineId === machineId && RESIDENT_STATUSES.has(s.status) && !s.archived,
  )
}

export interface HostAgentsView {
  count: number
  /** 0–100 when a cap is set; null means no meter. */
  meterPct: number | null
  severity: MemorySeverity
  title: string
}

/**
 * Agent residency on one machine. Meter only when `maxIdleSessions` is set —
 * full meter = at the idle-session convergence target. Never a working count
 * (StatusStrip owns that fact).
 */
export function hostAgentsView(
  sessions: readonly SessionMeta[],
  machineId: string | undefined,
  maxIdleSessions: number | null,
  hostname: string,
): HostAgentsView {
  const count = residentSessionsOnMachine(sessions, machineId).length
  if (maxIdleSessions == null) {
    return {
      count,
      meterPct: null,
      severity: 'ok',
      title: `${hostname} — ${count} agent session${count === 1 ? '' : 's'} live here`,
    }
  }
  const ratio = maxIdleSessions > 0 ? count / maxIdleSessions : count > 0 ? 1 : 0
  const meterPct = Math.min(100, Math.round(ratio * 100))
  const severity: MemorySeverity = ratio >= 1 ? 'critical' : ratio >= 0.8 ? 'warn' : 'ok'
  return {
    count,
    meterPct,
    severity,
    title: `${hostname} — ${count} agent session${count === 1 ? '' : 's'} live here (target ${maxIdleSessions})`,
  }
}

/** Split idle-live sessions into parkable vs protected (needs_user / no resume). */
export function idleSessionSplit(
  sessions: readonly SessionMeta[],
  machineId: string | undefined,
): { parkable: number; protected: number; idle: number } {
  if (!machineId) return { parkable: 0, protected: 0, idle: 0 }
  let parkable = 0
  let protectedCount = 0
  for (const s of sessions) {
    if (s.machineId !== machineId || s.status !== 'live' || s.archived) continue
    const phase = s.agentState?.phase
    if (phase !== 'idle' && phase !== 'ended' && phase !== 'needs_user') continue
    // needs_user and sessions without a resume ref are protected on purpose.
    if (phase === 'needs_user' || !s.resumable) protectedCount += 1
    else parkable += 1
  }
  return { parkable, protected: protectedCount, idle: parkable + protectedCount }
}

export interface ReclaimableWorktree {
  issueId: string
  title: string
  worktreePath: string
  closedAt: string
  machineId: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Closed issues whose checkout is still on disk and free of live sessions —
 * the same GC candidate predicate as the janitor (POD-564), evaluated on the
 * client so the panel needs no new streaming channel. Age is measured from
 * `closedAt` against `afterDays`. No dirty-tree check (that is apply-time).
 */
export function listReclaimableWorktreesClient(args: {
  issues: readonly {
    id: string
    title: string
    stage: string
    closedReason?: string | null
    closedAt?: string | null
    deletedAt?: string | null
    worktreePath?: string | null
    machineId?: string | null
  }[]
  sessions: readonly SessionMeta[]
  afterDays: number
  machineId?: string
  nowMs?: number
}): ReclaimableWorktree[] {
  const nowMs = args.nowMs ?? Date.now()
  const cutoff = nowMs - args.afterDays * DAY_MS
  const live = args.sessions.filter((s) => RESIDENT_STATUSES.has(s.status))
  return args.issues
    .filter((row) => {
      if (!row.worktreePath || row.deletedAt) return false
      if (!isIssueClosed(row)) return false
      const closedMs = Date.parse(row.closedAt ?? '')
      if (!Number.isFinite(closedMs) || closedMs > cutoff) return false
      if (args.machineId != null && (row.machineId ?? null) !== args.machineId) return false
      const occupied = live.some((s) => cwdUnderRoot(s.cwd, row.worktreePath as string))
      return !occupied
    })
    .map((row) => ({
      issueId: row.id,
      title: row.title,
      worktreePath: row.worktreePath as string,
      closedAt: row.closedAt as string,
      machineId: row.machineId ?? null,
    }))
    .sort((a, b) => a.closedAt.localeCompare(b.closedAt) || a.issueId.localeCompare(b.issueId))
}

/** Phase breakdown for an AGT tooltip (working ≠ resident). */
export function residencyBreakdown(
  sessions: readonly SessionMeta[],
  machineId: string | undefined,
): { working: number; idle: number; waiting: number; other: number } {
  let working = 0
  let idle = 0
  let waiting = 0
  let other = 0
  for (const s of residentSessionsOnMachine(sessions, machineId)) {
    const phase = s.agentState?.phase
    if (phase === 'working' || phase === 'compacting') working += 1
    else if (phase === 'idle' || phase === 'ended') idle += 1
    else if (phase === 'needs_user') waiting += 1
    else other += 1
  }
  return { working, idle, waiting, other }
}
