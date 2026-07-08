import { GitBranch } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { cwdInWorktree } from './dock-panel'
import { type SpecBranchChangeWire, SpecDiffCards, SpecDiffMiniTree } from './SpecDiffPanel'
import { useStore } from './store'

/**
 * Right-dock "Specs" tab (#172): the active session's branch, seen as spec
 * changes. Resolves the session cwd → owning repo + worktree branch, loads the
 * component-level diff vs canon, and renders it as a navigable mini tree over
 * rich diff cards. The dock only offers the tab when the branch actually
 * touches pspec/ (useSpecBranchChanges gates it).
 */

interface SpecTarget {
  repoPath: string
  branch: string
}

/** cwd → {repo root, branch} via the repos store; null when unresolvable or
 *  when cwd IS the repo root (canon has no diff against itself). */
export function resolveSpecTarget(
  repos: { path: string; kind: string; worktrees?: { path: string; branch?: string }[] }[],
  cwd: string,
): SpecTarget | null {
  for (const repo of repos) {
    if (repo.kind === 'worktree') continue
    for (const wt of repo.worktrees ?? []) {
      if (wt.branch && cwdInWorktree(cwd, wt.path) && wt.path !== repo.path) {
        return { repoPath: repo.path, branch: wt.branch }
      }
    }
  }
  return null
}

/** Load the active worktree's spec changes; null while unknown/none. */
export function useSpecBranchChanges(cwd: string | undefined): {
  target: SpecTarget | null
  changes: SpecBranchChangeWire[] | null
} {
  const { trpc, repos } = useStore()
  const target = useMemo(() => (cwd ? resolveSpecTarget(repos, cwd) : null), [repos, cwd])
  const [changes, setChanges] = useState<SpecBranchChangeWire[] | null>(null)
  useEffect(() => {
    setChanges(null)
    if (!target) return
    let cancelled = false
    void trpc.specs.branchDiff
      .query({ repoPath: target.repoPath, branch: target.branch })
      .then((r) => {
        if (!cancelled) setChanges(r.changes as SpecBranchChangeWire[])
      })
      .catch(() => {
        if (!cancelled) setChanges([])
      })
    return () => {
      cancelled = true
    }
  }, [trpc, target])
  return { target, changes }
}

export function SpecDockPanel({
  target,
  changes,
}: {
  target: SpecTarget
  changes: SpecBranchChangeWire[]
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <GitBranch size={12} aria-hidden="true" />
        <span className="min-w-0 truncate" title={target.branch}>
          {target.branch}
        </span>
        <span className="ml-auto flex-none">{changes.length} component(s)</span>
      </div>
      <div className="flex-none border-b border-border px-2">
        <SpecDiffMiniTree
          changes={changes}
          onSelect={(id) =>
            document
              .getElementById(`spec-diff-${id}`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SpecDiffCards changes={changes} />
      </div>
    </div>
  )
}
