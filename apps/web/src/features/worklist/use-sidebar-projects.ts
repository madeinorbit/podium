import type { Store } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/store'
import type { SidebarProject, SidebarSections } from '@podium/client-core/values'
import type { LOADING, MobxPool } from '@podium/client-graph'
import type { SliceWorktree } from '@podium/client-graph/shared/slice-types'
import type { SidebarState } from '@podium/client-graph/worklist/sidebar'

import { useCallback } from 'react'
import { useRuntimeSelector } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

const EMPTY_PROJECTS: SidebarProject[] = []
const EMPTY_SECTIONS: SidebarSections = { pinnedRepos: [], repos: [], pinnedWorktrees: [] }
const selectLayout = (s: Store) => ({
  projectOrder: s.sidebarSettings.repoOrder,
  pinnedRepos: s.pins.repos,
  pinnedWorktrees: s.pins.worktrees,
})

function useLayout(): SidebarState {
  return useRuntimeSelector(selectLayout, shallowEqual)
}

export function useSidebarProjects(): SidebarProject[] {
  const layout = useLayout()
  const read = useCallback(
    (pool: MobxPool) =>
      pool.sidebar.sections(layout).bands.map((band) => ({
        key: band.key,
        name: band.label,
        aliases: [...band.aliases],
      })),
    [layout],
  )
  return useWorklistPoolProjection(read, EMPTY_PROJECTS)
}

export function useSidebarProjectSections(): SidebarSections {
  const layout = useLayout()
  const read = useCallback(
    (pool: MobxPool): SidebarSections => {
      const lanes = [...pool.tables.worktree.keys()].flatMap((path) => {
        const row = pool.row('worktree', path) as SliceWorktree | typeof LOADING | undefined
        return row && typeof row === 'object' ? [row] : []
      })
      const worktrees = lanes.map((lane) => ({
        ...lane,
        isMain: lane['isMain'] === true,
        issues: [],
        sessions: [...pool.graph.many('worktree', String(lane['path']), 'sessions')].flatMap(
          (id) => {
            const row = pool.row('session', id)
            return row && typeof row === 'object' ? [row as unknown as SessionView] : []
          },
        ),
      })) as SidebarSections['pinnedWorktrees']
      const projects = pool.sidebar.sections(layout).bands.flatMap((band) => {
        const lane = lanes.find(
          (row) =>
            row['projectRoot'] && band.aliases.includes(String(row['repoId'] ?? row['repoPath'])),
        )
        return lane
          ? [
              {
                path: band.repoPath,
                name: band.label,
                ...(lane['repoId'] ? { repoId: lane['repoId'] } : {}),
                worktrees: worktrees.filter(
                  (tree) =>
                    tree.repoPath === band.repoPath && !layout.pinnedWorktrees?.includes(tree.path),
                ),
              },
            ]
          : []
      }) as SidebarSections['repos']
      return {
        pinnedRepos: projects.filter((repo) => layout.pinnedRepos?.includes(repo.path)),
        repos: projects.filter((repo) => !layout.pinnedRepos?.includes(repo.path)),
        pinnedWorktrees: worktrees.filter((tree) => layout.pinnedWorktrees?.includes(tree.path)),
      }
    },
    [layout],
  )
  return useWorklistPoolProjection(read, EMPTY_SECTIONS)
}
