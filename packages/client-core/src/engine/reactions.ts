/**
 * THE REACTION TABLE (POD-404, split out of the old `engine.ts`).
 *
 * Every one of these was a `useEffect` in the pre-#262 provider. They are the
 * policies that fire when a state slice moves: follow a session that moved
 * worktrees, keep the worktree selection valid, tell the server which sessions
 * this client renders, and mark what the operator is LOOKING AT as read.
 *
 * They are grouped here because they share a shape — read state, decide, write
 * back through the runtime's one choke point — and because keeping them out of
 * the runtime is what keeps the runtime a coordinator rather than a god object.
 *
 * All timers live on this object and are cleared by {@link Reactions.dispose},
 * which the runtime calls on teardown. That matters for the principal boundary:
 * a mark-read timer armed for one principal's session must never fire a write
 * after a different principal took over (POD-404 AC).
 */

import type { IssueWire, SessionId, IssueId } from '@podium/model'
import { markSwitch } from '../perf/switch-trace'
import type { SocketHub } from '../socket-transport'
import {
  allTabIds,
  emptyWorkspace,
  openTab,
  planWorktreeMoves,
  pruneWorkspace,
  reposToViews,
  type TabId,
} from '../viewmodels'
import {
  type EngineState,
  focusedPaneSession,
  foregroundIssue,
  issueActivityAt,
  knownTabIds,
  knownTabIdsForWorkspace,
  referencedTabIds,
  visibleTabIds,
  workspaceKeyForState,
  workspaceWritePatch,
  workspacesPatch,
} from './state'
import type { StoreNotices } from './types'

/** Throttle window (ms) for mark-read-on-view. The FIRST activity on the surface
 *  the operator is looking at marks it read immediately (POD-272 — it is already
 *  on screen); this window then bounds the follow-ups, so a streaming session
 *  costs one mutation per window plus one trailing pass rather than one a frame.
 *  Still the default trailing debounce for the standalone useMarkReadOnView. */
export const MARK_READ_ON_VIEW_MS = 1200

/**
 * How long a tab id may name nothing before the workspace stops holding it.
 *
 * An absent id is a legitimate TRANSIENT state, which is why POD-710 shipped
 * `pruneWorkspace` without a caller: an optimistic spawn, a deep-linked
 * `?pane=`, a session row that has not arrived yet, or (under a scoped slice) a
 * row this principal briefly cannot see are all "early", not "gone". A prune on
 * every `sessions` delta would delete real tabs and break the deep-link path.
 *
 * A window is the honest discriminator. Nothing legitimate takes this long to
 * show up, and nothing is lost by waiting: a ghost tab renders nothing either
 * way, it just stops being persisted afterwards.
 */
export const WORKSPACE_PRUNE_GRACE_MS = 20_000

export interface ReactionPorts {
  readonly state: () => EngineState
  readonly publish: (patch: Partial<EngineState>) => void
  readonly hub: SocketHub
  readonly notices: StoreNotices
  /** Resolved lazily: the action surface is built after this object exists. */
  readonly markSessionRead: (sessionId: SessionId) => void
  readonly markIssueRead: (issueId: IssueId) => void
  /**
   * IS THIS CLIENT ON SCREEN — from the platform's visibility source, not from
   * `document` (POD-2055 WP-C4). Every read below used to go through the
   * browser helper, which answers `true` wherever there is no document: a
   * backgrounded phone therefore reported itself as watching (suppressing its
   * own push) and marked rows read on a screen nobody was looking at.
   */
  readonly isVisible: () => boolean
  /** Test seam: overrides {@link WORKSPACE_PRUNE_GRACE_MS}. */
  readonly pruneGraceMs?: number
}

export class Reactions {
  private readonly ports: ReactionPorts
  private prevCwds: Record<string, string> = {}
  private prevIssueIds: Record<string, string> = {}
  private markReadKey: string | null = null
  private markReadTimer: ReturnType<typeof setTimeout> | null = null
  /** When the focused session's eager mark-read last actually fired (POD-272) —
   *  the throttle window's origin, so a burst of activity costs one mutation. */
  private markReadFiredAt = 0
  private issueMarkReadKey: string | null = null
  private issueMarkReadTimer: ReturnType<typeof setTimeout> | null = null
  private issueMarkReadFiredAt = 0
  /** When each currently-unresolved tab id was FIRST seen naming nothing —
   *  the clock the prune grace period runs against. */
  private unknownSince = new Map<TabId, number>()
  private pruneTimer: ReturnType<typeof setTimeout> | null = null
  /** Test seam for {@link WORKSPACE_PRUNE_GRACE_MS}. */
  private readonly pruneGraceMs: number

  constructor(ports: ReactionPorts) {
    this.ports = ports
    this.pruneGraceMs = ports.pruneGraceMs ?? WORKSPACE_PRUNE_GRACE_MS
  }

  private isVisible(): boolean {
    return this.ports.isVisible()
  }

  /** Seed the worktree-follow diff: rows present at construction are "first
   *  sight", not moves (matches the old effect's first observed snapshot). */
  seedCwds(sessions: { sessionId: SessionId; cwd: string }[]): void {
    this.prevCwds = Object.fromEntries(sessions.map((s) => [s.sessionId, s.cwd]))
  }

  /** First replica snapshot is "already here", not a rehome. */
  seedIssueIds(sessions: { sessionId: SessionId; issueId?: string }[]): void {
    this.prevIssueIds = Object.fromEntries(
      sessions.map((session) => [session.sessionId, session.issueId ?? '']),
    )
  }

  dispose(): void {
    if (this.markReadTimer !== null) {
      clearTimeout(this.markReadTimer)
      this.markReadTimer = null
    }
    if (this.issueMarkReadTimer !== null) {
      clearTimeout(this.issueMarkReadTimer)
      this.issueMarkReadTimer = null
    }
    if (this.pruneTimer !== null) {
      clearTimeout(this.pruneTimer)
      this.pruneTimer = null
    }
    this.markReadKey = null
    this.issueMarkReadKey = null
    this.unknownSince.clear()
  }

  /**
   * DROP TABS THAT NAME NOTHING — the caller `pruneWorkspace` was missing.
   *
   * A workspace can hold an id that no longer resolves: a `?pane=` bookmark for
   * a session that is gone, a session killed from the CLI or another device, a
   * file tab whose buffer did not survive the reload. Nothing rendered it and
   * nothing cleared it, so the strip stayed empty, the pane stayed blank, and
   * the ghost was persisted and restored on every reload — with no gesture that
   * could remove it, because a tab you cannot see is a tab you cannot close.
   *
   * The care this needs is all in the DELAY, not the drop. An id that resolves
   * to nothing right now may simply be early (see
   * {@link WORKSPACE_PRUNE_GRACE_MS}), so an id is dropped only once it has
   * failed to resolve continuously for the whole grace period. Ids that come
   * back, or that leave the layout some other way, forget their clock. Only ids
   * that ran out are dropped — never "everything not currently known", which
   * would empty every workspace the moment a slice was rebuilt.
   */
  pruneWorkspaces(): void {
    const st = this.ports.state()
    const referenced = referencedTabIds(st)
    const globallyKnown = knownTabIds(st)
    for (const id of [...this.unknownSince.keys()]) {
      if (!referenced.has(id) || globallyKnown.has(id)) this.unknownSince.delete(id)
    }
    if (this.pruneTimer !== null) {
      clearTimeout(this.pruneTimer)
      this.pruneTimer = null
    }
    const now = Date.now()
    const gone = new Set<TabId>()
    let soonest = Number.POSITIVE_INFINITY
    for (const id of referenced) {
      if (globallyKnown.has(id)) continue
      const since = this.unknownSince.get(id) ?? now
      this.unknownSince.set(id, since)
      const left = this.pruneGraceMs - (now - since)
      if (left <= 0) gone.add(id)
      else soonest = Math.min(soonest, left)
    }
    if (Number.isFinite(soonest)) {
      this.pruneTimer = setTimeout(() => {
        this.pruneTimer = null
        this.pruneWorkspaces()
      }, soonest)
    }
    // A record whose id ran out of grace goes WITH the tab (POD-1247). File tabs
    // are persisted now, so a record left behind would be re-hydrated on the
    // next reload, re-open its ghost, and be swept again — forever.
    const fileTabs = st.fileTabs.filter((tab) => !gone.has(tab.id))
    this.ports.publish({
      ...(fileTabs.length === st.fileTabs.length ? {} : { fileTabs }),
      ...workspacesPatch(st, (ws) => {
        const memberKnown = knownTabIdsForWorkspace(st, ws.key)
        const keep = new Set<TabId>()
        for (const id of allTabIds(ws)) {
          if (gone.has(id)) continue
          if (memberKnown.has(id)) {
            keep.add(id)
            continue
          }
          // Exists in the replica but not in this workspace — a rehome. Drop now.
          if (globallyKnown.has(id)) continue
          keep.add(id)
        }
        return pruneWorkspace(ws, keep)
      }),
    })
  }

  /**
   * When the session the operator is looking at is rehomed onto another issue,
   * follow the selection so the tab lives on the new workspace instead of
   * lingering as a ghost on the origin strip.
   */
  sessionIssueFollow(): void {
    const st = this.ports.state()
    const prev = this.prevIssueIds
    this.prevIssueIds = Object.fromEntries(
      st.sessions.map((session) => [session.sessionId, session.issueId ?? '']),
    )
    if (Object.keys(prev).length === 0) return
    const focused = focusedPaneSession(st)
    if (!focused) return
    const session = st.sessions.find((candidate) => candidate.sessionId === focused)
    const after = session?.issueId
    const before = prev[focused]
    if (!after || before === undefined || before === after || before === '') return
    if (st.selectedIssueId !== before && st.selectedIssueId !== null) {
      // Looking at a different task — do not yank the operator to the new home.
      // The origin workspace still drops the tab in pruneWorkspaces.
      return
    }
    const nextState = { ...st, selectedIssueId: after }
    const key = workspaceKeyForState(nextState)
    const nextLayout = openTab(st.workspaces[key] ?? emptyWorkspace(key), focused, {
      permanent: true,
    })
    this.ports.publish({
      selectedIssueId: after,
      ...workspaceWritePatch(st, key, nextLayout),
    })
  }

  /** When a session the user is LOOKING AT (in a visible pane) moves out of the
   *  selected worktree, switch the whole view to where it went — otherwise it
   *  silently disappears from the tab strip mid-conversation. A background
   *  session's move never yanks the view; it gets a toast so the user knows
   *  where it now lives in the sidebar. */
  worktreeFollow(): void {
    const st = this.ports.state()
    const prevCwds = this.prevCwds
    this.prevCwds = Object.fromEntries(st.sessions.map((s) => [s.sessionId, s.cwd]))
    const plan = planWorktreeMoves({
      prevCwds,
      sessions: st.sessions,
      worktreePaths: reposToViews(st.repos).flatMap((r) => r.worktrees.map((w) => w.path)),
      selectedWorktree: st.selectedWorktree,
      // The same "what is on screen" walk the view-state report uses: a session
      // in a third pane is being looked at just as much as one in the first.
      visiblePanes: this.isVisible() ? visibleTabIds(st) : [],
    })
    if (plan.follow) this.ports.publish({ selectedWorktree: plan.follow })
    for (const move of plan.moved) {
      const s = st.sessions.find((x) => x.sessionId === move.sessionId)
      const dest = move.to ?? s?.cwd
      // The title said the destination's last segment and the description then
      // said the whole path, so the branch name was read twice in one notice —
      // and when there was no destination at all it read "moved to ?". The
      // title names WHAT happened; the path underneath is the only place the
      // destination is stated (POD-1159).
      this.ports.notices.info(`${s?.name || s?.title || 'A session'} moved worktree`, dest)
    }
  }

  /** Keep the selected worktree valid: wait for the first repo load (otherwise a
   *  persisted selection would be wiped against a still-empty repo list), keep
   *  an explicit selection alive when it's a registered worktree OR a session
   *  actually runs there (containment, not equality — a session stamped with a
   *  subdirectory still anchors the selection), else fall back to the first
   *  known worktree. */
  worktreeFallback(): void {
    const st = this.ports.state()
    if (!st.reposLoaded) return
    const worktrees = reposToViews(st.repos).flatMap((repo) => repo.worktrees)
    if (!st.selectedWorktree) {
      this.ports.publish({ selectedWorktree: worktrees[0]?.path ?? null })
      return
    }
    const known = worktrees.some((w) => w.path === st.selectedWorktree)
    const hasSession = st.sessions.some(
      (s) => s.cwd === st.selectedWorktree || s.cwd.startsWith(`${st.selectedWorktree}/`),
    )
    if (known || hasSession) return
    this.ports.publish({ selectedWorktree: worktrees[0]?.path ?? null })
  }

  /** Report which sessions this client renders (`visible`) and which one has
   *  input focus (`focused`) so the server can prioritize PTY relay for them.
   *  While the tab is hidden we report nothing — a backgrounded client isn't
   *  watching anything.
   *
   *  Both come from the SAME leaf walk `userFocus` uses. They used to be
   *  recomputed inline from `paneA`/`paneB`/`split`, which agreed with it for
   *  two panes and diverged for three: the third pane's session was rendered,
   *  reported to nobody, and starved of relay priority. */
  reportViewState(): void {
    const st = this.ports.state()
    const tabVisible = this.isVisible()
    // The dock's shell (#23) renders OUTSIDE the panes — without reporting it
    // here the server's viewVisible gate drops its resizes and the terminal
    // stays pinned to the spawn-default 80×24.
    const visible = tabVisible
      ? [
          ...new Set(
            [...visibleTabIds(st), st.dockVisibleSession].filter((x): x is SessionId => x != null),
          ),
        ]
      : []
    const focused = tabVisible ? focusedPaneSession(st) : null
    // Rendered mode (native/chat) for each visible session — default 'native'
    // until its AgentPanel reports its effective mode.
    const modes: Record<string, 'native' | 'chat'> = {}
    for (const sid of visible) modes[sid] = st.panelMode[sid] ?? 'native'
    this.ports.hub.setViewState(visible, focused, modes)
    // Switch-latency trace [POD-701]: stamp when the view-state report carrying
    // the traced session went out (markSwitch no-ops for untraced sessions).
    for (const sid of visible) markSwitch(sid, 'viewstate:sent')
  }

  readonly onVisibilityChange = (): void => {
    this.updateIssueVisitBaseline()
    this.ports.hub.setVisible(this.isVisible())
    this.reportViewState()
    if (this.isVisible()) {
      this.updateMarkReadTimer()
      this.updateIssueMarkReadTimer()
    } else {
      this.markReadKey = null
      this.issueMarkReadKey = null
      if (this.markReadTimer !== null) clearTimeout(this.markReadTimer)
      if (this.issueMarkReadTimer !== null) clearTimeout(this.issueMarkReadTimer)
      this.markReadTimer = null
      this.issueMarkReadTimer = null
    }
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
      if (state.issueVisitBaseline !== null) this.ports.publish({ issueVisitBaseline: null })
      return
    }
    if (state.issueVisitBaseline?.issueId === issue.id) return
    this.ports.publish({
      issueVisitBaseline: {
        issueId: issue.id,
        readAt: issue.readAt,
        openedAt: new Date().toISOString(),
      },
    })
  }

  /** Mark the session the operator is LOOKING AT read on view (#138), keyed on
   *  the focused session's id + activity. The activity that lands while the
   *  session IS the open pane is already on screen, so it's marked read EAGERLY
   *  — leading edge, no settle wait (POD-272: waiting left a "new" chip on the
   *  row of the very session being read). MARK_READ_ON_VIEW_MS survives as the
   *  throttle window: a burst costs one mutation now plus one trailing pass, so
   *  a streaming session still can't spam the outbox.
   *
   *  The trigger stays ACTIVITY, never the `unread` flag itself, so manually
   *  marking the open session unread isn't instantly undone; `unread` +
   *  visibility are re-checked at fire time. */
  updateMarkReadTimer(): void {
    const st = this.ports.state()
    const focusedId = focusedPaneSession(st)
    const session = focusedId ? st.sessions.find((s) => s.sessionId === focusedId) : undefined
    const key = session ? `${session.sessionId}\n${session.lastActiveAt}` : null
    if (key === this.markReadKey) return
    this.markReadKey = key
    if (this.markReadTimer !== null) {
      clearTimeout(this.markReadTimer)
      this.markReadTimer = null
    }
    if (!session) return
    const sessionId = session.sessionId
    const wait = MARK_READ_ON_VIEW_MS - (Date.now() - this.markReadFiredAt)
    if (wait <= 0) {
      this.fireMarkSessionRead(sessionId)
      return
    }
    this.markReadTimer = setTimeout(() => {
      this.markReadTimer = null
      this.fireMarkSessionRead(sessionId)
    }, wait)
  }

  /** The guarded mark-read itself: only when this session is STILL the focused
   *  pane, still unread, and the tab is visible. */
  private fireMarkSessionRead(sessionId: SessionId): void {
    const cur = this.ports.state()
    const s = cur.sessions.find((x) => x.sessionId === sessionId)
    if (focusedPaneSession(cur) !== sessionId || s?.unread !== true || !this.isVisible()) return
    this.markReadFiredAt = Date.now()
    this.ports.markSessionRead(sessionId)
  }

  /** The issue half of eager mark-read-on-view (POD-272): while an issue is the
   *  foreground surface its incoming activity is on screen, so the row must not
   *  hold a "new message" chip for it. Same shape as the session reaction —
   *  keyed on activity (so a manual mark-unread sticks), leading edge, throttled
   *  by MARK_READ_ON_VIEW_MS. */
  updateIssueMarkReadTimer(): void {
    const issue = foregroundIssue(this.ports.state())
    const key = issue
      ? `${issue.id}\n${issueActivityAt(issue, this.ports.state().sessions, this.ports.state().issues)}`
      : null
    if (key === this.issueMarkReadKey) return
    this.issueMarkReadKey = key
    if (this.issueMarkReadTimer !== null) {
      clearTimeout(this.issueMarkReadTimer)
      this.issueMarkReadTimer = null
    }
    if (!issue) return
    const issueId = issue.id
    const wait = MARK_READ_ON_VIEW_MS - (Date.now() - this.issueMarkReadFiredAt)
    if (wait <= 0) {
      this.fireMarkIssueRead(issueId)
      return
    }
    this.issueMarkReadTimer = setTimeout(() => {
      this.issueMarkReadTimer = null
      this.fireMarkIssueRead(issueId)
    }, wait)
  }

  private fireMarkIssueRead(issueId: IssueId): void {
    const st = this.ports.state()
    const issue: IssueWire | undefined = foregroundIssue(st)
    if (issue?.id !== issueId || !this.isVisible()) return
    const activityAt = Date.parse(issueActivityAt(issue, st.sessions, st.issues))
    const readAt = issue.readAt ? Date.parse(issue.readAt) : Number.NaN
    const unread = !Number.isFinite(readAt) || (Number.isFinite(activityAt) && activityAt > readAt)
    if (!unread) return
    this.issueMarkReadFiredAt = Date.now()
    this.ports.markIssueRead(issueId)
  }
}
