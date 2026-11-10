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
import { EntityRow, Section } from './sections/shared'

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
    <Section
      title="Projects on this machine"
      list
      action={
        onFind && (
          <Button type="button" variant="ghost" size="sm" onClick={onFind}>
            <Search size={14} aria-hidden="true" />
            Find repositories
          </Button>
        )
      }
    >
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
    </Section>
  )
})

const MachineProject = observer(function MachineProject({ view }: { view: ProjectOnMachine }) {
  return (
    <EntityRow
      leading={
        view.repo.prefix ? (
          <span className="font-mono">{view.repo.prefix}</span>
        ) : (
          <FolderGit2 size={16} aria-hidden="true" />
        )
      }
      title={view.repo.name}
      subtitle={view.checkouts.map((checkout) => (
        <div key={checkout.scan.id} className="break-all">
          {checkout.path}
        </div>
      ))}
      monoSubtitle
    />
  )
})
