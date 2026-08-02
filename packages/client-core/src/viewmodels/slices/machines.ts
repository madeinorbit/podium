/**
 * MACHINES SLICE (POD-330) — owned compute, and everything that is a fact about
 * a machine.
 *
 * Per `docs/multi-user-readiness.md` §3.1.1 a machine is **owned compute**, not
 * tenant-visible infrastructure, and repos/prefixes, worktrees, harness + model
 * inventory and host metrics are per-machine FACTS that inherit that machine's
 * scoping rather than carrying visibility of their own. That is why the
 * repo/worktree structure lives here and not in the worklist: the worklist
 * DECORATES this structure with sessions and issues, which is a one-way edge.
 *
 * THREE VERBS, NOT A BOOLEAN (§3.1.4 M1). `see`, `use` and `manage` are
 * separable, and `use` is a CODE-EXECUTION boundary rather than a privacy one
 * (M2) — running an agent on someone's machine is arbitrary execution on their
 * hardware with their SSH keys, git identity and checkouts. It must never be
 * published as the same flag as visibility.
 *
 * UNAUTHORIZED IS NOT UNREACHABLE (M5). Both produce an empty machine list, and
 * collapsing them is the defect: "you may not run here" and "it is offline" need
 * different words in the UI and different recovery.
 *
 * Depends on F1 only. Imports no other slice.
 * Platform-neutral: no DOM, no storage.
 */
import {
  machinesWithRepo,
  normalizeOriginUrl,
  repoNameFromOrigin,
  resolveTargetMachine,
  type GitRepositoryWire,
  type HostMetricsWire,
  type RecentSession,
  type RepoMachines,
  type SelectableMachine,
} from '@podium/model'
import type { RepoView, WorktreeView } from '../types'

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
// Spawn placement.
// ---------------------------------------------------------------------------

/**
 * The minimum a spawn target needs to be resolved: repo identity, its
 * worktrees, and which machines hold it. Named explicitly rather than reusing
 * `RepoView` because this is the real contract — both `RepoView` and the
 * worklist's decorated nav view satisfy it, and neither is imported here.
 *
 * `machines` is optional because the worklist's nav view has it optional; the
 * body already treats an absent list as "no machine-specific placement".
 */
export interface SpawnRepoTarget {
  path: string
  name: string
  worktrees: readonly WorktreeView[]
  machines?: readonly { machineId: string; path: string }[]
  repoId?: RepoView['repoId']
}

/**
 * The worktree the unified "New <Agent> in <Repo>" button spawns into, plus the
 * clone's own display name. A repo view can aggregate SEVERAL local clones of
 * the same origin (reposToViews groups by normalized origin URL), so it may hold
 * multiple `isMain` worktrees — spawning must target the clone the user actually
 * works in, not whichever clone happened to be scanned first.
 *
 * POD-330: this takes {@link SpawnRepoTarget}, NOT the worklist's decorated nav
 * view. It only ever read path/name/worktrees/machines/repoId, and its previous
 * signature is why the machines↔worklist dependency looked circular. The old
 * body opened by destructuring `repoName`/`sessions`/`issues` back off its own
 * parameter — a helper whose first act is to undo its own parameter type is
 * telling you which side owns it.
 */
export function spawnTargetForRepo(
  repo: SpawnRepoTarget,
  machineId?: string,
): {
  worktree: WorktreeView
  repoName: string
} {
  if (machineId !== undefined) {
    const machinePath = repo.machines?.find((m) => m.machineId === machineId)?.path
    const chosen =
      repo.worktrees.find(
        (w) =>
          w.machineId === machineId &&
          w.isMain &&
          (machinePath === undefined || w.path === machinePath),
      ) ?? repo.worktrees.find((w) => w.machineId === machineId && w.isMain)
    if (chosen) return { worktree: chosen, repoName: repo.name }
    if (machinePath !== undefined) {
      return {
        worktree: {
          path: machinePath,
          repoPath: machinePath,
          isMain: true,
          machineId,
          ...(repo.repoId !== undefined ? { repoId: repo.repoId } : {}),
        },
        repoName: repo.name,
      }
    }
  }

  // The primary worktree is the repo's OWN main checkout (path === repo.path) —
  // never a sibling clone that origin-grouping folded into this RepoView, and
  // never a linked worktree. The label is always the repo's registered name.
  const chosen =
    repo.worktrees.find((w) => w.isMain && w.path === repo.path) ??
    repo.worktrees.find((w) => w.path === repo.path)
  if (!chosen) {
    // Filtered out of the nav (e.g. pinned away) or a clone-canonical mismatch —
    // reconstruct the repo's own main checkout, same fallback as repoPrimaryWorktree.
    return {
      worktree: {
        path: repo.path,
        repoPath: repo.path,
        isMain: true,
        ...(repo.repoId !== undefined ? { repoId: repo.repoId } : {}),
      },
      repoName: repo.name,
    }
  }
  return { worktree: chosen, repoName: repo.name }
}

// ---------------------------------------------------------------------------
// The three verbs.
// ---------------------------------------------------------------------------

/** §3.1.4 M1. Kept as three independent booleans on purpose: any collapse to a
 *  single flag re-creates the bug M2 exists to prevent. */
export interface MachineGrants {
  /** It exists; health/liveness; "your session ran there". */
  readonly see: boolean
  /** Spawn, reattach, attach a PTY, run harness commands, read/write files,
   *  take a worktree. A CODE-EXECUTION boundary. Owner only until granted. */
  readonly use: boolean
  /** Rename, unpair, rotate pairing token, remove from fleet. */
  readonly manage: boolean
}

/** Default-closed, per §3.1.1's rule that a missing classification must fail
 *  toward privacy. An unknown machine grants nothing. */
export const NO_MACHINE_GRANTS: MachineGrants = { see: false, use: false, manage: false }

/**
 * Why you cannot spawn on a machine right now. `unauthorized` and `unreachable`
 * are deliberately different values: they produce the same empty list and mean
 * completely different things (M5).
 */
export type MachineAvailability =
  /** Visible, `use` granted, online. */
  | 'available'
  /** Visible and `use` granted, but the host is not connected. Retry later. */
  | 'unreachable'
  /** Visible but `use` NOT granted. Waiting will not help; ask the owner. */
  | 'unauthorized'

export interface MachineView<M extends SelectableMachine = SelectableMachine> {
  readonly machine: M
  readonly grants: MachineGrants
  readonly availability: MachineAvailability
}

/**
 * Publish each machine with its verbs and its availability, keeping the two
 * separate. Machines the principal cannot even `see` are absent entirely — that
 * is the privacy boundary, and it is the only one that removes a row.
 */
export function machineViews<M extends SelectableMachine>(
  machines: readonly M[],
  grantsOf: (machine: M) => MachineGrants,
): MachineView<M>[] {
  const out: MachineView<M>[] = []
  for (const machine of machines) {
    const grants = grantsOf(machine)
    if (!grants.see) continue
    out.push({
      machine,
      grants,
      availability: !grants.use ? 'unauthorized' : machine.online ? 'available' : 'unreachable',
    })
  }
  return out
}

/** The machines a spawn/handoff may actually target. */
export function usableMachines<M extends SelectableMachine>(
  views: readonly MachineView<M>[],
): M[] {
  return views.filter((v) => v.availability === 'available').map((v) => v.machine)
}

/** Why a spawn target could not be resolved — never a bare `undefined`, so the
 *  caller can say which of the three things went wrong. */
export type SpawnTargetRefusal =
  /** No visible machine holds this repo. */
  | 'no-repo'
  /** Machines hold the repo, but the principal lacks `use` on all of them. */
  | 'unauthorized'
  /** The principal may use them; none is online. */
  | 'unreachable'

export interface SpawnTargetResolution {
  readonly machineId?: string
  readonly refusal?: SpawnTargetRefusal
}

/**
 * Recommended spawn machine, gated on `use`.
 *
 * The acceptance property: this NEVER returns a machine the principal lacks
 * `use` on. The gate is applied to the candidate set BEFORE
 * `resolveTargetMachine` sees it, rather than filtered afterwards, so there is
 * no path on which an unauthorized id is chosen and then has to be caught.
 *
 * When it refuses, it says which refusal it is — M5's "denied and offline
 * produce the same empty list otherwise".
 */
export function resolveSpawnTargetMachine<
  S extends RecentSession,
  M extends SelectableMachine,
>(
  repo: RepoMachines,
  sessions: readonly S[],
  views: readonly MachineView<M>[],
): SpawnTargetResolution {
  // Everything the principal can SEE that holds this repo — the population the
  // two refusals are distinguished within.
  //
  // `machinesWithRepo`, NOT `machinesForRepo`: the latter also filters on
  // `online`, which would fold liveness into the population and collapse
  // "unreachable" into "unauthorized" — precisely the M5 distinction this
  // function exists to preserve. Liveness is decided below, once, as
  // availability.
  const visibleWithRepo = machinesWithRepo(
    repo,
    views.map((v) => v.machine),
  )
  if (visibleWithRepo.length === 0) return { refusal: 'no-repo' }

  const byId = new Map(views.map((v) => [v.machine.id, v]))
  const withRepoViews = visibleWithRepo
    .map((m) => byId.get(m.id))
    .filter((v): v is MachineView<M> => v !== undefined)

  const useGranted = withRepoViews.filter((v) => v.grants.use)
  if (useGranted.length === 0) return { refusal: 'unauthorized' }

  const online = useGranted.filter((v) => v.availability === 'available').map((v) => v.machine)
  if (online.length === 0) return { refusal: 'unreachable' }

  const machineId = resolveTargetMachine(repo, [...sessions], online)
  return machineId === undefined ? { refusal: 'unreachable' } : { machineId }
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
