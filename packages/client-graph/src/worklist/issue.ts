import { omitGone } from '../lookup'
import { parseMs } from '../views'
import { compareShallow, compareStructural, untracked } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import { type RowOriginTick, type RowRank, type RowView, isDraftNameSession } from '../shared/row-view'
import type { SliceIssue, SlicePhase, SliceSession } from '../shared/slice-types'
import { isExcluded } from '../shared/predicates'
import { activityAtOf, ownPartOfRow, displayTitleOf, type Label, loadingPartOf, NO_ROLLUP,
  type OwnPart, originIdPartOf, originTickPartOf, rankOfPart, sessionIdsPartOf } from '../views'
import { type Placement, placementOfPart, withWaiting } from './groups'
import { NO_SEATS, type SeatSummary } from './seat-verdicts'
import { type Aggregate, ownAttentionFields, unitOwnFields, unitsBelowFields,
  LOADING, type OwnAttention, type OwnFacts, type Rollup, rollupPartOf, phaseOf, askingOf,
  seatActivityPartOf, tipPartOf, type UnitOwn, type Units, waitingPartOf } from './rollup'
import { NO_SIDEBAR_SESSIONS, sidebarLifecycle, sidebarTimingFromFacts, type SidebarRowValues, type SidebarProgress, type SidebarSessionFacts } from './sidebar-row'
import type { SidebarOwner } from './sidebar-roster'
import { sidebarBelowOf, sidebarNestedOf } from './sidebar'
import { mobileWaitingCount, type MobileRowValues } from './mobile-row'
import { childIdsPartOf, type HeldIssue, type HiddenIssue, hiddenPresenceOf, keptBelowPartOf,
  laneMemberIdsPartOf, memberIdsPartOf, nestCandidatePartOf, nestParentPartOf,
  flatPartOf, keepsPartOf, retainedSeatIdsPartOf, rosterIdsPartOf, openOwnPartOf, nestBelowPartOf, nestedPartOf,
  laneRetainedSeatIdsPartOf, mergeIds, standingOf, type Standing, spinOffIdsPartOf } from './visible'
import type { IssueModel, ModelHost } from '../models'
import type { Worklist } from './view-model'
import { AttentionFields } from './attention'

/** One worklist's rules for the shared issue; desktop and phone borrow this object. */
export class WorklistIssue implements HeldIssue, RowView {
  constructor(readonly issue: IssueModel, readonly worklist: Worklist) {}
  get id(): string { return this.issue.id }
  get visible(): boolean { return this.issue.visible }
  private get host(): ModelHost { return this.worklist.host }

  // Constant owned helpers; their answers are lazy and release their own data.
  private readonly filingAttention = new AttentionFields(this, () => this.worklist.host.rollupInputs)
  private readonly visibleAttentionFields = new AttentionFields(this, () => this.worklist.rowInputs)

  // Presence and sidebar placement

  /** Shared fields read the resident slot; cold sidebar rules keep their own summary input. */
  private residentIssue(): SliceIssue | undefined {
    const row = omitGone(this.host.row('issue', this.id, 'mark'))
    return row === LOADING ? this.host.visibleInputs.issueRow(this.id) : row as SliceIssue | undefined
  }

  @lazy
  private get hasStanding(): boolean {
    return this.residentIssue() !== undefined
  }

  @lazy({ equals: compareStructural }) get rosterOwner(): SidebarOwner {
    return { represented: this.placed, excluded: this.issue.excluded,
      finishAt: this.issue.finished ? this.issue.finishedMs : undefined }
  }

  private readStanding(): Standing | undefined {
    const row = this.residentIssue()
    if (row === undefined) return undefined
    const issue = this.issue, work = this
    return standingOf(row, {
      get excluded() { return (work.issue.excluded) }, get finished() { return issue.finished ?? false },
      get awaitingMerge() { return (work.issue.awaitingMerge) }, get parentId() { return issue.parentRef },
      get finishedMs() { return issue.finishedMs }, get updatedMs() { return issue.updatedMs },
      get formalParent() { return issue.formalParent },
      get replicaActivityMs() { return parseMs(issue.lastActivityAt) },
      get headlessStaffed() { return issue.headlessStaffed },
    })
  }

  private readOwn(): OwnPart | undefined {
    const row = this.residentIssue()
    return row === undefined ? undefined : ownPartOfRow(row, this.host.inputs, this.issue)
  }

  @lazy({ equals: compareStructural })
  get rank(): RowRank | undefined {
    const part = this.own
    return part === undefined ? undefined : rankOfPart(this.id, part)
  }

  /** R2's already judged summary, without enumerating its seat history. */
  private get explicitSeats(): SeatSummary | undefined {
    const input = this.host.visibleInputs
    return input.seatSummary === undefined
      ? undefined
      : input.seatList(this.id).length === 0 ? NO_SEATS : input.seatSummary(this.id)
  }

  @lazy({ equals: compareShallow }) private get laneRetainedSeatIds(): readonly string[] {
    return laneRetainedSeatIdsPartOf(this.host.visibleInputs, this.id, this.standing, this.laneMemberIds)
  }

  @lazy({ equals: compareShallow }) get retainedSeatIds(): readonly string[] {
    const summary = this.explicitSeats
    if (this.standing !== undefined && summary !== undefined && this.laneMemberIds.length === 0) return summary.retained
    if (this.standing === undefined) return []
    return summary === undefined ? retainedSeatIdsPartOf(this.host.visibleInputs, this.id, this.standing, this.memberIds)
      : mergeIds(summary.retained, this.laneRetainedSeatIds)
  }

  // R2 owns the list: pass through its identity, with no copied ID snapshot.
  @lazy({ equals: compareShallow }) get rosterIds(): readonly string[] {
    const summary = this.explicitSeats
    if (this.standing !== undefined && summary !== undefined && this.laneMemberIds.length === 0) return summary.roster
    if (this.standing === undefined) return []
    return summary === undefined ? rosterIdsPartOf(this.host.visibleInputs, this.retainedSeatIds)
      : mergeIds(summary.roster, rosterIdsPartOf(this.host.visibleInputs, this.laneRetainedSeatIds))
  }

  @lazy
  get retained(): boolean {
    const standing = this.standing
    return standing !== undefined && !standing.excluded && this.retainedSeatIds.length > 0
  }

  @lazy
  get liveRoster(): boolean {
    return this.rosterIds.length > 0
  }

  @lazy
  get openOwn(): boolean {
    const summary = this.explicitSeats
    return summary === undefined
      ? openOwnPartOf(this.host.visibleInputs, this.id, this.seatIds, this.standing)
      : summary.present > 0 || this.standing?.headlessStaffed === true
  }

  @lazy
  get flat(): boolean {
    return this.hidden === undefined && flatPartOf(this.host.visibleInputs, this.id, this)
  }

  @lazy
  get keeps(): boolean {
    const hidden = this.hidden
    return hidden === undefined
      ? keepsPartOf(this.host.visibleInputs, this.id, this)
      : hiddenPresenceOf(this.host.visibleInputs, this.id, hidden, this).keeps
  }

  @lazy
  get present(): boolean {
    if (this.hidden !== undefined) {
      // A live child's nesting walk reads presence alone. Keep the cold
      // keeper bound observed so renewal can queue the parent's load.
      void this.keeps
      return false
    }
    const standing = this.standing
    return standing !== undefined && !standing.excluded &&
      (this.flat || (standing.rescuable && this.keeps))
  }

  // Root and absent shortcuts need no parent candidate or cycle cache.
  @lazy get nestParent(): string | null {
    if (!this.present) return null
    const standing = this.standing
    if (standing === undefined || (standing.parentId === null && standing.startedBy === null)) return null
    return this.nestParentValue
  }

  @lazy
  private get nestParentValue(): string | null {
    return nestParentPartOf(this.host.visibleInputs, this.id, this.nestCandidate)
  }

  @lazy
  get placed(): boolean {
    if (!this.present) return false
    const parent = this.nestParent
    return parent !== null
      ? this.host.visibleInputs.issue(parent)?.placed === true
      : this.standing?.agent === false
  }

  @lazy
  private get nestCandidateValue(): string | null {
    const present = this.present
    return nestCandidatePartOf(
      this.host.visibleInputs,
      this.id,
      present ? this.standing : undefined,
      present,
    )
  }

  @lazy({ equals: compareShallow }) get nestBelow(): readonly string[] {
    return nestBelowPartOf(this.host.visibleInputs, this.id)
  }

  @lazy({ equals: compareShallow }) get nested(): readonly string[] {
    return nestedPartOf(this.host.visibleInputs, this.id, this)
  }

  private readTip(): import('./rollup').Tip {
    return tipPartOf(this.host.rollupInputs, this.id)
  }

  private readOwnAttention(): OwnAttention {
    return ownAttentionFields(this.host.rollupInputs, this)
  }


  get inMemory(): boolean { return this.issue.inMemory }
  get updatedMs(): number | null { return this.issue.updatedMs }

  get ownFacts(): OwnFacts {
    const row = this
    return {
      get state() { return row.issue.ownFacts.state },
      get finished() { return row.issue.ownFacts.finished },
      get decision() { return row.issue.ownFacts.decision },
      get continuedByField() { return row.issue.ownFacts.continuedByField },
      get updatedAt() { return row.issue.ownFacts.updatedAt },
      get closedAt() { return row.issue.ownFacts.closedAt },
      get coordinatorSessionId() { return row.issue.ownFacts.coordinatorSessionId },
      get order() { return row.issueOrder },
    }
  }

  @lazy({ equals: compareStructural })
  get issueOrder(): OwnFacts['order'] {
    return this.issue.inMemory ? { id: this.id, seq: this.issue.seq,
      createdAt: this.issue.createdAt, sortKey: this.issue.sortKey } : undefined
  }

  // Stored fields and display labels (RowView compatibility)

  get displayRef(): string {
    return this.issue.displayRef
  }

  @lazy
  get title(): string {
    if (!this.issue.inMemory) return ''
    return displayTitleOf(this.issue, () => {
      for (const id of this.sessionIds) {
        const session = this.host.inputs.session(id)
        if (isDraftNameSession(session)) return session
      }
      return undefined
    })
  }

  @lazy
  get phase(): SlicePhase {
    return this.finished === undefined ? NO_ROLLUP.phase : phaseOf(this.aggregate, this.finished)
  }

  // Progress
  @lazy
  get progressDone(): number {
    if (this.finished === undefined) return NO_ROLLUP.progressDone
    return this.unitsBelow.members > 0 ? this.unitsBelow.done : this.unitOwn.done ? 1 : 0
  }

  @lazy
  get progressTotal(): number {
    if (this.finished === undefined) return NO_ROLLUP.progressTotal
    return this.unitsBelow.members > 0 ? this.unitsBelow.units : this.unitOwn.solo ? 1 : 0
  }

  // Presence and attention
  @lazy
  get working(): boolean {
    return this.finished !== undefined && this.aggregate.working
  }

  @lazy
  get asking(): boolean {
    return this.finished !== undefined && askingOf(this.aggregate, this.finished)
  }

  @lazy
  get workingSince(): number | null {
    return this.finished === undefined ? null : this.ownAttention.workingSince
  }

  @lazy
  get band(): 0 | 1 | 2 {
    return this.readOwn()?.band ?? 1
  }

  @lazy
  get repoKey(): string {
    return this.readOwn()?.repoKey ?? ''
  }

  // Close: the sidebar fold has a grace period; finished is the entity lifecycle.
  @lazy
  get closed(): boolean {
    return this.settledClosed && !this.asking
  }

  @lazy
  get dismissed(): boolean {
    return this.settledDismissed && !this.asking
  }

  // Stored fields used by row ordering
  get pinned(): boolean {
    return this.issue.pinned === true
  }

  get sortKey(): string | null {
    return this.issue.sortKey ?? null
  }

  get createdAt(): string {
    return this.issue.createdAt ?? ''
  }

  get seq(): number {
    return this.issue.seq ?? 0
  }

  @lazy
  get foldAt(): string {
    return this.readOwn()?.foldAt ?? ''
  }

  @lazy({ equals: compareStructural })
  get originTick(): RowOriginTick | null {
    return originTickPartOf(this.host.inputs, this.originId)
  }

  @lazy
  get activityAt(): number {
    const own = this.ownActivityAt, seat = this.seatActivity
    return seat !== null && seat > own ? seat : own
  }

  @lazy
  get loading(): true | undefined {
    return this.lazyLoading || (this.finished !== undefined &&
      (this.aggregate.pending > 0 || this.unitsBelow.pending > 0)) ? true : undefined
  }

  /** A scalar computed publishes only when this row gains or loses selection. */
  @lazy get selected(): boolean {
    return this.worklist.selectedId === this.id
  }

  // Links and history

  get parentRef(): string | null {
    // A cold ancestor's renewed retention can change nesting while its raw
    // parent stays the same. Keep that view dependency beside the walk.
    void this.hidden
    return this.issue.parentRef
  }

  /**
   * R2's seats: the maintained sorted list itself (tracked, never copied; a
   * membership change yields one element). POD-5423: no cached copy, so a
   * heartbeat or one seat's change walks no history to rebuild it.
   */
  get seatIds(): readonly string[] {
    return this.host.visibleInputs.seatList(this.id)
  }

  @lazy({ equals: compareShallow }) get laneMemberIds(): readonly string[] { return laneMemberIdsPartOf(this.host.visibleInputs, this.id) }

  @lazy({ equals: compareShallow }) get memberIds(): readonly string[] { return memberIdsPartOf(this.seatIds, this.laneMemberIds) }

  get hidden(): HiddenIssue | undefined {
    // untracked-read: issue-hidden-presence
    const resident = untracked(() => omitGone(this.host.row('issue', this.id, 'mark')))
    if (resident !== LOADING) {
      // Unknown ids must still follow a later cold publication through the reader.
      if (resident === undefined) void omitGone(this.host.row('issue', this.id, 'summary'))
      return undefined
    }
    const summary = omitGone(this.host.row('issue', this.id, 'summary'))
    return summary === LOADING ? {} : summary as HiddenIssue | undefined
  }

  get nestCandidate(): string | null {
    // Cycle walks can ask a root or an absent row for its candidate without
    // going through `nesting`. Their constant null needs no memo either.
    if (!this.present) return null
    const standing = this.standing
    if (standing === undefined || (standing.parentId === null && standing.startedBy === null)) {
      return null
    }
    return this.nestCandidateValue
  }

  /** Latest seat activity in the visible subtree, independent of attention. */
  @lazy
  get seatActivity(): number | null {
    return seatActivityPartOf(this.host.rollupInputs, this.id, this)
  }

  private readUnitOwn(): UnitOwn {
    return unitOwnFields(this.host.rollupInputs, this.id, this)
  }

  private readUnitsBelow(): Units {
    return unitsBelowFields(this.host.rollupInputs, this.id)
  }

  get label(): Label {
    const model = this
    return {
      get displayRef() { return model.inMemory ? model.displayRef : undefined },
      get displayTitle() { return model.inMemory ? model.title : undefined },
      get seq() { return model.inMemory ? model.seq : undefined },
    }
  }

  /** The own-row fields forward to the same caches the row itself reads. */
  get own(): OwnPart | undefined {
    if (!this.hasStanding) return undefined
    const model = this
    return {
      get band() { return model.band },
      get repoKey() { return model.repoKey },
      get closed() { return model.settledClosed },
      get dismissed() { return model.settledDismissed },
      get pinned() { return model.pinned },
      get sortKey() { return model.sortKey },
      get createdAt() { return model.createdAt },
      get seq() { return model.seq },
      get foldAt() { return model.foldAt },
    }
  }

  @lazy
  private get settledClosed(): boolean {
    return this.readOwn()?.closed === true
  }

  @lazy
  private get settledDismissed(): boolean {
    return this.readOwn()?.dismissed === true
  }

  // ------------------------------------ parts computed where they are read

  get finished(): boolean | undefined {
    return this.issue.finished
  }

  /** Cycle walks need only the tracked parent key, including on cold ancestors. */
  get formalParent(): string | null {
    return this.issue.formalParent
  }

  /** R-GROUP 3's "nothing in the subtree waits". */
  @lazy get waiting(): boolean {
    return waitingPartOf(this)
  }

  /** The row's roll-up fields; undefined when the issue is unknown. */
  get rollup(): Rollup | undefined {
    return rollupPartOf(this)
  }

  /**
   * Where the row goes (R-GROUP, `groups.ts`): read by the groups' layout for
   * visible rows only. The waiting roll-up is read only for a row the fold
   * would take, so a row that could never fold never reads its aggregate.
   */
  @lazy({ equals: compareStructural }) get placement(): Placement | undefined {
    const part = this.own
    const row = this.host.visibleInputs.issueRow(this.id)
    const settled = part === undefined || row === undefined ? undefined : placementOfPart(part, row.repoPath)
    return settled === undefined || !settled.closed || !this.waiting
      ? settled
      : withWaiting(settled)
  }

  @lazy({ equals: compareShallow }) get childIds(): readonly string[] { return childIdsPartOf(this.host.visibleInputs, this.id) }

  @lazy({ equals: compareShallow }) get spinOffIds(): readonly string[] { return spinOffIdsPartOf(this.host.visibleInputs, this.id) }

  @lazy get keptBelow(): boolean {
    return keptBelowPartOf(this.host.visibleInputs, this.id, this.childIds, this)
  }

  get repoTarget(): string | null {
    return this.issue.repoTarget
  }

  get prefix(): string | null {
    return this.issue.prefix
  }

  get originRef(): string | null {
    return this.issue.originRef
  }

  @lazy get originId(): string | null {
    return originIdPartOf(this.host.inputs, this.originRef)
  }

  /** The data layer's maintained list, borrowed without a second computed. */
  get sessionIds(): readonly string[] {
    return sessionIdsPartOf(this.host.inputs, this.id)
  }

  /** The own-row activity stamp, before the roll-up's latest seat raises it (`activityAt`). */
  @lazy get ownActivityAt(): number {
    const inputs = this.host.inputs
    return activityAtOf(
      inputs,
      inputs.retainedSeats(this.id),
      () => this.issue.updatedMs,
    )
  }

  /** A lazy input of the row's own parts (the origin, a member session) is not resident yet. */
  @lazy get lazyLoading(): boolean {
    return loadingPartOf(this.host.inputs, this.originRef, this.sessionIds)
  }
  // ------------------------------------------------------ own-row standing

  get standing(): Standing | undefined {
    if (!this.hasStanding) return undefined
    const model = this
    return {
      get excluded() { return (model.issue.excluded) },
      get finished() { return (model.issue.finished ?? false) },
      get agent() { return (model.issue.audience === 'agent') },
      get activeHuman() { return model.activeHuman },
      get awaitingMerge() { return (model.issue.awaitingMerge) },
      get sessionless() { return model.sessionless },
      get rescuable() { return model.rescuable },
      get parentId() { return (model.issue.parentRef) },
      get startedBy() { return model.startedBy },
      get draftVessel() { return (model.issue.isDraftVessel === true && !model.issue.worktreePath) },
      get finishedMs() { return model.issue.finishedMs },
      get updatedMs() { return (model.issue.updatedMs) },
      get replicaActivityMs() { return model.lastSessionActivity },
      get headlessStaffed() { return (model.issue.headlessStaffed) },
      get deleted() { return (model.issue.deletedAt != null) },
      get pinned() { return (model.issue.pinned === true) },
      get formalParent() { return (model.issue.formalParent) },
    }
  }

  @lazy
  get activeHuman(): Standing['activeHuman'] {
    return this.readStanding()!.activeHuman
  }

  @lazy
  get sessionless(): Standing['sessionless'] {
    return this.readStanding()!.sessionless
  }

  @lazy
  get rescuable(): Standing['rescuable'] {
    return this.readStanding()!.rescuable
  }

  @lazy
  get startedBy(): Standing['startedBy'] {
    return this.readStanding()!.startedBy
  }

  @lazy
  get lastSessionActivity(): Standing['replicaActivityMs'] {
    return parseMs(this.issue.lastActivityAt)
  }

  // ------------------------------------------------------ own-seat attention

  get ownAttention(): OwnAttention {
    const model = this
    return {
      get cold() { return model.sessionsLoading },
      get workingSince() { return model.sessionsWorkingSince },
      get firstSessionId() { return model.firstSessionId },
      get railWaiting() { return model.waitingCounts },
      get sessionIds() { return model.attentionSessionIds },
      get sidebarFacts() { return model.sessionFacts },
      get updatedAt() { return model.sessionsUpdatedAt },
      get order() { return model.sessionOrder },
      get decidingAt() { return model.decisionAt },
      get seated() { return model.hasSessions },
      get working() { return model.sessionsWorking },
      get deciding() { return model.needsDecision },
      get open() { return model.openSessionFlags },
      get finished() { return model.finishedSessionFlags },
      get pending() { return model.pendingSessions },
    }
  }

  @lazy
  get sessionsLoading(): OwnAttention['cold'] {
    return this.readOwnAttention().cold
  }

  @lazy
  get sessionsWorkingSince(): OwnAttention['workingSince'] {
    return this.readOwnAttention().workingSince
  }


  get waitingCounts(): NonNullable<Aggregate['railWaiting']> | undefined {
    if (!this.hasWaitingCounts) return undefined
    const row = this
    return { get open() { return row.waitingOpenSessions }, get finished() { return row.waitingFinishedSessions },
      get decisions() { return row.waitingDecisions } }
  }

  @lazy
  get hasWaitingCounts(): boolean {
    return this.readOwnAttention().railWaiting !== undefined
  }

  @lazy
  get waitingOpenSessions(): NonNullable<Aggregate['railWaiting']>['open'] {
    return this.readOwnAttention().railWaiting!.open
  }

  @lazy
  get waitingFinishedSessions(): NonNullable<Aggregate['railWaiting']>['finished'] {
    return this.readOwnAttention().railWaiting!.finished
  }

  @lazy
  get waitingDecisions(): NonNullable<Aggregate['railWaiting']>['decisions'] {
    return this.readOwnAttention().railWaiting!.decisions
  }

  @lazy({ equals: compareShallow }) get attentionSessionIds(): readonly string[] {
    return this.readOwnAttention().sessionIds ?? []
  }

  get sessionFacts(): SidebarSessionFacts | undefined {
    if (!this.hasSessionFacts) return undefined
    const model = this
    return {
      get fleet() { return model.sessionFleet },
      get working() { return model.workingTimer },
      get waitingOpen() { return model.waitingOpenTimer },
      get waitingFinished() { return model.waitingFinishedTimer },
      get doneSince() { return model.sessionsDoneSince },
      get totalMs() { return model.sessionsWorkingMs },
      get errorClass() { return model.sessionErrorClass },
      get allUnstarted() { return model.sessionsUnstarted },
    }
  }

  @lazy
  get hasSessionFacts(): boolean {
    return this.readOwnAttention().sidebarFacts !== undefined
  }

  @lazy({ equals: compareStructural })
  get sessionFleet(): SidebarSessionFacts['fleet'] {
    return this.readOwnAttention().sidebarFacts!.fleet
  }

  @lazy({ equals: compareStructural })
  get workingTimer(): SidebarSessionFacts['working'] {
    return this.readOwnAttention().sidebarFacts!.working
  }

  @lazy({ equals: compareStructural })
  get waitingOpenTimer(): SidebarSessionFacts['waitingOpen'] {
    return this.readOwnAttention().sidebarFacts!.waitingOpen
  }

  @lazy({ equals: compareStructural })
  get waitingFinishedTimer(): SidebarSessionFacts['waitingFinished'] {
    return this.readOwnAttention().sidebarFacts!.waitingFinished
  }

  @lazy
  get sessionsDoneSince(): SidebarSessionFacts['doneSince'] {
    return this.readOwnAttention().sidebarFacts!.doneSince
  }

  @lazy
  get sessionsWorkingMs(): SidebarSessionFacts['totalMs'] {
    return this.readOwnAttention().sidebarFacts!.totalMs
  }

  @lazy
  get sessionErrorClass(): SidebarSessionFacts['errorClass'] {
    return this.readOwnAttention().sidebarFacts!.errorClass
  }

  @lazy
  get sessionsUnstarted(): SidebarSessionFacts['allUnstarted'] {
    return this.readOwnAttention().sidebarFacts!.allUnstarted
  }

  @lazy
  get sessionsUpdatedAt(): OwnAttention['updatedAt'] {
    return this.readOwnAttention().updatedAt
  }

  @lazy({ equals: compareStructural })
  get sessionOrder(): OwnAttention['order'] {
    return this.readOwnAttention().order
  }

  @lazy
  get decisionAt(): OwnAttention['decidingAt'] {
    return this.readOwnAttention().decidingAt
  }

  @lazy
  get hasSessions(): OwnAttention['seated'] {
    return this.readOwnAttention().seated
  }

  @lazy
  get sessionsWorking(): OwnAttention['working'] {
    return this.readOwnAttention().working
  }

  @lazy
  get needsDecision(): OwnAttention['deciding'] {
    return this.readOwnAttention().deciding
  }

  get openSessionFlags(): import('./rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.openSessionsWaiting },
      get working() { return model.openSessionsWorking },
      get allDone() { return model.openSessionsDone },
    }
  }

  @lazy
  get openSessionsWaiting(): import('./rollup').PhaseFlags['waiting'] {
    return this.readOwnAttention().open.waiting
  }

  @lazy
  get openSessionsWorking(): import('./rollup').PhaseFlags['working'] {
    return this.readOwnAttention().open.working
  }

  @lazy
  get openSessionsDone(): import('./rollup').PhaseFlags['allDone'] {
    return this.readOwnAttention().open.allDone
  }

  get finishedSessionFlags(): import('./rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.finishedSessionsWaiting },
      get working() { return model.finishedSessionsWorking },
      get allDone() { return model.finishedSessionsDone },
    }
  }

  @lazy
  get finishedSessionsWaiting(): import('./rollup').PhaseFlags['waiting'] {
    return this.readOwnAttention().finished.waiting
  }

  @lazy
  get finishedSessionsWorking(): import('./rollup').PhaseFlags['working'] {
    return this.readOwnAttention().finished.working
  }

  @lazy
  get finishedSessionsDone(): import('./rollup').PhaseFlags['allDone'] {
    return this.readOwnAttention().finished.allDone
  }

  @lazy
  get pendingSessions(): OwnAttention['pending'] {
    return this.readOwnAttention().pending
  }

  // ------------------------------------------------------ nested attention

  get aggregate(): Aggregate { return this.filingAttention.value }
  get visibleAttention(): Aggregate { return this.visibleAttentionFields.value }

  // Progress: formal descendants

  get unitOwn(): UnitOwn {
    const model = this
    return {
      get state() { return model.unitOwnState },
      get staffed() { return model.unitOwnStaffed },
      get member() { return model.unitOwnMember },
      get unit() { return model.unitOwnUnit },
      get done() { return model.unitOwnDone },
      get solo() { return model.unitOwnSolo },
      get cold() { return model.unitOwnCold },
    }
  }

  @lazy
  private get unitOwnState(): UnitOwn['state'] {
    return this.readUnitOwn().state
  }

  @lazy
  private get unitOwnStaffed(): UnitOwn['staffed'] {
    return this.readUnitOwn().staffed
  }

  @lazy
  private get unitOwnMember(): UnitOwn['member'] {
    return this.readUnitOwn().member
  }

  @lazy
  private get unitOwnUnit(): UnitOwn['unit'] {
    return this.readUnitOwn().unit
  }

  @lazy
  private get unitOwnDone(): UnitOwn['done'] {
    return this.readUnitOwn().done
  }

  @lazy
  private get unitOwnSolo(): UnitOwn['solo'] {
    return this.readUnitOwn().solo
  }

  @lazy
  private get unitOwnCold(): UnitOwn['cold'] {
    return this.readUnitOwn().cold
  }

  get unitsBelow(): Units {
    const model = this
    return {
      get progress() { return model.unitsBelowProgress },
      get staffed() { return model.unitsBelowStaffed },
      get members() { return model.unitsBelowMembers },
      get units() { return model.unitsBelowUnits },
      get done() { return model.unitsBelowDone },
      get pending() { return model.unitsBelowPending },
    }
  }

  @lazy({ equals: compareStructural })
  private get unitsBelowProgress(): Units['progress'] {
    return this.readUnitsBelow().progress
  }

  @lazy
  private get unitsBelowStaffed(): Units['staffed'] {
    return this.readUnitsBelow().staffed
  }

  @lazy
  private get unitsBelowMembers(): Units['members'] {
    return this.readUnitsBelow().members
  }

  @lazy
  private get unitsBelowUnits(): Units['units'] {
    return this.readUnitsBelow().units
  }

  @lazy
  private get unitsBelowDone(): Units['done'] {
    return this.readUnitsBelow().done
  }

  @lazy
  private get unitsBelowPending(): Units['pending'] {
    return this.readUnitsBelow().pending
  }

  // Links: continuation and origins

  get tip(): import('./rollup').Tip {
    const model = this
    return {
      get found() { return model.tipFound },
      get pending() { return model.tipPending },
      get target() { return model.tipFound ? model.tipTarget : undefined },
    }
  }

  @lazy
  private get tipFound(): boolean {
    return this.readTip().found
  }

  @lazy
  private get tipPending(): number {
    return this.readTip().pending
  }

  get tipTarget(): import('./rollup').TipTarget {
    const model = this
    return {
      get id() { return model.tipTargetId },
      get seq() { return model.tipTargetSeq },
      get repoId() { return model.tipTargetRepoId },
      get staffed() { return model.tipTargetStaffed },
      get finished() { return model.tipTargetFinished },
      get activeAt() { return model.tipTargetActiveAt },
    }
  }

  @lazy
  private get tipTargetId(): import('./rollup').TipTarget['id'] {
    return this.readTip().target!.id
  }

  @lazy
  private get tipTargetSeq(): import('./rollup').TipTarget['seq'] {
    return this.readTip().target!.seq
  }

  @lazy
  private get tipTargetRepoId(): import('./rollup').TipTarget['repoId'] {
    return this.readTip().target!.repoId
  }

  @lazy
  private get tipTargetStaffed(): import('./rollup').TipTarget['staffed'] {
    return this.readTip().target!.staffed
  }

  @lazy
  private get tipTargetFinished(): import('./rollup').TipTarget['finished'] {
    return this.readTip().target!.finished
  }

  @lazy
  private get tipTargetActiveAt(): import('./rollup').TipTarget['activeAt'] {
    return this.readTip().target!.activeAt
  }

  // Drawn rows use the same companions on desktop and phone. Their demand
  // follows the resident nesting query, independently of filing the list.
  @lazy({ equals: compareShallow }) get visibleChildIds(): readonly string[] { return sidebarBelowOf(this, this.worklist.pool) }
  @lazy({ equals: compareShallow }) get visibleDescendantIds(): readonly string[] { return sidebarNestedOf(this, this.worklist.pool) }
  get visibleParts(): import('./rollup').RollupSelf {
    const row = this
    return {
      get ownFacts() { return row.ownFacts }, get formalParent() { return row.formalParent },
      get updatedMs() { return row.issue.updatedMs },
      get openOwn() { return row.openOwn }, get present() { return row.present },
      get seatIds() { return row.seatIds },
      get rosterIds() { return row.rosterIds }, get finished() { return row.finished },
      get tip() { return row.tip }, get ownAttention() { return row.ownAttention },
      get aggregate() { return row.visibleAttention }, get unitOwn() { return row.unitOwn },
      get unitsBelow() { return row.unitsBelow }, get seatActivity() { return row.visibleSessionActivity },
      get rollup() { return rollupPartOf(row.visibleParts) },
    }
  }
  @lazy get visibleSessionActivity(): number | null { return seatActivityPartOf(this.worklist.rowInputs, this.id, this.visibleParts) }
  @lazy get visibleActivityAt(): number {
    const own = this.ownActivityAt, seat = this.visibleSessionActivity
    return seat !== null && seat > own ? seat : own
  }

  @lazy get loadedIssue() {
    const row = this.host.rollupInputs.loadedIssue(this.id)
    return row === undefined || row === LOADING ? row : this.issue
  }
  @lazy get loadedOrigin() {
    if (this.originRef === null) return undefined
    const row = this.host.rollupInputs.loadedIssue(this.originRef)
    return row === undefined || row === LOADING ? row : this.worklist.pool.issueObject(row.id)
  }
  get continuationTip() { return !this.targetId && !this.openOwn ? this.tip : undefined }
  @lazy private get targetId() { return this.issue.supersededBy ?? this.issue.duplicateOf }
  @lazy get ready(): 'ready' | typeof LOADING | undefined {
    if (this.issue.excluded) return undefined
    if (this.loadedIssue === LOADING || this.loadedOrigin === LOADING) return LOADING
    if (this.loadedIssue === undefined) return undefined
    if (this.visibleAttention.pending > 0 || this.unitsBelow.pending > 0 || this.unitOwn.cold || (this.continuationTip?.pending ?? 0) > 0) return LOADING
    if (this.targetId && this.host.rollupInputs.loadedIssue(this.targetId) === LOADING) return LOADING
    return 'ready'
  }

  @lazy({ equals: compareShallow }) get sessions(): readonly import('../models').SessionModel[] {
    const sessions: import('../models').SessionModel[] = []
    for (const id of this.attentionSessionIds) {
      if (this.host.resident('session', id) === 'resident') sessions.push(this.worklist.pool.sessionObject(id))
    }
    return sessions
  }

  @lazy({ equals: compareShallow }) get visibleSessionIds(): readonly string[] { return this.visibleAttention.sessionIds ?? [] }
  @lazy({ equals: compareStructural }) get visibleFleet() { return (this.visibleAttention.sidebarFacts ?? NO_SIDEBAR_SESSIONS).fleet }
  @lazy get mergeCommits() { return this.decision === 'merge' ? this.issue.gitState?.ahead ?? 0 : 0 }

  @lazy get visiblePhase() { return phaseOf(this.visibleAttention, this.ownFacts.finished) }
  @lazy get visibleWorking() { return this.visibleAttention.working }
  @lazy get visibleAsking() { return askingOf(this.visibleAttention, this.ownFacts.finished) }
  @lazy get decision() { return this.ownAttention.deciding ? this.ownFacts.decision : null }
  @lazy({ equals: compareStructural }) get origin(): RowOriginTick | null {
    const origin = this.loadedOrigin
    return origin === undefined || origin === LOADING ? null : {
      id: origin.id, seq: origin.seq, title: origin.title,
      ref: this.host.inputs.parts(origin.id)?.label.displayRef ?? `#${origin.seq}`,
    }
  }
  @lazy({ equals: compareStructural }) get progress(): SidebarProgress | typeof LOADING {
    const below = this.unitsBelow, own = this.unitOwn
    if (below.pending > 0 || own.cold) return LOADING
    return below.members > 0
      ? { done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0, ...below.progress, total: below.units }
      : { done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0, total: own.solo ? 1 : 0,
        ...(own.solo ? { [own.state ?? 'wait']: 1 } : {}) }
  }
  @lazy get hasChildProgress() { return this.unitsBelow.members > 0 }
  @lazy get showsChildProgress() { return this.nestParent === null && this.hasChildProgress }
  @lazy({ equals: compareStructural }) get timing() {
    return sidebarTimingFromFacts(this.visibleAttention.sidebarFacts ?? NO_SIDEBAR_SESSIONS,
      this.visiblePhase, this.ownFacts.finished, this.visibleActivityAt, this.visibleAttention.decidingAt)
  }
  /** Desktop emphasis in the drawn subtree; working activity suppresses retention unread. */
  @lazy get visibleUnread(): boolean {
    if (this.visibleWorking) return false
    const readAt = this.issue.readAt, readMs = Date.parse(readAt ?? '')
    return this.issue.unread || Boolean(readAt && Number.isFinite(readMs) &&
      ((Date.parse(this.visibleAttention.updatedAt ?? '') || 0) > readMs || (this.visibleSessionActivity ?? 0) > readMs) && this.visibleDescendantIds.length > 0)
  }
  @lazy get errorClass() { return this.ownFacts.finished ? null : (this.visibleAttention.sidebarFacts ?? NO_SIDEBAR_SESSIONS).errorClass }
  @lazy get sessionOnlyDraft() { return this.issue.isDraftVessel === true && !this.issue.worktreePath && this.sessions.length > 0 }
  @lazy get firstSessionId() { return this.readOwnAttention().firstSessionId ?? null }
  @lazy get awaitingFirstPrompt() {
    return this.issue.isDraftVessel === true && this.visiblePhase === 'queued' &&
      (this.visibleAttention.sessionIds?.length ?? 0) > 0 && (this.visibleAttention.sidebarFacts ?? NO_SIDEBAR_SESSIONS).allUnstarted
  }
  @lazy({ equals: compareStructural }) get continuation(): SidebarRowValues['continuation'] {
    if (this.targetId) return { kind: this.issue.supersededBy ? 'continued' : 'duplicate',
      ref: this.host.inputs.parts(this.targetId)?.label.displayRef ?? 'another task' }
    const destination = this.continuationTip?.target
    return destination ? { kind: 'continued', ref: this.host.inputs.parts(destination.id)?.label.displayRef ?? `#${destination.seq}` } : null
  }
  private readLifecycle() { return sidebarLifecycle(this.issue as unknown as SliceIssue, this.visibleAsking, this.host.inputs.passed, this.host.inputs.reached, this.issue) }
  @lazy get returnedFromDefer() { return this.readLifecycle().unsnoozed }
  @lazy get canTuck() { return this.readLifecycle().awaitsTuck }
  @lazy get canBringBack() { return this.readLifecycle().canBringBack }

  @lazy get waitingCount() { return mobileWaitingCount(this.visibleAttention, this.finished === true) }
  @lazy get quietDraft() {
    const first = this.sessions[0]
    return this.sessionOnlyDraft && !first?.busy && (first?.agentState?.phase ?? 'unknown') === 'unknown'
  }
  /** Phone emphasis also suppresses visibleUnread for a quiet session-only draft. */
  @lazy get emphasizeUnread() { return this.visibleUnread && !this.quietDraft }
  @lazy get attentionAction() { return this.waitingCount > 0 ? this.decision ? 'Review' as const : 'Answer' as const : null }
  @lazy({ equals: compareStructural }) get navigation(): MobileRowValues['navigation'] {
    const first = this.sessions[0]
    return this.sessionOnlyDraft && first ? { kind: 'session', id: first.sessionId } : { kind: 'issue', id: this.id }
  }

}
