import type { SessionView } from '@podium/client-core/session-values'
import { type OutcomeIssueFacts, type SessionIssueOutcome, sessionIssueOutcome } from '@podium/client-core/values'
import { companion, lazy } from '@podium/mobx-helpers'
import { compareStructural } from 'mobx'
import { asIssueId, type IssueId, type MachineWire, machinePathAncestors, machinePathSeparator } from '@podium/model/browser'
import { omitGone } from './lookup'
import type { IssueModel, SessionModel } from './models'
import type { MobxPool } from './pool'
import { eligiblePaneIssue, loadedPaneSession, paneHasSessions, paneMachines, paneSpawnConfirmed, paneWindow } from './session-pane'
import type { SessionPaneRows } from './session-pane-schema'
import { LOADING, type Loaded } from './worklist/rollup'
import { worklistView } from './worklist/view-model'

const EMPTY_WINDOW: SessionPaneRows['sessionPaneWindow'] = { panelMode: {}, dockShells: {}, reposLoaded: false }

/** The session pane's rules over one shared session: what the pane stamps and
 * shows of it. Reads the session's own scalar fields, so a heartbeat (a new
 * row with only activity changed) re-runs none of them. */
export class PaneSession {
  constructor(readonly session: SessionModel, private readonly pool: MobxPool) {}

  /** The loaded display row is here (`LOADING` while its batched load runs).
   * One row read; an equal answer stops a heartbeat at this field. */
  @lazy get present(): Loaded<boolean> {
    const row = omitGone(this.pool.row('session', this.session.id))
    return row === LOADING ? LOADING : row !== undefined
  }
  /** Explicit attachment wins. Checkout candidates are reached through the
   * schema's existing inverse buckets, never a scan or a separate ownership map.
   * These are the same exact slash boundaries the old pane tested. */
  @lazy get stampIssue(): Loaded<IssueModel> {
    if (this.present !== true) return this.present === LOADING ? LOADING : undefined
    const { issueId, cwd } = this.session
    if (issueId) {
      const attached = eligiblePaneIssue(this.pool, issueId)
      if (attached === LOADING) return LOADING
      if (attached) return this.loadedIssue(issueId)
    }
    const paths = machinePathSeparator(cwd) === '\\' ? machinePathAncestors(cwd) : [cwd]
    if (machinePathSeparator(cwd) === '/') for (let at = cwd.lastIndexOf('/'); at >= 0; at = cwd.lastIndexOf('/', at - 1)) {
      paths.push(cwd.slice(0, at))
      if (at === 0) break
    }
    for (const path of paths) {
      for (const id of this.pool.relations.many('worktree', path, 'issues')) {
        const candidate = eligiblePaneIssue(this.pool, id)
        if (candidate === LOADING) return LOADING
        if (candidate) return this.loadedIssue(id)
      }
    }
    return undefined
  }

  /** The issue's ending, when closing it is what stopped this session
   * (POD-2151): the pane trades its Hibernated bar for it and closes the
   * transcript with it. Only the attached issue counts; a checkout match is
   * not the issue that stopped the session. */
  @lazy({ equals: compareStructural }) get issueOutcome(): SessionIssueOutcome | null {
    const { issueId } = this.session
    if (!issueId) return null
    const issue = omitGone(this.pool.model('issue', issueId))
    if (!issue || issue === LOADING) return null
    const outcome = sessionIssueOutcome(this.session as unknown as SessionView, issue as unknown as OutcomeIssueFacts)
    if (!outcome) return null
    // The sidebar row's own tuck verdicts (POD-2293): Tuck is offered exactly
    // where the row's tuck chip is, and shown done where it can be brought back.
    const row = worklistView(this.pool).knownRow(issueId)
    return { ...outcome, issueId, tuckable: row?.canTuck === true, tucked: row?.canBringBack === true }
  }

  private loadedIssue(id: string): Loaded<IssueModel> {
    // A gone attachment is omitted; a pending payload keeps the stamp loading.
    return omitGone(this.pool.model('issue', id))
  }
}

/** The session panes' shared view: per-session companions, the selected
 * issue's tint and the device's window controls. Runtime implementations stay
 * in the lazily imported pool. Web hooks import only this API's types, so a
 * legacy startup loads no graph/MobX implementation. */
export class SessionPanes {
  readonly pane = companion((session: SessionModel) => new PaneSession(session, this.pool))
  constructor(private readonly pool: MobxPool) {}

  /** The loaded display row, for the screens that still show undeclared fields. */
  session(id: string | undefined): SessionView | undefined {
    return loadedPaneSession(this.pool, id)
  }
  /** The pane companion of a session whose display row is here, by ID. */
  loaded(id: string | null | undefined): PaneSession | undefined {
    if (!id) return undefined
    const pane = this.pane(this.pool.sessionObject(id))
    return pane.present === true ? pane : undefined
  }
  window(): SessionPaneRows['sessionPaneWindow'] {
    const value = paneWindow(this.pool)
    return !value || value === LOADING ? EMPTY_WINDOW : value
  }
  machines(): MachineWire[] { return paneMachines(this.pool) }
  spawnConfirmed(id: string): boolean { return paneSpawnConfirmed(this.pool, id) }
  hasSessions(): boolean { return paneHasSessions(this.pool) }

  // Ownership: the selection, never the pane's session.
  @lazy get selectedIssueId(): IssueId | null {
    const selected = worklistView(this.pool).selectedId
    return selected === null ? null : asIssueId(selected)
  }
}

/** Shared service view, owned by the screen rather than the core pool. */
export function sessionPaneView(pool: MobxPool): SessionPanes {
  return pool.sources.view('sessionPanes', () => new SessionPanes(pool))
}
