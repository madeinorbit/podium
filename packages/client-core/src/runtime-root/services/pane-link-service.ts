import type { CheckoutRepository } from '@podium/model'
import { isShortSessionIdentifier, type SessionIdentifierResolution } from '@podium/protocol'
import type { StoreNotices } from '../../engine/types'
import type { NavigationIntent } from '../../ui/navigation'
import { sessionLinkProblem, sessionLinkSelection } from '../../ui/session-link'
import {
  NAVIGATION_LOADING,
  navigationSession,
  overlayState,
  type ScreenState,
  type WorkspacePatch,
  workspaceFor,
  workspaceKeyForState,
  workspaceMirrorPatch,
  workspacesPatch,
} from '../../ui/state'
import type { Router, RouteState } from '../../ui-state'
import { allTabIds, closeTab } from '../../values'
import { ServiceLifetime } from './lifetime'
import { observeNavigation } from './observe-navigation'
import { WORKSPACE_PRUNE_GRACE_MS } from './tab-pruning-service'

export interface PaneLinkPorts {
  state(): ScreenState
  publish(patch: Partial<ScreenState>): void
  router: Router
  notices: StoreNotices
  resolve(identifier: string): Promise<SessionIdentifierResolution>
  repositories(): readonly CheckoutRepository[]
  navigate(intent: NavigationIntent): boolean
  openWorkspaceTab(tabId: string): WorkspacePatch
  fallback(): void
  graceMs?: number
}

/** Resolves ?pane= links once, keeps cold full ids provisional and cancels
 * requests/timers when navigation or this user's lifetime supersedes them. */
export class PaneLinkService {
  private readonly lifetime = new ServiceLifetime()
  private request = 0
  private pendingShort: string | null = null
  private pendingFull: {
    sessionId: string
    worktree: string | null
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private readonly graceMs: number
  private stopWatch: (() => void) | undefined
  constructor(private readonly ports: PaneLinkPorts) {
    this.graceMs = ports.graceMs ?? WORKSPACE_PRUNE_GRACE_MS
  }
  get pendingPane(): string | null {
    return this.pendingFull?.sessionId ?? this.pendingShort
  }
  get linkedWorktree(): string | null {
    return this.pendingFull?.worktree ?? null
  }
  start(): void {
    if (!this.lifetime.start()) return
    this.follow(this.ports.router.current())
    this.refreshWatch()
  }
  private refreshWatch(): void {
    if (!this.lifetime.active) return
    const previous = this.stopWatch
    this.stopWatch = observeNavigation(
      () => this.ports.state().navigation,
      () => {
        if (!this.pendingFull) return []
        const session = this.ports.state().navigation.session(this.pendingFull.sessionId)
        return session && session !== NAVIGATION_LOADING
          ? [session.sessionId, session.issueId, session.cwd]
          : [session]
      },
      () => this.retry(),
    )
    previous?.()
  }
  private retry(): void {
    if (!this.lifetime.active || !this.pendingFull) return
    if (!this.openLinkedSession(this.pendingFull.sessionId, this.pendingFull.worktree))
      this.ports.publish(this.ports.openWorkspaceTab(this.pendingFull.sessionId))
  }
  stop(): void {
    this.lifetime.stop()
    this.stopWatch?.()
    this.stopWatch = undefined
    this.cancel()
  }
  dispose(): void {
    this.stop()
    this.lifetime.dispose()
  }
  resolve(pane: string | null | undefined): void {
    if (!pane || !isShortSessionIdentifier(pane)) {
      this.pendingShort = null
      return
    }
    if (navigationSession(this.ports.state(), pane)) return
    this.pendingShort = pane
    if (!this.lifetime.active) return
    const alive = this.lifetime.guard()
    const request = ++this.request
    const current = () => alive() && request === this.request
    void Promise.resolve()
      .then(() => (current() ? this.ports.resolve(pane) : undefined))
      .then(
        (answer) => {
          if (current() && answer) this.adoptPaneLinkAnswer(pane, answer)
        },
        (error: unknown) => void error,
      )
  }

  private adoptPaneLinkAnswer(pane: string, answer: SessionIdentifierResolution): void {
    if (!this.lifetime.active || this.pendingShort !== pane) return
    this.pendingShort = null
    if (answer.kind === 'session') {
      const route = this.ports.router.current()
      this.ports.router.replace({ ...route, view: 'workspace', pane: answer.sessionId })
    } else {
      this.ports.notices.error(sessionLinkProblem(pane, answer))
    }
    this.ports.publish(
      workspacesPatch(this.ports.state(), (ws) =>
        allTabIds(ws).includes(pane) ? closeTab(ws, pane) : ws,
      ),
    )
    // A COLD link seeds `paneA` from the URL before any layout holds it, so no
    // tab closed above; re-derive the scalars from the layout on screen.
    if (this.ports.state().paneA === pane) {
      this.ports.publish(
        workspaceMirrorPatch(
          workspaceFor(this.ports.state(), workspaceKeyForState(this.ports.state())),
        ),
      )
    }
  }

  follow(route: RouteState): void {
    const pane = route.pane
    this.cancel()
    this.resolve(pane)
    if (!pane) return
    const short = isShortSessionIdentifier(pane)
    if (!short && this.openLinkedSession(pane, route.worktree ?? null)) return
    // A deep-linked pane is an OPEN, so the workspace it lands in gains the tab;
    // the mirror would otherwise erase it on the next layout write.
    this.ports.publish(this.ports.openWorkspaceTab(pane))
    if (short || pane.startsWith('file:') || !this.lifetime.active) return
    const timer = setTimeout(() => {
      if (this.pendingFull?.sessionId !== pane) return
      this.cancel()
      if (!this.lifetime.active || navigationSession(this.ports.state(), pane)) return
      this.ports.notices.error(sessionLinkProblem(pane, { kind: 'absent' }))
      // The held worktree may name nothing now; let the fallback settle it.
      this.ports.fallback()
    }, this.graceMs)
    this.pendingFull = { sessionId: pane, worktree: route.worktree ?? null, timer }
    this.refreshWatch()
  }

  /** Open a linked session this replica holds; false when it holds none. */
  private openLinkedSession(sessionId: string, worktree: string | null): boolean {
    const meta = navigationSession(this.ports.state(), sessionId)
    if (!meta) return false
    this.cancel()
    const selection = sessionLinkSelection(
      this.ports.state(),
      this.ports.repositories(),
      meta,
      worktree,
    )
    // Already the active tab of the workspace it lands in (a plain reload):
    // nothing to move, and a split's focus stays where it was.
    const key = workspaceKeyForState(this.ports.state())
    if (
      key === workspaceKeyForState(overlayState(this.ports.state(), selection)) &&
      workspaceMirrorPatch(workspaceFor(this.ports.state(), key)).paneA === sessionId
    )
      return true
    this.ports.navigate({ view: 'workspace', ...selection, tabId: sessionId, history: 'view' })
    return true
  }

  cancel(): void {
    this.request++
    this.pendingShort = null
    if (this.pendingFull) clearTimeout(this.pendingFull.timer)
    this.pendingFull = null
  }
}
