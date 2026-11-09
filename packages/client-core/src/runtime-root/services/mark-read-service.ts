import type { IssueId, SessionId } from '@podium/model'
import { actionBound } from 'mobx'
import type { IssueVisitBaseline } from '../../engine/types'
import type { NavigationProvider } from '../../navigation-provider'
import {
  focusedPaneSession,
  foregroundIssue,
  navigationActivityAt,
  navigationIssueReadAt,
  navigationSession,
  type ScreenState,
} from '../../ui/state'
import type { ConnectionService } from '../connection/connection-service'
import { ServiceLifetime } from './lifetime'
import { observeNavigation } from './observe-navigation'
import { ReadAcknowledgements } from './read-acknowledgements'

export const MARK_READ_ON_VIEW_MS = 1200
export interface MarkReadPorts {
  state(): ScreenState
  publishBaseline(value: IssueVisitBaseline | null): void
  isVisible(): boolean
  connection?: Pick<ConnectionService, 'onVisibilityChange'>
  markSessionRead(id: SessionId, at: string): void | Promise<void>
  markIssueRead(id: IssueId, at: string): void | Promise<void>
}

/** Owns read visits and all their timers. UiStore holds the visible baseline. */
export class MarkReadService {
  private readonly lifetime = new ServiceLifetime()
  private readonly sessionReads: ReadAcknowledgements
  private readonly issueReads: ReadAcknowledgements
  private provider: NavigationProvider
  constructor(private readonly ports: MarkReadPorts) {
    this.provider = ports.state().navigation
    const reads = (kind: 'issue' | 'session') =>
      new ReadAcknowledgements({
        observe: (id, at) => this.provider.observeRead?.(kind, id, at) ?? true,
        allowed: (id) => this.provider.automaticReadAllowed?.(kind, id) ?? true,
        leave: (id) => this.provider.leaveReadVisit?.(kind, id),
        save: (id, at) =>
          kind === 'issue'
            ? ports.markIssueRead(id as IssueId, at)
            : ports.markSessionRead(id as SessionId, at),
      })
    this.sessionReads = reads('session')
    this.issueReads = reads('issue')
  }
  private isVisible(): boolean {
    return this.ports.isVisible()
  }
  start(): void {
    if (!this.lifetime.start()) return
    this.lifetime.add(
      observeNavigation(
        () => this.ports.state().navigation,
        () => {
          const state = this.ports.state()
          const focused = state.view === 'workspace' ? focusedPaneSession(state) : null
          const session = focused ? state.navigation.session(focused) : undefined
          const issue = foregroundIssue(state)
          return [
            state.view,
            focused,
            session && typeof session !== 'symbol'
              ? [session.sessionId, session.lastActiveAt, session.unread]
              : session,
            issue
              ? [
                  issue.id,
                  state.navigation.activityAt(issue.id),
                  state.navigation.issueReadAt(issue.id),
                ]
              : null,
          ]
        },
        () => this.update(),
        (provider) => {
          this.leaveReadVisits()
          this.provider = provider
        },
      ),
    )
    if (this.ports.connection)
      this.lifetime.add(this.ports.connection.onVisibilityChange(() => this.update()))
  }
  @actionBound private update(): void {
    if (!this.lifetime.active) return
    this.updateIssueVisitBaseline()
    this.updateMarkReadTimer()
    this.updateIssueMarkReadTimer()
  }
  leaveReadVisits(): void {
    this.sessionReads.dispose()
    this.issueReads.dispose()
  }
  stop(): void {
    this.lifetime.stop()
    this.leaveReadVisits()
  }
  dispose(): void {
    this.stop()
    this.lifetime.dispose()
  }
  /**
   * Preserve the pre-mark-read issue cursor for one foreground visit.
   *
   * Issue replica updates do not move an existing baseline. A mission switch,
   * or returning after the platform hid the app, starts a new visit.
   */
  updateIssueVisitBaseline(): void {
    const state = this.ports.state()
    const issue = this.isVisible() ? foregroundIssue(state) : undefined
    if (!issue) {
      if (state.issueVisitBaseline !== null) this.ports.publishBaseline(null)
      return
    }
    if (state.issueVisitBaseline?.issueId === issue.id) return
    this.ports.publishBaseline({
      issueId: issue.id,
      readAt: navigationIssueReadAt(state, issue.id),
      openedAt: new Date().toISOString(),
    })
  }

  /** Only the focused workspace pane has actually been viewed. Selection in
   * a hidden workspace must never acknowledge its session's activity. */
  updateMarkReadTimer(): void {
    const st = this.ports.state()
    const focusedId = this.isVisible() && st.view === 'workspace' ? focusedPaneSession(st) : null
    const session = focusedId ? navigationSession(st, focusedId) : undefined
    this.sessionReads.update(
      session?.sessionId ?? null,
      session?.lastActiveAt,
      session?.unread === true,
    )
  }

  updateIssueMarkReadTimer(): void {
    const st = this.ports.state()
    const issue = this.isVisible() ? foregroundIssue(st) : undefined
    const activity = issue ? navigationActivityAt(st, issue) : undefined
    const cursor = issue ? navigationIssueReadAt(st, issue.id) : null
    this.issueReads.update(
      issue?.id ?? null,
      activity,
      !!activity && (!cursor || activity > cursor),
    )
  }

  /** Called before reload's local outbox durability barrier. */
  async flushReadAcknowledgements(): Promise<void> {
    await Promise.all([this.sessionReads.settle(), this.issueReads.settle()])
  }
}
