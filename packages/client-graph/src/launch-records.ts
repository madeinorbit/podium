import './requested-models'
import type { RepoNavView, WorktreeView } from '@podium/client-core/values'
import { lazy, companion } from '@podium/mobx-helpers'
import { machinePathKey, machinePathsEqual, normalizeOriginUrl, repoNameFromOrigin, machinePathBasename } from '@podium/model/browser'
import { compareShallow } from 'mobx'
import { headerEntities } from './header-entities'
import { here, omitGone } from './lookup'
import { LOADING } from './loading'
import type { MobxPool } from './pool'
import type { RepositoryModel } from './requested-models'

/** Placement is a launcher's rule over a scan, not a copied scan record. */
export class LaunchTree implements WorktreeView {
  constructor(readonly repository: RepositoryModel, readonly path: string, readonly isMain: boolean,
    private readonly pool: MobxPool, private readonly project: LaunchRepository) {}
  @lazy get branch() {
    // The shared lane is authoritative when present; older scan-only catalogs
    // still describe a checkout inside their one shared repository record.
    const lane = here(this.pool.model('worktree', this.path))
    return lane?.branch ?? (this.isMain ? this.repository.branch : this.repository.worktrees.find(tree => machinePathsEqual(tree.path, this.path))?.branch) ?? undefined
  }
  @lazy get repoPath() { return this.repository.path }
  @lazy get repoId() { return this.repository.repoId }
  @lazy get machineId() { return this.repository.machineId }
  @lazy get repoName() { return this.project.name }
  readonly sessions = []
  readonly issues = []
}
export class LaunchRepository implements RepoNavView {
  constructor(readonly id: string, private readonly pool: MobxPool, private readonly projectOnly = false) {}
  @lazy({ equals: compareShallow }) get scans(): RepositoryModel[] {
    return headerEntities(this.pool).repositoryGroupRoots(this.id).flatMap(id => here(this.pool.model('repository', id)) ?? [])
  }
  @lazy get path() { return this.scans[0]?.path ?? '' }
  @lazy get originUrl() { return this.scans.map(scan => normalizeOriginUrl(scan.originUrl)).find(Boolean) }
  @lazy get repoId() { return this.scans.find(scan => scan.repoId !== undefined)?.repoId }
  @lazy get name() { return (this.scans.find(scan => normalizeOriginUrl(scan.originUrl)) ?? this.scans[0])?.name ?? '' }
  @lazy({ equals: compareShallow }) get machines() {
    // Each entry is the shared scan: machineId/path are stored fields, read late.
    return this.scans.filter((scan): scan is RepositoryModel & { machineId: NonNullable<RepositoryModel['machineId']> } => scan.machineId !== undefined)
  }
  @lazy({ equals: compareShallow }) get worktrees(): LaunchTree[] {
    const pins = omitGone(this.pool.row('commandWindow', 'window'))
    const pinned = this.projectOnly && pins && pins !== LOADING ? pins.pins.worktrees : []
    return this.scans.flatMap(scan => [new LaunchTree(scan, scan.path, true, this.pool, this),
      ...scan.worktrees.map(tree => new LaunchTree(scan, tree.path, false, this.pool, this))])
      .filter(tree => !pinned.some(path => machinePathsEqual(path, tree.path)))
  }
}
/** Pool view registry holds companions, never a second catalogue of records. */
export function launchRecords(pool: MobxPool) {
  return pool.sources.view('launch.records', () => {
    const repository = companion((scan: RepositoryModel) => {
      const id = headerEntities(pool).repositoryGroupIds().find(group => headerEntities(pool).repositoryGroupRoots(group).includes(scan.id))
      return new LaunchRepository(id ?? scan.id, pool)
    })
    const project = companion((scan: RepositoryModel) => {
      const id = headerEntities(pool).repositoryGroupIds().find(group => headerEntities(pool).repositoryGroupRoots(group).includes(scan.id))
      return new LaunchRepository(id ?? scan.id, pool, true)
    })
    const group = (id: string, projects = false) => {
      const first = headerEntities(pool).repositoryGroupRoots(id)[0]
      const scan = first ? here(pool.model('repository', first)) : undefined
      return scan ? (projects ? project(scan) : repository(scan)) : undefined
    }
    return {
      group,
      at(path: string) {
        const ids = headerEntities(pool).repositoryGroup(path)
        const scan = ids[0] ? here(pool.model('repository', ids[0])) : undefined
        return scan ? repository(scan) : undefined
      },
      dispose() {},
    }
  })
}
