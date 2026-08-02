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
  normalizeOriginUrl,
  repoNameFromOrigin,
  type GitRepositoryWire,
  type HostMetricsWire,
} from '@podium/model'
import type { RepoView, WorktreeView } from '../../types'

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

/** Does `cwd` still resolve to a live, scanned worktree? False when the path is
 *  no longer among any repo's worktrees — e.g. a session whose git worktree was
 *  removed out from under it (an "orphaned" session). Also false when no repos
 *  are loaded yet; callers that must not flag orphans during the boot window
 *  should gate on `repos.length > 0` themselves. */
export function isKnownWorktreePath(repos: GitRepositoryWire[], cwd: string): boolean {
  return repoBranchForCwd(repos, cwd) !== null
}

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
