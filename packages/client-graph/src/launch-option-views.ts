import { keyedComputed } from '@podium/mobx-helpers'
import {
  machineViewsFromWire,
  reposToViews,
  usableMachines,
  type RepoNavView,
} from '@podium/client-core/values'
import type { GitRepositoryWire } from '@podium/model'
import { computed, compareStructural } from 'mobx'
import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import type { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

/** Open launchers own these computeds. Metadata belongs to one repository
 * group; usage ordering consumes cached scalars, never re-groups worktrees. */
export function launchOptionViews(pool: MobxPool) {
  return pool.sources.view('launch.options', () => {
    const counts = { repositoryBuilds: 0, usageQueries: 0 }
    const repository = keyedComputed('launch.repository', (id: string) => {
      counts.repositoryBuilds++
      const scans = headerEntities(pool)
        .repositoryGroupRoots(id)
        .flatMap((id) => {
          const row = pool.row('repository', id) as GitRepositoryWire | undefined
          return row && typeof row !== 'symbol' ? [row] : []
        })
      return reposToViews(scans)[0]
    })
    const repositories = computed(() =>
      headerEntities(pool)
        .repositoryGroupIds()
        .flatMap((id) => repository(id) ?? []),
    )
    const machines = computed(() => headerView(pool).machines())
    const roots = keyedComputed(
      'launch.roots',
      (id: string) => {
        const repo = repository(id)
        return repo ? [repo.path, ...repo.worktrees.map((tree) => tree.path)] : []
      },
      { equals: compareStructural },
    )
    const usage = keyedComputed('launch.usage', (key: string) => {
      const [id, match] = JSON.parse(key) as [string, 'exact' | 'within']
      counts.usageQueries++
      return pool.queries.activity({ kind: 'commandRootActivity', roots: roots(id), match })
    })
    const paths = computed(
      () =>
        headerEntities(pool)
          .repositoryGroupIds()
          .flatMap((id) => {
            const repo = repository(id)
            return repo ? [{ path: repo.path, at: usage(JSON.stringify([id, 'within'])) }] : []
          })
          .sort(
            (a, b) =>
              b.at - a.at || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }),
          )
          .map(({ path }) => path),
      { equals: compareStructural },
    )
    const pins = computed(() => {
      const row = pool.row('commandWindow', 'window')
      return row && row !== LOADING ? row.pins : EMPTY_PINS
    })
    const project = keyedComputed('launch.project', (id: string): RepoNavView | undefined => {
      const repo = repository(id)
      if (!repo) return undefined
      const pinned = pins.get().worktrees
      return {
        ...repo,
        worktrees: repo.worktrees.flatMap((tree) =>
          pinned.includes(tree.path)
            ? []
            : [{ ...tree, repoName: repo.name, sessions: [], issues: [] }],
        ),
      }
    })
    const projects = computed(() => {
      const pinned = pins.get().repos
      const values = headerEntities(pool)
        .repositoryGroupIds()
        .flatMap((id) => {
          const repo = project(id)
          return repo && (pinned.includes(repo.path) || repo.worktrees.length)
            ? [{ repo, at: usage(JSON.stringify([id, 'exact'])) }]
            : []
        })
      // Pinned order breaks otherwise equal choices, as in the existing menu.
      const pinOrder = new Map(pinned.map((path, at) => [path, at]))
      values.sort(
        (a, b) =>
          b.at - a.at ||
          a.repo.name.localeCompare(b.repo.name, undefined, { sensitivity: 'base' }) ||
          (pinOrder.get(a.repo.path) ?? pinned.length) -
            (pinOrder.get(b.repo.path) ?? pinned.length),
      )
      return values
    })
    const eligibleMachineIds = computed(
      () => usableMachines(machineViewsFromWire(machines.get())).map((machine) => machine.id),
      { equals: compareStructural },
    )
    const recentMachine = computed(
      () => pool.queries.latestMachineSession(eligibleMachineIds.get()),
      { equals: compareStructural },
    )
    const work = computed(() => {
      const choices = projects.get()
      return {
        machines: machines.get(),
        repos: choices.map(({ repo }) => repo),
        lastUsedByRepo: new Map(choices.map(({ repo, at }) => [repo.path, at])),
        recentMachine: recentMachine.get(),
      }
    })
    return {
      repositories: () => repositories.get(),
      repositoryPaths: () => paths.get(),
      newWork: () => work.get(),
      counts,
      dispose() {
        repository.clear()
        roots.clear()
        usage.clear()
        project.clear()
      },
    }
  })
}

const EMPTY_PINS = { repos: [] as readonly string[], worktrees: [] as readonly string[] }
