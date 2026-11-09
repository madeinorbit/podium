import {
  type CheckoutRepository,
  isMachinePathWithinRoot,
  machinePathsEqual,
  type SessionId,
} from '@podium/model'
import { actionBound, observable, reaction } from 'mobx'
import type { NavigationProvider, NavigationTopologySession } from '../../navigation-provider'
import type { NoticeSink } from '../../notices'
import {
  focusedPaneSession,
  NAVIGATION_LOADING,
  navigationSession,
  overlayState,
  resolvedWorkspaceKey,
  type ScreenState,
  visibleTabIds,
  workspaceWritePatch,
} from '../../ui/state'
import { emptyWorkspace, openTab, planWorktreeMoves, reposToViews } from '../../values'
import { ServiceLifetime } from './lifetime'

export interface FollowPorts {
  state(): ScreenState
  publish(patch: Partial<ScreenState>): void
  notices: NoticeSink
  isVisible(): boolean
  repositories?(): readonly CheckoutRepository[]
  checkoutsKnown?(): boolean
  linkedWorktree?(): string | null
  subscribeCheckouts?(changed: () => void): () => void
  readPending?(): readonly unknown[]
  retryPending?(): void
}

export class FollowService {
  private readonly lifetime = new ServiceLifetime()
  private prevCwds: Record<string, string> = {}
  private prevIssueIds: Record<string, string> = {}
  private stopWatch: (() => void) | undefined
  private stopTopology: (() => void) | undefined
  private queued = false
  @observable accessor pendingTopology = false
  private pendingFallback = false
  private readonly moves = new Map<string, NavigationTopologySession>()
  constructor(private readonly ports: FollowPorts) {}
  private isVisible(): boolean {
    return this.ports.isVisible()
  }
  seedCwds(sessions: { sessionId: SessionId; cwd: string }[]): void {
    this.prevCwds = Object.fromEntries(sessions.map((s) => [s.sessionId, s.cwd]))
  }
  seedIssueIds(sessions: { sessionId: SessionId; issueId?: string }[]): void {
    this.prevIssueIds = Object.fromEntries(sessions.map((s) => [s.sessionId, s.issueId ?? '']))
  }
  start(): void {
    if (!this.lifetime.start()) return
    this.lifetime.add(
      reaction(
        () => this.ports.state().navigation,
        (provider) => {
          this.stopTopology?.()
          this.moves.clear()
          this.prevIssueIds = {}
          this.prevCwds = {}
          this.stopTopology = provider.onTopology?.((delta) => {
            if (!this.lifetime.active) return
            if (delta?.reset && provider.topologySession)
              for (const [id, previous] of this.moves)
                this.moves.set(id, { ...previous, after: provider.topologySession(id) })
            for (const change of delta?.sessions ?? []) {
              const previous = this.moves.get(change.id)
              this.moves.set(
                change.id,
                previous ? { id: change.id, before: previous.before, after: change.after } : change,
              )
            }
            this.setPendingTopology(true)
            this.queueWake(provider)
          })
          this.setPendingTopology(true)
          this.refreshWatch()
          this.queueWake(provider)
        },
        { fireImmediately: true },
      ),
    )
    this.lifetime.add(
      reaction(
        () => {
          const state = this.ports.state()
          return [
            state.selectedWorktree,
            state.selectedIssueId,
            state.view,
            state.openIssueId,
            state.workspaces,
            state.focusedPane,
          ]
        },
        () => {
          if (!this.pendingTopology) this.refreshFallback()
          this.refreshWatch()
        },
      ),
    )
    if (this.ports.subscribeCheckouts)
      this.lifetime.add(
        this.ports.subscribeCheckouts(() => {
          if (!this.pendingTopology) this.refreshFallback()
        }),
      )
  }
  @actionBound private setPendingTopology(value: boolean): void {
    this.pendingTopology = value
  }
  refreshFallback(): void {
    if (!this.lifetime.active) return
    this.pendingFallback = !this.worktreeFallback()
    if (this.pendingFallback) {
      this.refreshWatch()
      this.queueWake(this.ports.state().navigation)
    }
  }
  /** A navigation waiting for a cold row changes its addressed watch. */
  refreshWatch(): void {
    if (!this.lifetime.active) return
    const provider = this.ports.state().navigation
    const previous = this.stopWatch
    const read = () => {
      const state = this.ports.state()
      const focused = focusedPaneSession(state)
      const session = focused ? provider.session(focused) : undefined
      if (
        session &&
        session !== NAVIGATION_LOADING &&
        this.prevIssueIds[session.sessionId] === undefined
      )
        this.prevIssueIds[session.sessionId] = session.issueId ?? ''
      return [
        this.pendingTopology
          ? [...this.moves.values()]
              .filter(
                (change) => change.before && change.after && change.before.cwd !== change.after.cwd,
              )
              .map((change) => [
                provider.worktreeForCwd?.(change.before!.cwd),
                provider.worktreeForCwd?.(change.after!.cwd),
                provider.worktreeSession?.(change.id),
              ])
          : undefined,
        (this.pendingTopology || this.pendingFallback) && provider.registeredWorktree
          ? state.selectedWorktree
            ? [
                provider.registeredWorktree(state.selectedWorktree),
                provider.hasWorktreeSession?.(state.selectedWorktree),
              ]
            : provider.firstWorktree?.()
          : undefined,
        !provider.onTopology ? provider.worktreeSessions?.() : undefined,
        resolvedWorkspaceKey(state),
        session && session !== NAVIGATION_LOADING
          ? [session.sessionId, session.issueId, session.cwd]
          : session,
        this.pendingTopology && session && session !== NAVIGATION_LOADING && session.issueId
          ? resolvedWorkspaceKey(overlayState(state, { selectedIssueId: session.issueId }))
          : undefined,
        ...(this.ports.readPending?.() ?? []),
      ]
    }
    this.stopWatch = provider.watch
      ? provider.watch(read, () => this.queueWake(provider))
      : reaction(read, () => this.queueWake(provider))
    previous?.()
  }
  private queueWake(provider: NavigationProvider): void {
    if (this.queued || !this.lifetime.active) return
    this.queued = true
    const current = this.lifetime.guard()
    queueMicrotask(() =>
      queueMicrotask(() => {
        if (!current()) return
        this.queued = false
        if (this.ports.state().navigation !== provider) {
          this.queueWake(this.ports.state().navigation)
          return
        }
        if (this.pendingTopology) {
          const followed = this.worktreeFollow([...this.moves.values()])
          if (followed) this.moves.clear()
          if (followed && this.worktreeFallback() && this.sessionIssueFollow()) {
            this.setPendingTopology(false)
            this.pendingFallback = false
          }
        }
        if (!this.pendingTopology && this.pendingFallback && this.worktreeFallback())
          this.pendingFallback = false
        this.ports.retryPending?.()
        this.refreshWatch()
      }),
    )
  }
  stop(): void {
    this.lifetime.stop()
    this.stopWatch?.()
    this.stopWatch = undefined
    this.stopTopology?.()
    this.stopTopology = undefined
    this.queued = false
    this.moves.clear()
    this.setPendingTopology(false)
    this.pendingFallback = false
  }
  dispose(): void {
    this.stop()
    this.lifetime.dispose()
  }
  /**
   * When the session the operator is looking at is rehomed onto another issue,
   * follow the selection so the tab lives on the new workspace instead of
   * lingering as a ghost on the origin strip.
   */
  sessionIssueFollow(): boolean {
    const state = this.ports.state()
    const focusedId = focusedPaneSession(state)
    const focusedRow = focusedId ? navigationSession(state, focusedId) : undefined
    const st = state
    const next = focusedRow ? { [focusedRow.sessionId]: focusedRow.issueId ?? '' } : {}
    const prev = this.prevIssueIds
    // Keep the previous owner while a cold destination waits for its root.
    const finish = () => {
      this.prevIssueIds = next
      return true
    }
    if (Object.keys(prev).length === 0) return finish()
    const focused = focusedPaneSession(st)
    if (!focused) return finish()
    const session = st.navigation.session(focused)
    if (session === NAVIGATION_LOADING) return false
    const after = session?.issueId
    const before = prev[focused]
    if (!after || before === undefined || before === after || before === '') return finish()
    if (st.selectedIssueId !== before && st.selectedIssueId !== null) {
      // Looking at a different task — do not yank the operator to the new home.
      // The origin workspace still drops the tab in pruneWorkspaces.
      return finish()
    }
    const nextState = overlayState(st, { selectedIssueId: after })
    const key = resolvedWorkspaceKey(nextState)
    if (key === NAVIGATION_LOADING) return false
    const nextLayout = openTab(st.workspaces[key] ?? emptyWorkspace(key), focused, {
      permanent: true,
    })
    finish()
    this.ports.publish({
      selectedIssueId: after,
      ...workspaceWritePatch(st, key, nextLayout),
    })
    return true
  }

  /** When a session the user is LOOKING AT (in a visible pane) moves out of the
   *  selected worktree, switch the whole view to where it went — otherwise it
   *  silently disappears from the tab strip mid-conversation. A background
   *  session's move never yanks the view; it gets a toast so the user knows
   *  where it now lives in the sidebar. */
  worktreeFollow(changes: readonly NavigationTopologySession[] = []): boolean {
    const st = this.ports.state()
    if (st.navigation.worktreeForCwd) {
      const visible = new Set<string>(this.isVisible() ? visibleTabIds(st) : [])
      const notices: { title: string; destination: string | undefined }[] = []
      let follow: string | null = null
      // Only identities changed since the previous navigation wake participate.
      // Their final source order preserves which visible move follows first.
      const moves = changes
        .filter((change) => change.before && change.after && change.before.cwd !== change.after.cwd)
        .sort((a, b) => {
          const left = a.after?.order ?? '',
            right = b.after?.order ?? ''
          return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id)
        })
      for (const change of moves) {
        const from = st.navigation.worktreeForCwd(change.before!.cwd)
        const to = st.navigation.worktreeForCwd(change.after!.cwd)
        if (from === NAVIGATION_LOADING || to === NAVIGATION_LOADING) return false
        if (from === to) continue
        if (
          follow === null &&
          to != null &&
          from != null &&
          from === st.selectedWorktree &&
          visible.has(change.id)
        ) {
          follow = to
        } else {
          const row = st.navigation.worktreeSession?.(change.id)
          if (row === NAVIGATION_LOADING) return false
          notices.push({
            title: `${row?.name || row?.title || 'A session'} moved worktree`,
            destination: to ?? change.after?.cwd,
          })
        }
      }
      // Resolve the complete changed neighbourhood before producing effects,
      // so a cold notice can retry without repeating already delivered notices.
      if (follow) this.ports.publish({ selectedWorktree: follow })
      for (const notice of notices) this.ports.notices.info(notice.title, notice.destination)
      return true
    }
    const sessions = st.navigation.worktreeSessions?.()
    if (sessions === NAVIGATION_LOADING) return false
    const rows = sessions ?? []
    const prevCwds = this.prevCwds
    this.prevCwds = Object.fromEntries(rows.map((s) => [s.sessionId, s.cwd]))
    const plan = planWorktreeMoves({
      prevCwds,
      sessions: rows,
      worktreePaths: reposToViews(this.ports.repositories?.() ?? []).flatMap((r) =>
        r.worktrees.map((w) => w.path),
      ),
      selectedWorktree: st.selectedWorktree,
      // The same "what is on screen" walk the view-state report uses: a session
      // in a third pane is being looked at just as much as one in the first.
      visiblePanes: this.isVisible() ? visibleTabIds(st) : [],
    })
    if (plan.follow) this.ports.publish({ selectedWorktree: plan.follow })
    for (const move of plan.moved) {
      const s = rows.find((row) => row.sessionId === move.sessionId)
      const dest = move.to ?? s?.cwd
      // The title said the destination's last segment and the description then
      // said the whole path, so the branch name was read twice in one notice —
      // and when there was no destination at all it read "moved to ?". The
      // title names WHAT happened; the path underneath is the only place the
      // destination is stated (POD-1159).
      this.ports.notices.info(`${s?.name || s?.title || 'A session'} moved worktree`, dest)
    }
    return true
  }

  /** Keep the selected worktree valid: wait for the first repo load (otherwise a
   *  persisted selection would be wiped against a still-empty repo list), keep
   *  an explicit selection alive when it's a registered worktree OR a session
   *  actually runs there (containment, not equality — a session stamped with a
   *  subdirectory still anchors the selection) or a session link is waiting
   *  for its session there, else fall back to the first known worktree. */
  worktreeFallback(): boolean {
    const st = this.ports.state()
    if (this.ports.checkoutsKnown?.() !== true) return true
    if (
      st.navigation.registeredWorktree &&
      st.navigation.hasWorktreeSession &&
      st.navigation.firstWorktree
    ) {
      if (st.selectedWorktree) {
        const known = st.navigation.registeredWorktree(st.selectedWorktree)
        if (known === NAVIGATION_LOADING) return false
        if (known || st.selectedWorktree === this.ports.linkedWorktree?.()) return true
        const anchored = st.navigation.hasWorktreeSession(st.selectedWorktree)
        if (anchored === NAVIGATION_LOADING) return false
        if (anchored) return true
      }
      const first = st.navigation.firstWorktree()
      if (first === NAVIGATION_LOADING) return false
      this.ports.publish({ selectedWorktree: first ?? null })
      return true
    }
    const worktrees = reposToViews(this.ports.repositories?.() ?? []).flatMap(
      (repo) => repo.worktrees,
    )
    if (!st.selectedWorktree) {
      this.ports.publish({ selectedWorktree: worktrees[0]?.path ?? null })
      return true
    }
    const selectedWorktree = st.selectedWorktree
    const known = worktrees.some((w) => machinePathsEqual(w.path, selectedWorktree))
    if (known || st.selectedWorktree === this.ports.linkedWorktree?.()) return true
    const sessions = st.navigation.worktreeSessions?.()
    if (sessions === NAVIGATION_LOADING) return false
    const hasSession = (sessions ?? []).some((s) =>
      isMachinePathWithinRoot(selectedWorktree, s.cwd),
    )
    if (hasSession) return true
    this.ports.publish({ selectedWorktree: worktrees[0]?.path ?? null })
    return true
  }
}
