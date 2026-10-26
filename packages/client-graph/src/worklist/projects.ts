import { omitGone } from '../lookup'
import { machinePathsEqual } from '@podium/model/browser'
/** The project list: which registered repos get a sidebar section, in what
 * order. Kept from resident worktree rows alone; no session or issue is read. */
import { observable, observe } from 'mobx'
import { debugName } from '../debug-name'
import type { MobxPool } from '../pool'
import type { SliceWorktree } from '../shared/slice-types'
import { LOADING } from './rollup'
import type { SidebarState } from './sidebar'

/** The pool builds this with its tables, so it sees every worktree row. */
export function projectIndex(pool: MobxPool): ProjectIndex {
  return pool.sources.view('worklist.projects', () => new ProjectIndex(pool))
}

export class ProjectIndex {
  /** Resident project roots: a repo's main checkout not opted out of the list. */
  private readonly roots = observable.set<string>(undefined, { deep: false, name: debugName(() => 'pool.projects.roots') })
  /** Resident worktrees per project index. */
  private readonly counts = observable.map<number | undefined, number>(undefined, { deep: false, name: debugName(() => 'pool.projects.counts') })
  private readonly projectOf = new Map<string, number | undefined>()
  private readonly stop: () => void

  constructor(private readonly pool: MobxPool) {
    this.stop = observe(pool.tables.worktree, change => this.file(change.name))
  }

  dispose(): void {
    this.stop()
    this.roots.clear(); this.counts.clear(); this.projectOf.clear()
  }

  /** TRACKED. The registered projects a layout shows: pinned repos, in pin
   * order, then every other root that still has an unpinned worktree, by
   * project index. */
  registered(state: Pick<SidebarState, 'pinnedRepos' | 'pinnedWorktrees'>): readonly SliceWorktree[] {
    const pinAt = (path: string) => state.pinnedRepos?.findIndex(pinned => machinePathsEqual(pinned, path)) ?? -1
    return [...this.roots]
      .flatMap(path => {
        const row = omitGone(this.pool.row('worktree', path))
        return row === undefined || row === LOADING ? [] : [row]
      })
      .filter(root => pinAt(root.path) >= 0 || this.unpinnedLanes(root.projectIndex, state.pinnedWorktrees ?? []) > 0)
      .sort((a, b) => {
        const ap = pinAt(a.path), bp = pinAt(b.path)
        if (ap >= 0 || bp >= 0) return ap >= 0 && bp >= 0 ? ap - bp : ap >= 0 ? -1 : 1
        return (a.projectIndex ?? 0) - (b.projectIndex ?? 0)
      })
  }

  private unpinnedLanes(project: number | undefined, pinned: readonly string[]): number {
    let count = this.counts.get(project) ?? 0
    for (const path of pinned) {
      const row = omitGone(this.pool.row('worktree', this.pool.queries.registeredWorktreePath(path) ?? path))
      if (row !== undefined && row !== LOADING && (row as SliceWorktree).projectIndex === project) count -= 1
    }
    return count
  }

  private file(path: string): void {
    const value = omitGone(this.pool.row('worktree', path, 'mark'))
    const lane = value === LOADING ? undefined : value as SliceWorktree | undefined
    const had = this.projectOf.has(path), previous = this.projectOf.get(path)
    const count = (index: number | undefined, by: number) => {
      const n = (this.counts.get(index) ?? 0) + by
      if (n) this.counts.set(index, n)
      else this.counts.delete(index)
    }
    if (had !== (lane !== undefined) || previous !== lane?.projectIndex) {
      if (had) count(previous, -1)
      if (lane !== undefined) count(lane.projectIndex, 1)
    }
    if (lane === undefined) this.projectOf.delete(path)
    else this.projectOf.set(path, lane.projectIndex)
    if (lane && machinePathsEqual(lane.path, lane.repoPath) && lane.projectRoot !== false) this.roots.add(path)
    else this.roots.delete(path)
  }
}
