import './requested-models'
import { lazy, companion } from '@podium/mobx-helpers'
import { compareShallow } from 'mobx'
import { headerEntities } from './header-entities'
import { here } from './lookup'
import type { MobxPool } from './pool'
import type { RepositoryModel } from './requested-models'

/** A settings row is a scan plus the existing logical repository's prefix and base branch. */
export class SettingsRepository {
  constructor(readonly repository: RepositoryModel, private readonly pool: MobxPool) {}
  @lazy get path() { return this.repository.path }
  @lazy get machineId() { return this.repository.machineId }
  @lazy get repoId() { return this.repository.repoId ?? null }
  @lazy get prefix() {
    return this.repository.repoId ? here(this.pool.model('repo', this.repository.repoId))?.prefix ?? null : null
  }
  /** The repo's base branch [POD-2065]; `null` defers to the Podium default. */
  @lazy get defaultParentBranch() {
    return this.repository.repoId ? here(this.pool.model('repo', this.repository.repoId))?.defaultParentBranch ?? null : null
  }
}
export class SettingsRepositories {
  readonly row = companion((repository: RepositoryModel) => new SettingsRepository(repository, this.pool))
  constructor(private readonly pool: MobxPool) {}
  @lazy({ equals: compareShallow }) get rows() {
    return (headerEntities(this.pool).orders.get('repository') ?? [...this.pool.tables.repository.keys()]).flatMap(id => {
      const model = here(this.pool.model('repository', id))
      return model ? [this.row(model)] : []
    })
  }
  dispose() {}
}
