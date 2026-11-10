import type { MachineModel, MobxPool } from '@podium/client-graph'
import { observer, useOpeningView } from '@podium/client-graph/react'
import { SettingsRepositories, type SettingsRepository } from '@podium/client-graph/settings-repositories'
import { lazy } from '@podium/mobx-helpers'
import { compareShallow } from 'mobx'
import { FolderGit2, Search } from 'lucide-react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { Button } from '@/components/ui/button'
import { Subsection } from './sections/shared'

export class MachineProjectsView {
  readonly repositories: SettingsRepositories
  constructor(pool: MobxPool, readonly machine: MachineModel) {
    this.repositories = new SettingsRepositories(pool)
  }
  @lazy({ equals: compareShallow }) get projects(): readonly SettingsRepository[] {
    return this.repositories.rows.filter((repo) => repo.checkouts.some((checkout) => checkout.machineId === this.machine.id))
  }
}

export const MachineProjects = observer(function MachineProjects({ machine, onFind }: {
  machine: MachineModel; onFind?: () => void
}) {
  const view = useOpeningView(useWorklistPool(), (pool) => new MachineProjectsView(pool, machine))
  return <Subsection title="Projects on this machine">
    {onFind && <div className="mb-3 flex justify-end"><Button type="button" variant="ghost" size="sm" onClick={onFind}>
      <Search size={14} aria-hidden="true" />Find repositories
    </Button></div>}
    <div className="divide-y divide-border rounded-lg border border-border">
      {!view?.repositories.loaded ? <p className="settings-prose px-4 py-4" role="status">Loading projects…</p>
        : view.projects.length === 0 ? <div className="px-4 py-4">
          <p className="settings-label">No projects here yet</p>
          <p className="settings-prose mt-1">Look for git repositories on this machine.</p>
        </div> : view.projects.map((repo) => <MachineProject key={repo.key} repo={repo} machine={machine} />)}
    </div>
  </Subsection>
})

const MachineProject = observer(function MachineProject({ repo, machine }: { repo: SettingsRepository; machine: MachineModel }) {
  return <div className="flex min-w-0 items-start gap-3 px-4 py-4">
    <FolderGit2 size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div className="min-w-0">
      <p className="settings-label">{repo.name}{repo.prefix && <span className="settings-micro ml-2 font-mono text-muted-foreground">{repo.prefix}</span>}</p>
      {repo.checkouts.filter((checkout) => checkout.machineId === machine.id).map((checkout) =>
        <p key={checkout.scan.id} className="settings-prose mt-1 break-all font-mono">{checkout.path}</p>)}
    </div>
  </div>
})
