import { omitGone } from '../lookup'
import { parseMs } from '../views'
import { compareStructural, untracked } from 'mobx'
import { lazy, companion } from '@podium/mobx-helpers'
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
import { worklistLists } from './lists-before.test-helper'
import { createIdentityQuery } from '../query-identity-before.test-helper'
import { mobileWaitingCount, type MobileRowValues } from './mobile-row'
import { childIdsPartOf, type HeldIssue, type HiddenIssue, hiddenPresenceOf, keptBelowPartOf,
  laneMemberIdsPartOf, memberIdsPartOf, nestCandidatePartOf, nestParentPartOf,
  flatPartOf, keepsPartOf, retainedSeatIdsPartOf, rosterIdsPartOf, openOwnPartOf,
  laneRetainedSeatIdsPartOf, mergeIds, standingOf, type Standing, spinOffIdsPartOf, unreadPartOf } from './visible'
import type { IssueModel, ModelHost } from '../models'
import type { Worklist } from './view-model'
import { AttentionFields } from './attention'

// Identity-only ports and helpers are allocated on demand by companion().
// Their owner is the view's row companion; their answers remain @lazy fields.
const filingAttention = companion((row: WorklistIssueBefore) => new AttentionFields(row, () => row.worklist.host.rollupInputs))
const drawnAttention = companion((row: WorklistIssueBefore) => new AttentionFields(row, () => row.worklist.rowInputs))
const sidebarPort = companion((row: WorklistIssueBefore) => row.createSidebarPort())
const mobilePort = companion((row: WorklistIssueBefore) => row.createMobilePort())
const issuePort = companion((row: WorklistIssueBefore) => row.createIssuePort())
const attentionSessions = companion((row: WorklistIssueBefore) => row.createAttentionSessionQuery())
const laneMembers = companion((row: WorklistIssueBefore) => row.createMembershipQuery('lane'))
const members = companion((row: WorklistIssueBefore) => row.createMembershipQuery('members'))
const laneRetained = companion((row: WorklistIssueBefore) => row.createMembershipQuery('laneRetained'))
const retained = companion((row: WorklistIssueBefore) => row.createMembershipQuery('retained'))
const roster = companion((row: WorklistIssueBefore) => row.createMembershipQuery('roster'))
const children = companion((row: WorklistIssueBefore) => row.createMembershipQuery('children'))
const spinOffs = companion((row: WorklistIssueBefore) => row.createMembershipQuery('spinOffs'))
type MembershipQuestion = 'lane' | 'members' | 'laneRetained' | 'retained' | 'roster' | 'children' | 'spinOffs'

/** One worklist's rules for the shared issue; desktop and phone borrow this object. */
export class WorklistIssueBefore implements HeldIssue, RowView {
  constructor(readonly issue: IssueModel, readonly worklist: Worklist) {}
  get visibleChildIds() { return this.rowBelow }
  get id(): string { return this.issue.id }
  get visible(): boolean { return this.issue.visible }
  private get host(): ModelHost { return this.worklist.host }

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

  private readStanding(): Standing | undefined {
    const row = this.residentIssue()
    if (row === undefined) return undefined
    const issue = this.issue, work = this
    return standingOf(row, {
      get excluded() { return work.standingExcluded }, get finished() { return issue.finished ?? false },
      get awaitingMerge() { return work.standingAwaitingMerge }, get parentId() { return issue.parentRef },
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

  private get laneRetainedSeatIds(): readonly string[] {
    return laneRetained(this).get()
  }

  get retainedSeatIds(): readonly string[] {
    const summary = this.explicitSeats
    if (this.standing !== undefined && summary !== undefined && this.laneMemberIds.length === 0) return summary.retained
    return retained(this).get()
  }

  // R2 owns the list: pass through its identity, with no copied ID snapshot.
  get rosterIds(): readonly string[] {
    const summary = this.explicitSeats
    if (this.standing !== undefined && summary !== undefined && this.laneMemberIds.length === 0) return summary.roster
    return roster(this).get()
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

  get nestBelow(): readonly string[] {
    return worklistLists(this).below.get()
  }

  get nested(): readonly string[] {
    return worklistLists(this).nested.get()
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
      get order() { return row.ownOrder },
    }
  }

  @lazy({ equals: compareStructural })
  private get ownOrder(): OwnFacts['order'] {
    return this.issue.inMemory ? { id: this.id, seq: this.issue.seq,
      createdAt: this.issue.createdAt, sortKey: this.issue.sortKey } : undefined
  }

  // Stored fields and display labels (RowView compatibility)

  @lazy
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
  @lazy
  get pinned(): boolean {
    return this.issue.pinned === true
  }

  @lazy
  get sortKey(): string | null {
    return this.issue.sortKey ?? null
  }

  @lazy
  get createdAt(): string {
    return this.issue.createdAt ?? ''
  }

  @lazy
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

  get laneMemberIds(): readonly string[] { return laneMembers(this).get() }

  get memberIds(): readonly string[] { return members(this).get() }

  /** @internal List policies stay here; query results own membership identity. */
  createMembershipQuery(question: MembershipQuestion) {
    return createIdentityQuery({ name: `worklist@${this.id}.${question}`, ids: () => {
      const input = this.host.visibleInputs
      switch (question) {
        case 'lane': return laneMemberIdsPartOf(input, this.id)
        case 'members': return memberIdsPartOf(this.seatIds, this.laneMemberIds)
        case 'children': return childIdsPartOf(input, this.id)
        case 'spinOffs': return spinOffIdsPartOf(input, this.id)
        case 'laneRetained': return laneRetainedSeatIdsPartOf(input, this.id, this.standing, this.laneMemberIds)
        case 'retained': {
          if (this.standing === undefined) return []
          const summary = this.explicitSeats
          return summary === undefined ? retainedSeatIdsPartOf(input, this.id, this.standing, this.memberIds)
            : mergeIds(summary.retained, this.laneRetainedSeatIds)
        }
        case 'roster': {
          if (this.standing === undefined) return []
          const summary = this.explicitSeats
          return summary === undefined ? rosterIdsPartOf(input, this.retainedSeatIds)
            : mergeIds(summary.roster, rosterIdsPartOf(input, this.laneRetainedSeatIds))
        }
      }
    } })
  }

  get hidden(): HiddenIssue | undefined {
    // untracked-read: old-issue-hidden-presence
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

  get childIds(): readonly string[] { return children(this).get() }

  get spinOffIds(): readonly string[] { return spinOffs(this).get() }

  @lazy get keptBelow(): boolean {
    return keptBelowPartOf(this.host.visibleInputs, this.id, this.childIds, this)
  }

  @lazy get unread(): boolean {
    return unreadPartOf(this.host.visibleInputs, this.id, this.standing, this.seatIds)
  }

  get repoTarget(): string | null {
    return this.issue.repoTarget
  }

  get prefix(): string | null {
    return this.issue.prefix
  }

  @lazy
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
      get excluded() { return model.standingExcluded },
      get finished() { return model.standingFinished },
      get agent() { return model.standingAgent },
      get activeHuman() { return model.standingActiveHuman },
      get awaitingMerge() { return model.standingAwaitingMerge },
      get sessionless() { return model.standingSessionless },
      get rescuable() { return model.standingRescuable },
      get parentId() { return model.standingParentId },
      get startedBy() { return model.standingStartedBy },
      get draftVessel() { return model.standingDraftVessel },
      get finishedMs() { return model.standingFinishedMs },
      get updatedMs() { return model.standingUpdatedMs },
      get replicaActivityMs() { return model.standingReplicaActivityMs },
      get headlessStaffed() { return model.standingHeadlessStaffed },
      get deleted() { return model.standingDeleted },
      get pinned() { return model.standingPinned },
      get formalParent() { return model.standingFormalParent },
    }
  }

  @lazy
  private get standingExcluded(): Standing['excluded'] {
    const row = this.residentIssue()
    return row !== undefined && isExcluded(row)
  }

  @lazy
  private get standingFinished(): Standing['finished'] {
    return this.issue.finished ?? false
  }

  @lazy
  private get standingAgent(): Standing['agent'] {
    return this.readStanding()!.agent
  }

  @lazy
  private get standingActiveHuman(): Standing['activeHuman'] {
    return this.readStanding()!.activeHuman
  }

  @lazy
  private get standingAwaitingMerge(): Standing['awaitingMerge'] {
    return !this.standingExcluded && this.issue.awaitingMerge
  }

  @lazy
  private get standingSessionless(): Standing['sessionless'] {
    return this.readStanding()!.sessionless
  }

  @lazy
  private get standingRescuable(): Standing['rescuable'] {
    return this.readStanding()!.rescuable
  }

  @lazy
  private get standingParentId(): Standing['parentId'] {
    return this.issue.parentRef
  }

  @lazy
  private get standingStartedBy(): Standing['startedBy'] {
    return this.readStanding()!.startedBy
  }

  @lazy
  private get standingDraftVessel(): Standing['draftVessel'] {
    return this.readStanding()!.draftVessel
  }

  @lazy
  private get standingFinishedMs(): Standing['finishedMs'] {
    return this.issue.finishedMs
  }

  @lazy
  private get standingUpdatedMs(): Standing['updatedMs'] {
    return this.issue.updatedMs
  }

  @lazy
  private get standingReplicaActivityMs(): Standing['replicaActivityMs'] {
    return parseMs(this.issue.lastActivityAt)
  }

  @lazy
  private get standingHeadlessStaffed(): Standing['headlessStaffed'] {
    return this.issue.headlessStaffed
  }

  @lazy
  private get standingDeleted(): Standing['deleted'] {
    return this.readStanding()!.deleted
  }

  @lazy
  private get standingPinned(): Standing['pinned'] {
    return this.readStanding()!.pinned
  }

  @lazy
  private get standingFormalParent(): Standing['formalParent'] {
    return this.issue.formalParent
  }

  // ------------------------------------------------------ own-seat attention

  get ownAttention(): OwnAttention {
    const model = this
    return {
      get cold() { return model.ownAttentionCold },
      get workingSince() { return model.ownAttentionWorkingSince },
      get firstSessionId() { return model.ownAttentionFirstSessionId },
      get railWaiting() { return model.ownAttentionRailWaiting },
      get sessionIds() { return model.ownAttentionSessionIds },
      get sidebarFacts() { return model.ownAttentionSidebarFacts },
      get updatedAt() { return model.ownAttentionUpdatedAt },
      get order() { return model.ownAttentionOrder },
      get decidingAt() { return model.ownAttentionDecidingAt },
      get seated() { return model.ownAttentionSeated },
      get working() { return model.ownAttentionWorking },
      get deciding() { return model.ownAttentionDeciding },
      get open() { return model.ownAttentionOpen },
      get finished() { return model.ownAttentionFinished },
      get pending() { return model.ownAttentionPending },
    }
  }

  @lazy
  private get ownAttentionCold(): OwnAttention['cold'] {
    return this.readOwnAttention().cold
  }

  @lazy
  private get ownAttentionWorkingSince(): OwnAttention['workingSince'] {
    return this.readOwnAttention().workingSince
  }

  @lazy
  private get ownAttentionFirstSessionId(): OwnAttention['firstSessionId'] {
    return this.readOwnAttention().firstSessionId
  }

  private get ownAttentionRailWaiting(): NonNullable<Aggregate['railWaiting']> | undefined {
    if (!this.ownAttentionRailWaitingPresent) return undefined
    const model = this
    return {
      get open() { return model.ownAttentionRailWaitingOpen },
      get finished() { return model.ownAttentionRailWaitingFinished },
      get decisions() { return model.ownAttentionRailWaitingDecisions },
    }
  }

  @lazy
  private get ownAttentionRailWaitingPresent(): boolean {
    return this.readOwnAttention().railWaiting !== undefined
  }

  @lazy
  private get ownAttentionRailWaitingOpen(): NonNullable<Aggregate['railWaiting']>['open'] {
    return this.readOwnAttention().railWaiting!.open
  }

  @lazy
  private get ownAttentionRailWaitingFinished(): NonNullable<Aggregate['railWaiting']>['finished'] {
    return this.readOwnAttention().railWaiting!.finished
  }

  @lazy
  private get ownAttentionRailWaitingDecisions(): NonNullable<Aggregate['railWaiting']>['decisions'] {
    return this.readOwnAttention().railWaiting!.decisions
  }

  private get ownAttentionSessionIds(): OwnAttention['sessionIds'] {
    return attentionSessions(this).get()
  }

  /** @internal Ordered identities from the worklist's seat policy. */
  createAttentionSessionQuery() {
    return createIdentityQuery({ name: `worklist@${this.id}.attentionSessions`,
      ids: () => this.readOwnAttention().sessionIds ?? [] })
  }

  private get ownAttentionSidebarFacts(): SidebarSessionFacts | undefined {
    if (!this.ownAttentionSidebarFactsPresent) return undefined
    const model = this
    return {
      get fleet() { return model.ownAttentionSidebarFactsFleet },
      get working() { return model.ownAttentionSidebarFactsWorking },
      get waitingOpen() { return model.ownAttentionSidebarFactsWaitingOpen },
      get waitingFinished() { return model.ownAttentionSidebarFactsWaitingFinished },
      get doneSince() { return model.ownAttentionSidebarFactsDoneSince },
      get totalMs() { return model.ownAttentionSidebarFactsTotalMs },
      get errorClass() { return model.ownAttentionSidebarFactsErrorClass },
      get allUnstarted() { return model.ownAttentionSidebarFactsAllUnstarted },
    }
  }

  @lazy
  private get ownAttentionSidebarFactsPresent(): boolean {
    return this.readOwnAttention().sidebarFacts !== undefined
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionSidebarFactsFleet(): SidebarSessionFacts['fleet'] {
    return this.readOwnAttention().sidebarFacts!.fleet
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionSidebarFactsWorking(): SidebarSessionFacts['working'] {
    return this.readOwnAttention().sidebarFacts!.working
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionSidebarFactsWaitingOpen(): SidebarSessionFacts['waitingOpen'] {
    return this.readOwnAttention().sidebarFacts!.waitingOpen
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionSidebarFactsWaitingFinished(): SidebarSessionFacts['waitingFinished'] {
    return this.readOwnAttention().sidebarFacts!.waitingFinished
  }

  @lazy
  private get ownAttentionSidebarFactsDoneSince(): SidebarSessionFacts['doneSince'] {
    return this.readOwnAttention().sidebarFacts!.doneSince
  }

  @lazy
  private get ownAttentionSidebarFactsTotalMs(): SidebarSessionFacts['totalMs'] {
    return this.readOwnAttention().sidebarFacts!.totalMs
  }

  @lazy
  private get ownAttentionSidebarFactsErrorClass(): SidebarSessionFacts['errorClass'] {
    return this.readOwnAttention().sidebarFacts!.errorClass
  }

  @lazy
  private get ownAttentionSidebarFactsAllUnstarted(): SidebarSessionFacts['allUnstarted'] {
    return this.readOwnAttention().sidebarFacts!.allUnstarted
  }

  @lazy
  private get ownAttentionUpdatedAt(): OwnAttention['updatedAt'] {
    return this.readOwnAttention().updatedAt
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionOrder(): OwnAttention['order'] {
    return this.readOwnAttention().order
  }

  @lazy
  private get ownAttentionDecidingAt(): OwnAttention['decidingAt'] {
    return this.readOwnAttention().decidingAt
  }

  @lazy
  private get ownAttentionSeated(): OwnAttention['seated'] {
    return this.readOwnAttention().seated
  }

  @lazy
  private get ownAttentionWorking(): OwnAttention['working'] {
    return this.readOwnAttention().working
  }

  @lazy
  private get ownAttentionDeciding(): OwnAttention['deciding'] {
    return this.readOwnAttention().deciding
  }

  private get ownAttentionOpen(): import('./rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.ownAttentionOpenWaiting },
      get working() { return model.ownAttentionOpenWorking },
      get allDone() { return model.ownAttentionOpenAllDone },
    }
  }

  @lazy
  private get ownAttentionOpenWaiting(): import('./rollup').PhaseFlags['waiting'] {
    return this.readOwnAttention().open.waiting
  }

  @lazy
  private get ownAttentionOpenWorking(): import('./rollup').PhaseFlags['working'] {
    return this.readOwnAttention().open.working
  }

  @lazy
  private get ownAttentionOpenAllDone(): import('./rollup').PhaseFlags['allDone'] {
    return this.readOwnAttention().open.allDone
  }

  private get ownAttentionFinished(): import('./rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.ownAttentionFinishedWaiting },
      get working() { return model.ownAttentionFinishedWorking },
      get allDone() { return model.ownAttentionFinishedAllDone },
    }
  }

  @lazy
  private get ownAttentionFinishedWaiting(): import('./rollup').PhaseFlags['waiting'] {
    return this.readOwnAttention().finished.waiting
  }

  @lazy
  private get ownAttentionFinishedWorking(): import('./rollup').PhaseFlags['working'] {
    return this.readOwnAttention().finished.working
  }

  @lazy
  private get ownAttentionFinishedAllDone(): import('./rollup').PhaseFlags['allDone'] {
    return this.readOwnAttention().finished.allDone
  }

  @lazy
  private get ownAttentionPending(): OwnAttention['pending'] {
    return this.readOwnAttention().pending
  }

  // ------------------------------------------------------ nested attention

  get aggregate(): Aggregate { return filingAttention(this).value }
  get rowAggregate(): Aggregate { return drawnAttention(this).value }

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
  get rowBelow(): readonly string[] { return worklistLists(this).drawnBelow.get() }
  get rowNested(): readonly string[] { return worklistLists(this).drawnNested.get() }
  get rowParts(): import('./rollup').RollupSelf {
    const row = this
    return {
      get ownFacts() { return row.ownFacts }, get formalParent() { return row.formalParent },
      get updatedMs() { return row.issue.updatedMs },
      get openOwn() { return row.openOwn }, get present() { return row.present },
      get seatIds() { return row.seatIds },
      get rosterIds() { return row.rosterIds }, get finished() { return row.finished },
      get tip() { return row.tip }, get ownAttention() { return row.ownAttention },
      get aggregate() { return row.rowAggregate }, get unitOwn() { return row.unitOwn },
      get unitsBelow() { return row.unitsBelow }, get seatActivity() { return row.rowSeatActivity },
      get rollup() { return rollupPartOf(row.rowParts) },
    }
  }
  @lazy get rowSeatActivity(): number | null { return seatActivityPartOf(this.worklist.rowInputs, this.id, this.rowParts) }
  @lazy get rowActivityAt(): number {
    const own = this.ownActivityAt, seat = this.rowSeatActivity
    return seat !== null && seat > own ? seat : own
  }

  @lazy private get rowOwn() { return this.host.rollupInputs.loadedIssue(this.id) }
  @lazy private get rowOrigin() { return this.originRef === null ? undefined : this.host.rollupInputs.loadedIssue(this.originRef) }
  private get rowTip() { return !this.targetId && !this.openOwn ? this.tip : undefined }
  @lazy private get targetId() { return this.issue.supersededBy ?? this.issue.duplicateOf }
  @lazy private get rowState(): 'ready' | typeof LOADING | undefined {
    if (this.rowOwn === LOADING || this.rowOrigin === LOADING) return LOADING
    if (this.rowOwn === undefined) return undefined
    if (this.rowAggregate.pending > 0 || this.unitsBelow.pending > 0 || this.unitOwn.cold || (this.rowTip?.pending ?? 0) > 0) return LOADING
    if (this.targetId && this.host.rollupInputs.loadedIssue(this.targetId) === LOADING) return LOADING
    return 'ready'
  }

  // Value adapters borrow live fields. Components receive the companion.
  private get sidebarRecord() { return sidebarPort(this) }
  private get mobileRecord() { return mobilePort(this) }
  get sidebar(): import('./rollup').Loaded<SidebarRowValues> { return this.rowState === 'ready' ? this.sidebarRecord : this.rowState }
  get mobile(): import('./rollup').Loaded<MobileRowValues> { return this.rowState === 'ready' ? this.mobileRecord : this.rowState }

  get rowIssue(): SliceIssue & { readonly displayRef: string } { return issuePort(this) }

  /** @internal Wire vocabulary for formatters; all facts are read on the model. */
  createIssuePort(): SliceIssue & { readonly displayRef: string } {
    const row = this
    return new Proxy(Object.create(null), {
      get(_target, key) {
        return key === 'unread' ? row.unread : key in row.issue
          ? Reflect.get(row.issue, key) : Reflect.get(row.rowOwn as object, key)
      },
      ownKeys() { return [...new Set([...Object.keys(row.rowOwn as object),
        'displayRef', 'repoPath', 'readAt', 'unread'])] },
      getOwnPropertyDescriptor() { return { enumerable: true, configurable: true } },
    }) as SliceIssue & { readonly displayRef: string }
  }
  @lazy get rowSessions(): readonly SliceSession[] {
    const sessions: SliceSession[] = []
    for (const id of this.ownAttention.sessionIds ?? []) {
      const session = omitGone(this.host.row('session', id))
      if (session !== undefined && session !== LOADING) sessions.push(session as SliceSession)
    }
    return sessions
  }

  @lazy get rowPhase() { return phaseOf(this.rowAggregate, this.ownFacts.finished) }
  @lazy get rowWorking() { return this.rowAggregate.working }
  @lazy get rowAsking() { return askingOf(this.rowAggregate, this.ownFacts.finished) }
  @lazy get rowDecision() { return this.ownAttention.deciding ? this.ownFacts.decision : null }
  @lazy({ equals: compareStructural }) get rowOriginTick(): RowOriginTick | null {
    const origin = this.rowOrigin
    return origin === undefined || origin === LOADING ? null : {
      id: origin.id, seq: origin.seq, title: origin.title,
      ref: this.host.inputs.parts(origin.id)?.label.displayRef ?? `#${origin.seq}`,
    }
  }
  @lazy({ equals: compareStructural }) get rowProgress(): SidebarProgress | typeof LOADING {
    const below = this.unitsBelow, own = this.unitOwn
    if (below.pending > 0 || own.cold) return LOADING
    return below.members > 0
      ? { done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0, ...below.progress, total: below.units }
      : { done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0, total: own.solo ? 1 : 0,
        ...(own.solo ? { [own.state ?? 'wait']: 1 } : {}) }
  }
  @lazy get rowFromChildren() { return this.unitsBelow.members > 0 }
  @lazy get rowStatusFromChildren() { return this.nestParent === null && this.rowFromChildren }
  @lazy({ equals: compareStructural }) get rowTiming() {
    return sidebarTimingFromFacts(this.rowAggregate.sidebarFacts ?? NO_SIDEBAR_SESSIONS,
      this.rowPhase, this.ownFacts.finished, this.rowActivityAt, this.rowAggregate.decidingAt)
  }
  @lazy get rowUnread(): boolean {
    if (this.rowWorking) return false
    const readAt = this.issue.readAt, readMs = Date.parse(readAt ?? '')
    return this.unread || Boolean(readAt && Number.isFinite(readMs) &&
      ((Date.parse(this.rowAggregate.updatedAt ?? '') || 0) > readMs || (this.rowSeatActivity ?? 0) > readMs) && this.rowNested.length > 0)
  }
  @lazy get rowErrorClass() { return this.ownFacts.finished ? null : (this.rowAggregate.sidebarFacts ?? NO_SIDEBAR_SESSIONS).errorClass }
  @lazy get rowInternal() { return this.issue.audience === 'agent' }
  @lazy get rowDraftAgentOnly() { return this.issue.isDraftVessel === true && !this.issue.worktreePath && this.rowSessions.length > 0 }
  @lazy get rowFirstSessionId() { return this.ownAttention.firstSessionId ?? null }
  @lazy get rowAwaitingFirstPrompt() {
    return this.issue.isDraftVessel === true && this.rowPhase === 'queued' &&
      (this.rowAggregate.sessionIds?.length ?? 0) > 0 && (this.rowAggregate.sidebarFacts ?? NO_SIDEBAR_SESSIONS).allUnstarted
  }
  @lazy({ equals: compareStructural }) get rowContinuation(): SidebarRowValues['continuation'] {
    if (this.targetId) return { kind: this.issue.supersededBy ? 'continued' : 'duplicate',
      ref: this.host.inputs.parts(this.targetId)?.label.displayRef ?? 'another task' }
    const destination = this.rowTip?.target
    return destination ? { kind: 'continued', ref: this.host.inputs.parts(destination.id)?.label.displayRef ?? `#${destination.seq}` } : null
  }
  private readLifecycle() { return sidebarLifecycle(this.rowIssue, this.rowAsking, this.host.inputs.passed, this.host.inputs.reached, this.issue) }
  @lazy get rowDeferred() { return this.readLifecycle().deferred }
  @lazy get rowUnsnoozed() { return this.readLifecycle().unsnoozed }
  @lazy get rowAwaitsTuck() { return this.readLifecycle().awaitsTuck }
  @lazy get rowCanBringBack() { return this.readLifecycle().canBringBack }

  @lazy get mobileWaitingCount() { return mobileWaitingCount(this.rowAggregate, this.finished === true) }
  @lazy get mobileDraftQuiet() {
    const first = this.rowSessions[0]
    return this.rowDraftAgentOnly && !first?.busy && (first?.agentState?.phase ?? 'unknown') === 'unknown'
  }
  @lazy get mobileUnread() { return this.rowUnread && !this.mobileDraftQuiet }
  @lazy get mobileAttentionAction() { return this.mobileWaitingCount > 0 ? this.rowDecision ? 'Review' as const : 'Answer' as const : null }
  @lazy({ equals: compareStructural }) get mobileNavigation(): MobileRowValues['navigation'] {
    const first = this.rowSessions[0]
    return this.rowDraftAgentOnly && first ? { kind: 'session', id: first.sessionId } : { kind: 'issue', id: this.id }
  }

  /** @internal Getter-only formatter port; created once by the companion factory. */
  createSidebarPort(): SidebarRowValues {
    const row = this
    return {
      get idNumber() { return row.issue.seq }, get color() { return row.issue.color ?? null },
      get title() { return row.title }, get timing() { return row.rowTiming },
      get working() { return row.rowWorking }, get asking() { return row.rowAsking },
      get originTick() { return row.rowOriginTick }, get decision() { return row.rowDecision },
      get mergeCommits() { return row.rowDecision === 'merge' ? row.issue.gitState?.ahead ?? 0 : 0 },
      get progress() { return row.rowProgress as SidebarProgress },
      get fromChildren() { return row.rowFromChildren }, get statusFromChildren() { return row.rowStatusFromChildren },
      get gitState() { return row.issue.gitState }, get unread() { return row.rowUnread },
      get errorClass() { return row.rowErrorClass }, get internal() { return row.rowInternal },
      get awaitsTuck() { return row.rowAwaitsTuck }, get canBringBack() { return row.rowCanBringBack },
      get unsnoozed() { return row.rowUnsnoozed }, get deferred() { return row.rowDeferred },
      get draftAgentOnly() { return row.rowDraftAgentOnly }, get firstSessionId() { return row.rowFirstSessionId },
      get continuation() { return row.rowContinuation },
      get fleet() { return (row.rowAggregate.sidebarFacts ?? NO_SIDEBAR_SESSIONS).fleet },
      get issue() { return row.rowIssue }, get sessions() { return row.rowSessions },
      get aggregateSessionIds() { return row.rowAggregate.sessionIds ?? [] },
      get awaitingFirstPrompt() { return row.rowAwaitingFirstPrompt },
    }
  }

  /** @internal Getter-only formatter port; created once by the companion factory. */
  createMobilePort(): MobileRowValues {
    const row = this
    return {
      get id() { return row.id }, kind: 'issue', get label() { return row.title },
      get progress() { return row.rowProgress as SidebarProgress }, get originSeq() { return row.rowOriginTick?.seq ?? null },
      get timing() { return row.rowTiming }, get working() { return row.rowWorking },
      get waitingCount() { return row.mobileWaitingCount }, get decision() { return row.rowDecision },
      get unread() { return row.mobileUnread }, get draftOnly() { return row.rowDraftAgentOnly },
      get draftQuiet() { return row.mobileDraftQuiet }, get color() { return row.issue.color ?? null },
      get internal() { return row.rowInternal }, get pinned() { return row.issue.pinned === true },
      get snoozed() { return row.rowDeferred }, get unsnoozed() { return row.rowUnsnoozed },
      get tuckable() { return row.rowAwaitsTuck }, get fleet() { return row.sidebarRecord.fleet },
      get branch() { return row.issue.branch ?? null }, get gitState() { return row.issue.gitState },
      get suppressAhead() { return row.rowDecision === 'merge' },
      get attentionAction() { return row.mobileAttentionAction }, get navigation() { return row.mobileNavigation },
      get sidebar() { return row.sidebarRecord }, get sessions() { return row.rowSessions },
      get activityAt() { return row.rowActivityAt },
    }
  }

}
