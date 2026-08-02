/**
 * MACHINES SLICE — spawn PLACEMENT (POD-330).
 *
 * Where a new agent goes: which worktree on which machine, and which agent kind
 * when the user has expressed no preference. Placement is a machines question
 * because the answer is a machine and a path on it, not because the button
 * happens to live in a particular surface — terminal and worklist both read it.
 *
 * It does NOT decide whether the principal may run there. That is `authority.ts`
 * (`resolveSpawnTargetMachine`), and the separation is deliberate: placement
 * that could also authorize would be a code-execution decision hidden inside a
 * layout helper.
 *
 * Depends on nothing in `viewmodels/` except the shared view types.
 * Platform-neutral: no DOM, no storage.
 */
import { isHeadlessSession, type AgentKind, type SessionMeta } from '@podium/model'
import type { RepoView, WorktreeView } from '../../types'

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

/** Resolve the user's default agent kind for the unified split button. 'auto' (or
 *  unset) resolves to the most recently ACTIVE non-shell session's kind, falling
 *  back to claude-code.
 *
 *  POD-330: a spawn-placement question, so it belongs with the rest of spawn
 *  placement rather than with whichever surface happens to render the button —
 *  terminal and worklist both read it. */
export function resolveDefaultAgent(
  setting: string | undefined,
  sessions: SessionMeta[],
): AgentKind {
  if (setting && setting !== 'auto') return setting as AgentKind
  let best: SessionMeta | undefined
  for (const s of sessions) {
    if (s.agentKind === 'shell' || isHeadlessSession(s)) continue
    if (!best || s.lastActiveAt > best.lastActiveAt) best = s
  }
  return best && best.agentKind !== 'shell' ? best.agentKind : 'claude-code'
}
