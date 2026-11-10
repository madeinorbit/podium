import type { MachineModel, MobxPool } from '@podium/client-graph'
import { observer, useOpeningView } from '@podium/client-graph/react'
import {
  SettingsRepositories,
  type SettingsRepository,
} from '@podium/client-graph/settings-repositories'
import { companion, lazy } from '@podium/mobx-helpers'
import { FolderGit2, Search } from 'lucide-react'
import { compareShallow } from 'mobx'
import { useCallback } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { Button } from '@/components/ui/button'
import { Subsection } from './sections/shared'

export class MachineProjectsView {
  readonly repositories: SettingsRepositories
  readonly row = companion((repo: SettingsRepository) => new ProjectOnMachine(repo, this.machine))
  constructor(
    pool: MobxPool,
    readonly machine: MachineModel,
  ) {
    this.repositories = new SettingsRepositories(pool)
  }
  @lazy({ equals: compareShallow }) get projects(): readonly SettingsRepository[] {
    return this.repositories.rows.filter((repo) =>
      repo.checkouts.some((checkout) => checkout.machineId === this.machine.id),
    )
  }
  dispose() {
    this.repositories.dispose()
  }
}

class ProjectOnMachine {
  constructor(
    readonly repo: SettingsRepository,
    private readonly machine: MachineModel,
  ) {}
  @lazy({ equals: compareShallow }) get checkouts() {
    return this.repo.checkouts.filter((checkout) => checkout.machineId === this.machine.id)
  }
}

export const MachineProjects = observer(function MachineProjects({
  machine,
  onFind,
}: {
  machine: MachineModel
  onFind?: () => void
}) {
  const create = useCallback((pool: MobxPool) => new MachineProjectsView(pool, machine), [machine])
  const view = useOpeningView(useWorklistPool(), create)
  return (
    <Subsection title="Projects on this machine">
      {onFind && (
        <div className="mb-3 flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onFind}>
            <Search size={14} aria-hidden="true" />
            Find repositories
          </Button>
        </div>
      )}
      <div className="settings-list">
        {!view?.repositories.loaded ? (
          <p className="settings-list-note settings-prose" role="status">
            Loading projects…
          </p>
        ) : view.projects.length === 0 ? (
          <div className="settings-list-note">
            <p className="settings-label">No projects here yet</p>
            <p className="settings-prose mt-1">Look for git repositories on this machine.</p>
          </div>
        ) : (
          view.projects.map((repo) => <MachineProject key={repo.key} view={view.row(repo)} />)
        )}
      </div>
    </Subsection>
  )
})

const MachineProject = observer(function MachineProject({ view }: { view: ProjectOnMachine }) {
  const repo = view.repo
  return (
    <div className="settings-list-row flex min-w-0 items-start gap-3">
      <FolderGit2 size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="settings-label">
          {repo.name}
          {repo.prefix && (
            <span className="settings-micro ml-2 font-mono text-muted-foreground">
              {repo.prefix}
            </span>
          )}
        </p>
        {view.checkouts.map((checkout) => (
          <p key={checkout.scan.id} className="settings-prose mt-1 break-all font-mono">
            {checkout.path}
          </p>
        ))}
      </div>
    </div>
  )
})
