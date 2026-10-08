import { companion, lazy } from '@podium/mobx-helpers'
import { compareShallow } from 'mobx'
import { headerView } from './header-views'
import { missionView } from './mission-view'
import { missions } from './mission'
import type { IssueModel } from './models'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** Shell rules over the shared record; no copied issue summary or history list. */
class ShellIssue {
  constructor(readonly issue: IssueModel, private readonly pool: MobxPool) {}
  get id() { return this.issue.id }

  @lazy get known(): Loaded<boolean> {
    const row = this.pool.row('issue', this.id, 'summary')
    if (row === LOADING) { void this.pool.row('issue', this.id); return LOADING }
    return row ? true : undefined
  }
  // Color selection is summary-only, including an archived child of a live
  // mission. The mission itself still demands its full row below.
  @lazy get colorSelectable() { return !this.issue.archived && !this.issue.deletedAt }
  @lazy get color() { return this.issue.color }
  @lazy get parentId() { return this.issue.parentId }
  @lazy private get type() { return this.issue.type ?? 'task' }
  @lazy private get needsPresentSessions() {
    return Boolean(this.issue.isDraftVessel && !this.issue.worktreePath)
  }
  @lazy get emptyDraft(): Loaded<boolean> {
    if (!this.needsPresentSessions) return false
    const present = missionView(this.pool).present(this.id)
    return present === LOADING ? LOADING : !present.length
  }
  @lazy({ equals: compareShallow }) get missionRoot() {
    return { id: this.id, title: this.issue.authoredTitle, type: this.type,
      childCount: this.issue.closeChildren.childCount }
  }
}

/** Only scalar answers and stable companions enter the shell's chrome snapshot. */
export class ShellChrome {
  private readonly issue = companion((issue: IssueModel) => new ShellIssue(issue, this.pool))
  constructor(private readonly pool: MobxPool, private readonly sessionCount: () => number) {}

  readonly colorById = (id: string): ShellIssue | undefined => {
    const value = this.issue(this.pool.issueObject(id))
    return value.known === true ? value : undefined
  }
  @lazy private get colorIssue(): Loaded<ShellIssue> {
    const state = this.pool.row('shellWindow', 'window')
    if (!state || state === LOADING) return LOADING
    if (!state.selectedIssueId) return undefined
    const value = this.issue(this.pool.issueObject(state.selectedIssueId))
    if (value.known === LOADING) return LOADING
    return value.known && value.colorSelectable ? value : undefined
  }
  @lazy private get colorsReady(): Loaded<boolean> {
    let current = this.colorIssue
    if (current === LOADING) return LOADING
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      if (!current.parentId) break
      const parent = this.issue(this.pool.issueObject(current.parentId))
      if (parent.known === LOADING) return LOADING
      current = parent.known ? parent : undefined
    }
    return true
  }
  @lazy private get missionRoot(): Loaded<ShellIssue['missionRoot']> {
    const state = this.pool.row('shellWindow', 'window')
    if (!state || state === LOADING) return LOADING
    const id = missions(this.pool).rootFor(state.selectedIssueId)
    if (id === LOADING) return LOADING
    if (!id) return undefined
    const value = this.issue(this.pool.issueObject(id))
    if (!value.issue.visible) return undefined
    const empty = value.emptyDraft
    return empty === LOADING ? LOADING : empty ? undefined : value.missionRoot
  }
  @lazy({ equals: compareShallow }) get value() {
    const state = this.pool.row('shellWindow', 'window')
    if (!state || state === LOADING) return LOADING
    try {
      const colorIssue = this.colorIssue, missionRoot = this.missionRoot
      if (colorIssue === LOADING || missionRoot === LOADING || this.colorsReady === LOADING)
        return LOADING
      return {
        view: state.view,
        reposLoaded: state.reposLoaded,
        superOpen: state.superOpen,
        paletteOpen: state.paletteOpen,
        selectedIssueId: state.selectedIssueId,
        repoCount: headerView(this.pool).repositoryCount(),
        worktreeCount: headerView(this.pool).worktreeCount(),
        sessionCount: this.sessionCount(),
        colorIssue,
        colorById: this.colorById,
        missionRoot,
      }
    } catch (error) {
      if (error !== LOADING) throw error
      return LOADING
    }
  }
}
