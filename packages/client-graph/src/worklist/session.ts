import { compareStructural } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import { hostOf, type SessionModel } from '../models'
import type { SliceSession } from '../shared/slice-types'
import { attentionGroup, isOfferOnlyAttention, LOADING, type Loaded as LoadedRow, motionPhase, type SeatVerdict } from './rollup'
import { fleetOf, unstarted, type SidebarSessionFacts, type SidebarSessionOrder } from './sidebar-row'
import { type Retention, retentionOf, type SessionVisibility } from './visible'

/** Retention and display contributions of a session in the worklist. */
export class WorklistSession implements SessionVisibility {
  constructor(readonly session: SessionModel) {}
  get id() { return this.session.id }
  get activityMs() { return this.session.activityMs }
  get issueLink() { return this.session.issueLink }
  get worktreeLink() { return this.session.worktreeLink }
  private get host() { return hostOf(this.session) }
  @lazy
  private get hasRetention(): boolean {
    return this.host.visibleInputs.sessionRow(this.id) !== undefined
  }

  private readRetention(): Retention | null {
    return retentionOf(this.host.visibleInputs.sessionRow(this.id))
  }

  /** The ordering question reads scalar facts; session payload replacement
   * with identical motion cannot wake the ordered roster. */
  @lazy private get sortWorking(): boolean {
    return attentionGroup(this.session as unknown as SliceSession) === 'working'
  }
  @lazy get sortKey(): string {
    const until = this.session.snoozedUntil
    const timed = typeof until === 'string' && this.host.inputs.reached(Date.parse(until))
    const rank = this.sortWorking ? 2 : until === null || (typeof until === 'string' && !timed) ? 1 : 0
    const active = this.session.lastActivity
    const draft = this.session.draftUpdatedAt
    const latest = draft && draft > active ? draft : active
    const recency = timed && until > latest ? until : latest
    return JSON.stringify([rank, recency, this.session.createdAt ?? ''])
  }
  @lazy get stale(): boolean {
    return !this.sortWorking && this.host.inputs.passed((Date.parse(this.session.lastActivity) || 0) + 16 * 60 * 60 * 1000)
  }

  // Close and retention: sidebar history also considers read/grace state

  get retention(): Retention | null {
    if (!this.hasRetention) return null
    const model = this
    return {
      get issueId() { return model.retentionIssueId },
      get archived() { return model.retentionArchived },
      get seat() { return model.retentionSeat },
      get shell() { return model.retentionShell },
      get exited() { return model.retentionExited },
      get finish() { return model.retentionFinish },
      get unread() { return model.retentionUnread },
      get readMs() { return model.retentionReadMs },
    }
  }

  @lazy
  private get retentionIssueId(): Retention['issueId'] {
    return this.host.visibleInputs.sessionRow(this.id)!.issueId
  }

  @lazy
  private get retentionArchived(): Retention['archived'] {
    return this.session.archived === true
  }

  @lazy
  private get retentionSeat(): Retention['seat'] {
    return !this.retentionArchived && !this.retentionShell
  }

  @lazy
  private get retentionShell(): Retention['shell'] {
    return this.host.visibleInputs.sessionRow(this.id)!.agentKind === 'shell'
  }

  @lazy
  private get retentionExited(): Retention['exited'] {
    return this.host.visibleInputs.sessionRow(this.id)!.status === 'exited'
  }

  @lazy({ equals: compareStructural })
  private get retentionFinish(): Retention['finish'] {
    return this.readRetention()!.finish
  }

  @lazy
  private get retentionUnread(): Retention['unread'] {
    return this.host.visibleInputs.sessionRow(this.id)!.unread === true
  }

  @lazy
  private get retentionReadMs(): Retention['readMs'] {
    const readAt = this.host.visibleInputs.sessionRow(this.id)!.readAt
    return typeof readAt === 'string' && readAt ? Date.parse(readAt) || 0 : null
  }

  @lazy
  private get verdictState(): 'ready' | typeof LOADING | undefined {
    const state = this.host.resident('session', this.id)
    return state === 'resident' ? 'ready' : state === 'loading' ? LOADING : undefined
  }

  private get verdictRow(): SliceSession {
    return this.host.visibleInputs.loadedSession(this.id) as SliceSession
  }

  // Presence: resident sidebar verdicts (LOADING while cold)

  get verdict(): LoadedRow<SeatVerdict> {
    const state = this.verdictState
    if (state !== 'ready') return state
    const model = this
    return {
      get open() { return model.verdictOpen },
      get finished() { return model.verdictFinished },
      get working() { return model.session.executing },
      get workingSinceMs() { return model.verdictWorkingSinceMs },
      get id() { return model.verdictId },
      get sidebarFacts() { return model.verdictSidebarFacts },
      get sidebarOrder() { return model.verdictSidebarOrder },
    }
  }

  // An open row uses the record's motion; only a finished row suppresses
  // offer-only attention. Borrow the shared lazy field without another cache.
  private get verdictOpen(): SeatVerdict['open'] {
    return this.session.motion
  }

  @lazy
  private get verdictFinished(): SeatVerdict['finished'] {
    return motionPhase(this.verdictRow, true, () => this.session.executing)
  }

  private get verdictWorkingSinceMs(): SeatVerdict['workingSinceMs'] {
    return this.session.executionSinceMs
  }

  private get verdictId(): SeatVerdict['id'] {
    return this.id
  }

  private get verdictSidebarFacts(): SidebarSessionFacts | undefined {
    const model = this
    return {
      get fleet() { return model.verdictSidebarFactsFleet },
      get working() { return model.verdictSidebarFactsWorking },
      get waitingOpen() { return model.verdictSidebarFactsWaitingOpen },
      get waitingFinished() { return model.verdictSidebarFactsWaitingFinished },
      get doneSince() { return model.verdictSidebarFactsDoneSince },
      get totalMs() { return model.verdictSidebarFactsTotalMs },
      get errorClass() { return model.verdictSidebarFactsErrorClass },
      get allUnstarted() { return model.verdictSidebarFactsAllUnstarted },
    }
  }

  @lazy({ equals: compareStructural })
  private get verdictSidebarFactsFleet(): SidebarSessionFacts['fleet'] {
    return fleetOf([this.verdictRow], () => this.session.open)
  }

  @lazy({ equals: compareStructural })
  private get verdictSidebarFactsWorking(): SidebarSessionFacts['working'] {
    if (!this.session.executing) return undefined
    const row = this.verdictRow
    const stateSince = this.session.stateSinceMs
    return { stateSince, sinceMs: stateSince,
      ...(row.agentState?.workingMsTotal !== undefined ? { baseMs: row.agentState.workingMsTotal } : {}) }
  }

  @lazy({ equals: compareStructural })
  private get verdictSidebarFactsWaitingOpen(): SidebarSessionFacts['waitingOpen'] {
    return this.verdictOpen === 'waiting' ? this.verdictWaitingAnchor : undefined
  }

  @lazy({ equals: compareStructural })
  private get verdictSidebarFactsWaitingFinished(): SidebarSessionFacts['waitingFinished'] {
    return this.verdictFinished === 'waiting' ? this.verdictWaitingAnchor : undefined
  }

  @lazy({ equals: compareStructural })
  private get verdictWaitingAnchor(): NonNullable<SidebarSessionFacts['waitingOpen']> {
    const row = this.verdictRow
    const stateSince = this.session.stateSinceMs
    return { stateSince, sinceMs: Date.parse(row.offer?.createdAt ?? '') || stateSince }
  }

  @lazy
  private get verdictSidebarFactsDoneSince(): SidebarSessionFacts['doneSince'] {
    return this.session.stateSinceMs || 0
  }

  @lazy
  private get verdictSidebarFactsTotalMs(): SidebarSessionFacts['totalMs'] {
    return this.verdictRow.agentState?.workingMsTotal
  }

  @lazy
  private get verdictSidebarFactsErrorClass(): SidebarSessionFacts['errorClass'] {
    const row = this.verdictRow
    return this.session.open && row.agentState?.phase === 'errored'
      ? row.agentState.error?.class ?? 'unknown' : null
  }

  @lazy
  private get verdictSidebarFactsAllUnstarted(): SidebarSessionFacts['allUnstarted'] {
    return unstarted(this.verdictRow)
  }

  private get verdictSidebarOrder(): SidebarSessionOrder | undefined {
    const model = this
    return {
      get id() { return model.verdictSidebarOrderId },
      get working() { return model.verdictSidebarOrderWorking },
      get snoozedUntil() { return model.verdictSidebarOrderSnoozedUntil },
      get recency() { return model.verdictSidebarOrderRecency },
      get createdAt() { return model.verdictSidebarOrderCreatedAt },
      get offerOnly() { return model.verdictSidebarOrderOfferOnly },
    }
  }

  private get verdictSidebarOrderId(): SidebarSessionOrder['id'] {
    return this.id
  }

  @lazy
  private get verdictSidebarOrderWorking(): SidebarSessionOrder['working'] {
    return attentionGroup(this.verdictRow) === 'working'
  }

  @lazy
  private get verdictSidebarOrderSnoozedUntil(): SidebarSessionOrder['snoozedUntil'] {
    return this.verdictRow.snoozedUntil
  }

  @lazy
  private get verdictSidebarOrderRecency(): SidebarSessionOrder['recency'] {
    const row = this.verdictRow
    return row.draftUpdatedAt && row.draftUpdatedAt > row.lastActiveAt ? row.draftUpdatedAt : row.lastActiveAt
  }

  @lazy
  private get verdictSidebarOrderCreatedAt(): SidebarSessionOrder['createdAt'] {
    return this.verdictRow.createdAt ?? ''
  }

  @lazy
  private get verdictSidebarOrderOfferOnly(): SidebarSessionOrder['offerOnly'] {
    return isOfferOnlyAttention(this.verdictRow)
  }

}
