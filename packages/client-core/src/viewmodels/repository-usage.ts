import type { SessionMeta } from '@podium/model'
import { recordSliceDerivation } from '../perf/store-stats'

type UsageSession = Pick<SessionMeta, 'agentKind' | 'cwd' | 'lastActiveAt'>
type Material = { cwd: string; lastActiveAt: string }

/** Component-local, single-snapshot cache. Never shares session scope across stores.
 * Shells alone are excluded, exactly as sidebarSessions does. Session identity,
 * machine, archive state and agent activity are deliberately not usage inputs.
 */
export function createRepositoryUsageSelector() {
  let source: readonly UsageSession[] | undefined
  let material: Material[] = []
  let usage: ReadonlyMap<string, number> = new Map()
  const select = (sessions: readonly UsageSession[]): ReadonlyMap<string, number> => {
    if (sessions === source) return usage
    recordSliceDerivation(select, 'repositoryUsage.materialScan')
    const next: Material[] = []
    let changed = source === undefined
    for (const session of sessions) {
      if (session.agentKind === 'shell') continue
      const { cwd, lastActiveAt } = session
      const previous = material[next.length]
      if (previous?.cwd === cwd && previous.lastActiveAt === lastActiveAt) {
        next.push(previous)
      } else {
        changed = true
        next.push({ cwd, lastActiveAt })
      }
    }
    source = sessions
    if (!changed && next.length === material.length) return usage
    material = next
    recordSliceDerivation(select, 'repositoryUsage.indexBuild')
    const index = new Map<string, number>()
    for (const { cwd, lastActiveAt } of material) {
      const time = Date.parse(lastActiveAt) || 0
      if (time <= 0) continue
      const add = (path: string) => {
        if (time > (index.get(path) ?? 0)) index.set(path, time)
      }
      add(cwd)
      // Exact prefixes before EVERY slash preserve repoUsageAt's literal
      // `cwd === root || cwd.startsWith(root + '/')`, even for trailing slashes.
      for (let slash = cwd.indexOf('/'); slash !== -1; slash = cwd.indexOf('/', slash + 1)) {
        add(cwd.slice(0, slash))
      }
    }
    usage = index
    return usage
  }
  return select
}

/** Same max over root and linked worktrees as repoUsageAt, without a world scan. */
export function indexedRepoUsageAt(
  repo: { path: string; worktrees: readonly { path: string }[] },
  usage: ReadonlyMap<string, number>,
): number {
  let max = usage.get(repo.path) ?? 0
  for (const worktree of repo.worktrees) max = Math.max(max, usage.get(worktree.path) ?? 0)
  return max
}
