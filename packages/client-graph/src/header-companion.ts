import { lazy, companion } from '@podium/mobx-helpers'
import type { SessionModel } from './models'
import type { MobxPool } from './pool'
import { headerDockSession, headerHostSession, headerWorkingSession } from './header-session'
import { LOADING } from './worklist/rollup'

/** The header has its own presentation rules, independent of the worklist. */
export class HeaderSession {
  constructor(readonly session: SessionModel) {}
  get id() { return this.session.id }
  @lazy
  get working(): boolean {
    return this.headerWorkingPresent && !this.session.archived
  }
  @lazy
  private get headerWorkingPresent(): boolean {
    return this.session.known && this.session.computingFresh
  }

  // Header presentation

  get headerWorking(): NonNullable<ReturnType<typeof headerWorkingSession>> | null {
    if (!this.headerWorkingPresent) return null
    return this.headerWorkingEvidence
  }

  /** Evidence is retained across expiry so a clock rewind can restore it. */
  get headerWorkingEvidence(): NonNullable<ReturnType<typeof headerWorkingSession>> | null {
    if (!this.session.known || this.session.computingDeadline === undefined) return null
    return this.headerWorkingFields
  }

  /** Legacy readers can still ask for these fields individually. Display leaves use session. */
  @lazy
  get headerWorkingFields(): NonNullable<ReturnType<typeof headerWorkingSession>> {
    const model = this
    return {
      get sessionId() { return model.headerWorkingSessionId },
      get title() { return model.title },
      get name() { return model.name },
      get displayRef() { return model.displayRef },
      get agentKind() { return model.agentKind },
    }
  }

  @lazy
  private get headerWorkingSessionId(): NonNullable<ReturnType<typeof headerWorkingSession>>['sessionId'] {
    return this.session.sessionId
  }

  @lazy
  get title(): NonNullable<ReturnType<typeof headerWorkingSession>>['title'] {
    return this.session.title
  }

  @lazy
  get name(): NonNullable<ReturnType<typeof headerWorkingSession>>['name'] {
    return this.session.name
  }

  @lazy
  get displayRef(): NonNullable<ReturnType<typeof headerWorkingSession>>['displayRef'] {
    return this.session.displayRef
  }

  @lazy
  get agentKind(): NonNullable<ReturnType<typeof headerWorkingSession>>['agentKind'] {
    return this.session.agentKind
  }

  @lazy
  private get headerHostPresent(): boolean {
    return this.session.known &&
      ['live', 'starting', 'reconnecting'].includes(this.session.status)
  }

  get headerHost(): NonNullable<ReturnType<typeof headerHostSession>> | null {
    if (!this.headerHostPresent) return null
    const model = this
    return {
      get cwd() { return model.headerHostCwd },
      get machineId() { return model.headerHostMachineId },
      get archived() { return model.headerHostArchived },
      get status() { return model.headerHostStatus },
      get phase() { return model.headerHostPhase },
      get resumable() { return model.headerHostResumable },
    }
  }

  @lazy
  private get headerHostCwd(): NonNullable<ReturnType<typeof headerHostSession>>['cwd'] {
    return this.session.cwd
  }

  @lazy
  private get headerHostMachineId(): NonNullable<ReturnType<typeof headerHostSession>>['machineId'] {
    return this.session.machineId
  }

  @lazy
  private get headerHostArchived(): NonNullable<ReturnType<typeof headerHostSession>>['archived'] {
    return this.session.archived === true
  }

  @lazy
  private get headerHostStatus(): NonNullable<ReturnType<typeof headerHostSession>>['status'] {
    return this.session.status
  }

  @lazy
  private get headerHostPhase(): NonNullable<ReturnType<typeof headerHostSession>>['phase'] {
    return this.session.agentState?.phase
  }

  @lazy
  private get headerHostResumable(): NonNullable<ReturnType<typeof headerHostSession>>['resumable'] {
    return this.session.resumable === true
  }

  @lazy
  private get headerDockPresent(): boolean {
    return this.session.known
  }

  get headerDock(): NonNullable<ReturnType<typeof headerDockSession>> | undefined {
    if (!this.headerDockPresent) return undefined
    const model = this
    return {
      get sessionId() { return model.headerDockSessionId },
      get issueId() { return model.headerDockIssueId },
      get cwd() { return model.headerDockCwd },
      get machineId() { return model.headerDockMachineId },
      get archived() { return model.headerDockArchived },
      get lastActiveAt() { return model.headerDockLastActiveAt },
    }
  }

  @lazy
  private get headerDockSessionId(): NonNullable<ReturnType<typeof headerDockSession>>['sessionId'] {
    return this.session.sessionId
  }

  @lazy
  private get headerDockIssueId(): NonNullable<ReturnType<typeof headerDockSession>>['issueId'] {
    return this.session.issueId
  }

  @lazy
  private get headerDockCwd(): NonNullable<ReturnType<typeof headerDockSession>>['cwd'] {
    return this.session.cwd
  }

  @lazy
  private get headerDockMachineId(): NonNullable<ReturnType<typeof headerDockSession>>['machineId'] {
    return this.session.machineId
  }

  @lazy
  private get headerDockArchived(): NonNullable<ReturnType<typeof headerDockSession>>['archived'] {
    return this.session.storedField('archived') as boolean
  }

  @lazy
  private get headerDockLastActiveAt(): NonNullable<ReturnType<typeof headerDockSession>>['lastActiveAt'] {
    return this.session.lastActiveAt
  }

}

export class HeaderModel {
  constructor(private readonly pool: MobxPool) {}
  readonly session = companion((session: SessionModel) => new HeaderSession(session))

  @lazy
  get selectedIssue() {
    const id = this.pool.selection.keys().next().value
    if (!id) return undefined
    const value = this.pool.row('issue', id)
    if (value === LOADING) return LOADING
    if (!value || (value as { deletedAt?: string | null }).deletedAt) return undefined
    return this.pool.model('issue', id)
  }
}

export function headerModel(pool: MobxPool): HeaderModel {
  return pool.sources.view('header.model', () => new HeaderModel(pool))
}
