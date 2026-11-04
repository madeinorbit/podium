import { here, omitGone } from '../lookup'
import { observable, observableRef, action, compareShallow } from 'mobx'
import { lazy, companion } from '@podium/mobx-helpers'
import type { IssueModel, ModelHost, SessionModel } from '../models'
import type { MobxPool } from '../pool'
import type { MemberModel } from '../requested-models'
import type { LocalsKey, SliceLocals } from '../shared/slice-types'
import { worklistGroups } from './groups'
import { WorklistIssue } from './issue'
import { WorklistSession } from './session'
import { SidebarIndex, type SidebarState } from './sidebar'
import { MobileSectionsView } from './mobile'
import { PhoneWorklist } from './phone'
import { LOADING, type RollupInputs, type RollupParts } from './rollup'

/**
 * THE ROSTER FACTS THE ALWAYS-ON WORKLIST READS (POD-6294; startup split in
 * POD-6299). Which members the directory lists and who the viewer is: the
 * sidebar's personal rule and owner badges need these at first paint. The
 * directory read itself (`member-roster.ts`, a request answer followed while
 * visible) is optional screen code and loads behind the views that ask for it;
 * it writes its answer here. Until it has, the instance reads as one member,
 * which is the former rule.
 */
export class RosterFacts {
  @observableRef accessor memberIds: readonly string[] = []
  @observableRef accessor currentMemberId: string | undefined = undefined
  constructor(private readonly pool: MobxPool) {}

  /** The active members, in the directory's order (earliest first). */
  @lazy({ equals: compareShallow }) get members(): MemberModel[] {
    return this.memberIds.flatMap(id => {
      const member = here(this.pool.model('member', id))
      return member && !member.disabledAt ? [member] : []
    })
  }

  /** Two or more active members: the multi-user task rules apply. */
  @lazy get shared(): boolean { return this.members.length > 1 }

  /** Display names two or more active members share (POD-6295). */
  @lazy({ equals: compareShallow }) get sharedNames(): string[] {
    const counts = new Map<string, number>()
    for (const member of this.members) {
      const name = member.displayName?.trim()
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts].filter(([, count]) => count > 1).map(([name]) => name).sort()
  }

  /**
   * A member's display name, or undefined while unknown (not loaded, or not an
   * active member any more). A name another active member also uses carries a
   * short tag from the member id, `Sam (k3f9)`, so two people never read as
   * one. Never the email: another member's email is the admins' (MU-13).
   */
  nameOf(id: string | null | undefined): string | undefined {
    if (!id) return undefined
    const name = here(this.pool.model('member', id))?.displayName?.trim() || undefined
    return name && this.sharedNames.includes(name) ? `${name} (${memberTag(id)})` : name
  }

  @action accept(memberIds: readonly string[], currentMemberId: string): void {
    this.memberIds = memberIds
    this.currentMemberId = currentMemberId
  }
}

/** The short, stable tag that tells two same-named members apart. */
export function memberTag(id: string): string { return id.replace(/^mem_/, '').slice(-4) }

/** The pool's one set of roster facts. */
export function rosterFacts(pool: MobxPool): RosterFacts {
  return pool.sources.view('members.rosterFacts', () => new RosterFacts(pool))
}

/** One view of the worklist, drawn by the desktop sidebar and phone Work tab. */
export class Worklist {
  readonly row: (issue: IssueModel) => WorklistIssue = companion(issue => new WorklistIssue(issue, this))
  readonly session: (session: SessionModel) => WorklistSession = companion(session => new WorklistSession(session))
  @observable accessor selectedId: string | null = null
  @observable accessor selectedWasFolded = false

  @lazy get selectionGone(): boolean {
    if (this.selectedId === null) return false
    try { return this.pool.issueObject(this.selectedId).exitKind !== undefined }
    catch (error) { if (error === LOADING) return false; throw error }
  }
  @observableRef accessor layout: SidebarState = {}

  /**
   * THE SIDEBAR IS PERSONAL (POD-6294; design §2.2, D3). On an instance with
   * two or more members a row is the viewer's only when the task is in their
   * personal set (POD-6290): started, joined, or assigned to them and not
   * dismissed. Seeing, searching or opening a task adds nothing. On a
   * one-member instance every task is already in that set, so the gate is off
   * and the worklist keeps its exact former rule.
   */
  @lazy get personalOnly(): boolean {
    return rosterFacts(this.pool).shared
  }

  /** The viewer's member id once the roster knows it; display only. */
  @lazy get viewerMemberId(): string | undefined {
    return rosterFacts(this.pool).currentMemberId
  }
  readonly host: ModelHost
  readonly desktop: SidebarIndex
  readonly rowInputs: RollupInputs = {
    reached: at => this.pool.rollupInputs.reached!(at),
    loadedIssue: id => this.pool.rollupInputs.loadedIssue(id),
    spinOffCount: id => this.pool.rollupInputs.spinOffCount(id),
    nested: id => this.row(this.pool.issueObject(id)).visibleDescendantIds,
    formalChildren: id => this.pool.rollupInputs.formalChildren(id),
    rollupNode: (id): RollupParts | undefined => this.knownRow(id)?.visibleParts,
    seat: id => this.pool.rollupInputs.seat(id),
    seatActivity: id => this.pool.rollupInputs.seatActivity(id),
    spinOffIds: id => this.pool.rollupInputs.spinOffIds(id),
  }
  readonly mobileSectionsView: MobileSectionsView
  readonly phone: PhoneWorklist

  constructor(readonly pool: MobxPool) {
    this.host = pool
    this.desktop = new SidebarIndex(this)
    this.mobileSectionsView = new MobileSectionsView(pool)
    this.phone = new PhoneWorklist(this)
  }

  @action select(id: string | null): void {
    if (id === this.selectedId) return
    let folded = false
    if (id !== null) {
      try { folded = worklistGroups(this.pool).placementOf(id)?.closed === true }
      catch (error) {
        // A cold command summary may not license every placement field.
        // Its addressed load is queued; selection must still move immediately.
        if (error !== LOADING) throw error
      }
    }
    this.selectedWasFolded = folded
    this.selectedId = id
  }

  @action setLayout(layout: SidebarState): void { this.layout = layout }
  @action setFolded(folded: boolean): void { this.selectedWasFolded = folded }

  /** Standalone replay sources can supply selection. Runtime selection is
   * adopted by the worklist instead, and that source carries only the clock. */
  @action applyLocals(locals: SliceLocals, changed: ReadonlySet<LocalsKey>): void {
    if (changed.has('selectedIssueId')) this.select(locals.selectedIssueId)
    if (changed.has('selectedIssueWasFolded')) this.setFolded(locals.selectedIssueWasFolded === true)
  }
  sections(state: SidebarState = this.layout) { return this.desktop.sections(state) }
  mobileSections() { return this.mobileSectionsView }
  desktopRow(id: string) { return this.desktop.row(id) }
  mobileRow(id: string): WorklistIssue | typeof LOADING | undefined {
    const issue = here(this.pool.issue(id))
    if (!issue) return omitGone(this.pool.row('issue', id)) === LOADING ? LOADING : undefined
    const row = this.row(issue), ready = row.ready
    return ready === 'ready' ? row : ready
  }

  knownRow(id: string): WorklistIssue | undefined {
    return this.pool.tables.issue.has(id) || this.pool.residency?.known('issue', id) === true
      ? this.row(this.pool.issueObject(id)) : undefined
  }
}

export function worklistView(pool: MobxPool): Worklist {
  return pool.sources.view('worklist.view', () => new Worklist(pool))
}
