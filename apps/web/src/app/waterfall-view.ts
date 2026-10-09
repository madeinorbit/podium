import { isCoordinatorSession } from '@podium/client-core/values'
import type { MissionScreen } from '@podium/client-graph/mission-screen'
import type { MissionDeckIssueModel } from '@podium/client-graph/mission-view'
import { requireLoaded } from '@podium/client-graph/mission-view'
import { here, omitGone } from '@podium/client-graph/lookup'
import type { SessionModel } from '@podium/client-graph/models'
import { companion, lazy } from '@podium/mobx-helpers'
import { action, compareShallow, observable, observableRef, runInAction } from 'mobx'
import {
  waterfallSessionStart, waterfallSessionEnd, waterfallSegments,
  type WaterfallActivitySample,
} from './flight-deck-waterfall'

export type ActivityQuery = (input: { sessionIds: string[] }) => Promise<{
  sessions?: Record<string, Array<{ at: string; phase: string }>>
}>

/** A request answer belongs to this opening, alongside the shared session. */
export class WaterfallSession {
  constructor(readonly session: SessionModel, readonly view: WaterfallView) {}
  @observableRef accessor samples: readonly WaterfallActivitySample[] = []
  @observable accessor loading = false
  @observable accessor error: string | null = null
  private requestedPhase: string | undefined
  private requestedSettled = false
  private requestedGeneration = -1
  private request = 0
  private demands = 0

  @lazy get startMs(): number { return waterfallSessionStart(this.session, this.view.openedNow ?? 0) }
  /** Stored-on-open fallback. Retained geometry never observes a clock. */
  @lazy get endMs(): number { return Math.max(this.startMs, waterfallSessionEnd(this.session, this.view.openedNow ?? 0)) }
  @lazy get historyEndMs(): number { return this.settled ? this.endMs : Math.max(this.endMs, this.samples.at(-1)?.at ?? this.endMs) }
  @lazy get phase(): string { return this.session.phase }
  @lazy get settled(): boolean { return this.session.settled }
  @lazy get segments() { return waterfallSegments(this.samples, this.startMs, this.historyEndMs) }

  @action demand(): () => void {
    this.demands++
    this.load()
    return action(() => { this.demands-- })
  }

  /** The endpoint supplies the complete 48h pan domain plus its prior sample.
   * Request once on first visibility; live phase pushes refresh only this ID.
   * A tick, width change or pan within that loaded domain never refetches it. */
  @action load(): void {
    const query = this.view.query
    if (!query || this.view.closed || this.demands === 0) return
    if (this.requestedGeneration === this.view.generation && this.requestedPhase !== undefined && (this.requestedSettled === this.settled && this.requestedPhase === this.phase)) return
    this.requestedPhase = this.phase
    this.requestedSettled = this.settled
    this.requestedGeneration = this.view.generation
    const generation = this.view.generation
    const request = ++this.request
    this.loading = true
    this.error = null
    void query({ sessionIds: [this.session.id] }).then(result => runInAction(() => {
      if (this.view.closed || generation !== this.view.generation || request !== this.request) return
      this.loading = false
      this.samples = (result.sessions?.[this.session.id] ?? [])
        .map(sample => ({ at: Date.parse(sample.at), phase: sample.phase }))
        .filter(sample => Number.isFinite(sample.at))
    }), error => runInAction(() => {
      if (this.view.closed || generation !== this.view.generation || request !== this.request) return
      this.loading = false
      this.error = error instanceof Error ? error.message : String(error)
      this.requestedPhase = undefined
    }))
  }
}

/** Row questions are asked only by a mounted row, never by the full spine. */
export class WaterfallRow {
  constructor(readonly row: MissionDeckIssueModel, readonly view: WaterfallView) {}
  @observable accessor historyOpen = false
  @lazy({ equals: compareShallow }) get sessionIds(): readonly string[] { return this.row.sessionIds(this.view.screen.mode) }
  @lazy({ equals: compareShallow }) get sessions(): readonly SessionModel[] {
    return this.sessionIds.flatMap(id => {
      const session = requireLoaded(omitGone(this.view.screen.pool.model('session', id)))
      return session ? [session] : []
    })
  }
  @lazy({ equals: compareShallow }) get finishedIds(): readonly string[] {
    return this.sessions.filter(session => session.settled &&
      !isCoordinatorSession(this.row.roleIssue, session.id) &&
      session.id !== this.view.activeSessionId).map(session => session.id)
  }
  @lazy get historyCollapsed(): boolean { return this.finishedIds.length > 3 }
  @lazy({ equals: compareShallow }) get drawnSessionIds(): readonly string[] {
    if (!this.historyCollapsed || this.historyOpen) return this.sessionIds
    const folded = new Set(this.finishedIds)
    return this.sessionIds.filter(id => !folded.has(id))
  }
  @lazy get laneCount(): number { return Math.max(1, this.drawnSessionIds.length + Number(this.historyCollapsed)) }
  @lazy get coordinatorId(): string | undefined {
    return this.sessionIds.find(id => isCoordinatorSession(this.row.roleIssue, id))
  }
  @lazy get historyBounds(): { startedAt: number; endedAt: number } {
    let startedAt = this.view.openedNow ?? 0
    let endedAt = -Infinity
    for (const id of this.finishedIds) {
      const fact = this.view.seat(this.view.screen.pool.sessionObject(id))
      startedAt = Math.min(startedAt, fact.startMs)
      endedAt = Math.max(endedAt, fact.endMs)
    }
    return { startedAt, endedAt: Math.max(startedAt, endedAt) }
  }
  @action toggleHistory(): void { this.historyOpen = !this.historyOpen }
}

/** Dropped when the waterfall closes. Lists contain IDs or shared companions;
 * no crew projection, fingerprints, or ID-to-record cache. */
export class WaterfallView {
  constructor(readonly screen: MissionScreen, readonly query?: ActivityQuery) {}
  @observable accessor openedNow: number | null = null
  @observable accessor activeSessionId: string | null = null
  @observable accessor followedSessionId: string | null = null
  closed = false
  generation = 0
  readonly row = companion((row: MissionDeckIssueModel) => new WaterfallRow(row, this))
  readonly seat = companion((session: SessionModel) => new WaterfallSession(session, this))
  @lazy({ equals: compareShallow }) get rows(): readonly MissionDeckIssueModel[] {
    return this.screen.rootRow ? [this.screen.rootRow, ...this.screen.visibleRows] : []
  }
  @lazy({ equals: compareShallow }) get rowIds(): readonly string[] { return this.rows.map(row => row.key) }
  @lazy get followed(): SessionModel | undefined {
    return this.followedSessionId ? here(this.screen.pool.model('session', this.followedSessionId)) : undefined
  }
  @action resume(): void { this.closed = false }
  @action open(now: number): void { this.closed = false; if (this.openedNow === null) this.openedNow = now }
  @action focus(id: string | null): void {
    this.activeSessionId = id
    if (id) this.followedSessionId = id
  }
  /** Choose a seed from the first window on open, never retained history on a tick. */
  @action seed(rows: readonly MissionDeckIssueModel[]): void {
    if (this.followedSessionId) return
    let fallback: string | undefined
    for (const row of rows) for (const session of this.row(row).sessions) {
      fallback ??= session.id
      if (!session.settled) { this.followedSessionId = session.id; return }
    }
    this.followedSessionId = fallback ?? null
  }
  @action close(): void { this.closed = true; this.generation++ }
}

