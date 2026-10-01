import { shallowEqual } from '@podium/client-core/store'
import { worklistSlice, type SidebarProject, type SidebarSections } from '@podium/client-core/viewmodels'
import type { MobxPool } from '@podium/client-graph'
import type { SidebarState } from '@podium/client-graph/worklist/sidebar'
import type { SessionMeta } from '@podium/model/browser'
import { useCallback } from 'react'
import { useSlice, useStoreSelector } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { sidebarDataLayer } from '@/lib/sidebar-data-layer'

const EMPTY_PROJECTS: SidebarProject[] = []
const EMPTY_SECTIONS: SidebarSections = { pinnedRepos: [], repos: [], pinnedWorktrees: [] }

function useLayout(): SidebarState {
  return useStoreSelector(s => ({ projectOrder: s.sidebarSettings.repoOrder,
    pinnedRepos: s.pins.repos, pinnedWorktrees: s.pins.worktrees }), shallowEqual)
}

export function useSidebarProjects(): SidebarProject[] {
  if (sidebarDataLayer() === 'legacy') return useSlice(worklistSlice).projects
  const layout = useLayout()
  const read = useCallback((pool: MobxPool) => pool.sidebar.sections(layout).bands.map(band => ({
    key: band.key, name: band.label, aliases: [...band.aliases],
  })), [layout])
  return useWorklistPoolProjection(read, EMPTY_PROJECTS)
}

/** The palette only needs the pool's discovered project/worktree tree.
 * It never subscribes to worklistSlice or re-runs its derivation. */
export function useSidebarProjectSections(): SidebarSections {
  if (sidebarDataLayer() === 'legacy') return useSlice(worklistSlice).sections
  const layout = useLayout()
  const read = useCallback((pool: MobxPool): SidebarSections => {
    const lanes = [...pool.tables.worktree.keys()].flatMap(path => {
      const row = pool.row('worktree', path)
      return row && typeof row === 'object' ? [row] : []
    })
    const worktrees = lanes.map(lane => ({ ...lane, isMain: lane['isMain'] === true, issues: [],
      sessions: [...pool.graph.many('worktree', String(lane['path']), 'sessions')].flatMap(id => {
        const row = pool.row('session', id)
        return row && typeof row === 'object' ? [row as unknown as SessionMeta] : []
      }) })) as SidebarSections['pinnedWorktrees']
    const projects = pool.sidebar.sections(layout).bands.flatMap(band => {
      const lane = lanes.find(row => row['projectRoot'] && band.aliases.includes(String(row['repoId'] ?? row['repoPath'])))
      return lane ? [{ path: band.repoPath, name: band.label,
        ...(lane['repoId'] ? { repoId: lane['repoId'] } : {}),
        worktrees: worktrees.filter(tree => tree.repoPath === band.repoPath && !layout.pinnedWorktrees?.includes(tree.path)) }] : []
    }) as SidebarSections['repos']
    return { pinnedRepos: projects.filter(repo => layout.pinnedRepos?.includes(repo.path)),
      repos: projects.filter(repo => !layout.pinnedRepos?.includes(repo.path)),
      pinnedWorktrees: worktrees.filter(tree => layout.pinnedWorktrees?.includes(tree.path)) }
  }, [layout])
  return useWorklistPoolProjection(read, EMPTY_SECTIONS)
}
