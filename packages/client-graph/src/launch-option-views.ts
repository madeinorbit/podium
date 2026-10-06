import { keyedComputed } from '@podium/mobx-helpers'
import {
  machineViewsFromWire,
  reposToViews,
  usableMachines,
  type RepoNavView,
} from '@podium/client-core/values'
import type { GitRepositoryWire } from '@podium/model'
import { computed } from 'mobx'
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
    const rootKey = keyedComputed(
      'launch.roots',
      (id: string) => {
        const repo = repository(id)
        return JSON.stringify(repo ? [repo.path, ...repo.worktrees.map((tree) => tree.path)] : [])
      },
    )
    const usage = keyedComputed('launch.usage', (key: string) => {
      const [id, match] = JSON.parse(key) as [string, 'exact' | 'within']
      counts.usageQueries++
      return pool.queries.activity({ kind: 'commandRootActivity', roots: JSON.parse(rootKey(id)) as string[], match })
    })
    const pathOrderKey = computed(
      () => JSON.stringify(
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
          .map(({ path }) => path)),
    )
    const paths = computed(() => JSON.parse(pathOrderKey.get()) as string[])
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
    const projectOrderKey = computed(() => {
      const pinned = pins.get().repos
      const values = headerEntities(pool)
        .repositoryGroupIds()
        .flatMap((id) => {
          const repo = project(id)
          return repo && (pinned.includes(repo.path) || repo.worktrees.length)
            ? [{ id, repo, at: usage(JSON.stringify([id, 'exact'])) }]
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
      return JSON.stringify(values.map(value => value.id))
    })
    const projects = computed(() => (JSON.parse(projectOrderKey.get()) as string[])
      .flatMap(id => project(id) ?? []))
    const projectUsage = computed(() => new Map((JSON.parse(projectOrderKey.get()) as string[])
      .flatMap(id => {
        const repo = project(id)
        return repo ? [[repo.path, usage(JSON.stringify([id, 'exact']))] as const] : []
      })))
    const eligibleMachineKey = computed(
      () => JSON.stringify(usableMachines(machineViewsFromWire(machines.get())).map((machine) => machine.id)),
    )
    const recentMachineKey = computed(() => JSON.stringify(pool.queries.latestMachineSession(JSON.parse(eligibleMachineKey.get()) as string[]) ?? null))
    const recentMachine = computed(() => JSON.parse(recentMachineKey.get()) as { machineId: string; createdAt: string } | null)
    const repositoryAt = keyedComputed('launch.repositoryAt', (path: string) =>
      reposToViews(headerEntities(pool).repositoryGroup(path).flatMap(id => {
        const row = pool.row('repository', id) as GitRepositoryWire | undefined
        return row && typeof row !== 'symbol' ? [row] : []
      }))[0])
    const origin = keyedComputed('launch.origin', (path: string) => {
      const hosts = machines.get()
      return { repo: repositoryAt(path), machines: hosts }
    })
    const work = keyedComputed('launch.newWork', (displayUsage: boolean) => {
      const choices = projects.get()
      return {
        machines: machines.get(),
        repos: choices,
        lastUsedByRepo: displayUsage ? projectUsage.get() : EMPTY_USAGE,
        recentMachine: recentMachine.get() ?? undefined,
      }
    })
    return {
      repositories: () => repositories.get(),
      repositoryPaths: () => paths.get(),
      newWork: (displayUsage = true) => work(displayUsage),
      origin: (path: string) => origin(path),
      counts,
      dispose() {
        repository.clear()
        rootKey.clear()
        usage.clear()
        project.clear()
        repositoryAt.clear()
        origin.clear()
        work.clear()
      },
    }
  })
}

const EMPTY_PINS = { repos: [] as readonly string[], worktrees: [] as readonly string[] }
const EMPTY_USAGE = new Map<string, number>()
