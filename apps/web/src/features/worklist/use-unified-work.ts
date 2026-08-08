/**
 * THE WORK ROWS PLUS THE ACTIONS ON THEM (POD-407) — extracted from
 * `SidebarUnified.tsx` VERBATIM.
 *
 * Shared by the wide sidebar (`WorkSections`) and the collapsed rail
 * (`SidebarRail`), which is the whole point: both surfaces select, open and
 * mark-read work with IDENTICAL semantics because they call the same hook
 * rather than each reimplementing selection.
 *
 * It reads the published worklist slice; it does not derive the worklist. The
 * eviction handling (a selected row that leaves this principal's slice) lives
 * here because selection is what has to recover.
 */
import { beginSwitch } from '@podium/client-core/perf'
import { shallowEqual } from '@podium/client-core/store'
import {
  type IssueNavigationModel,
  missionIssueIds,
  missionRootFor,
  pickPaneSession,
  type RepoNavView,
  sessionsForIssueNav,
  sessionsForWorktree,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import {
  asSessionId,
  type IssueColorSlot,
  type IssueId,
  issueReturnedFromDefer,
  type SessionId,
} from '@podium/model'
import { useEffect, useRef } from 'react'
import { useReplicaIssues, useSlice, useStoreSelector } from '@/app/store'
import { useOperatorFocus } from '@/app/operator-focus'
import type { SidebarDerivation } from './derivation'

/**
 * The redesigned work sidebar (#41, .design/specs/sidebar.md): the
 * `New <Agent> in <Repo>` spawn row over ONE list of work rows grouped by
 * project (mono section labels), each row carrying its ID square, two-line
 * status anatomy, motion-grammar meta and — when selected — the bridge notch
 * growing toward the engraved column.
 *
 * The pieces are exported separately because the collapsed rail shares their
 * hooks and row behavior.
 */
/**
 * The worklist derivation, as READ rather than as COMPUTED (POD-331).
 *
 * This used to be a `useMemo` over `(repos, sessions, pins, issues, now)` whose
 * result every consumer had to be HANDED as a `derivationOverride` prop — and
 * whose absence, in any consumer that did not receive it, silently bought a
 * second execution of the identical derivation on a private clock. It is now a
 * read of the published `worklistSlice`: one derivation per snapshot however
 * many surfaces are looking, and one clock (`Store.coarseNow`) so two surfaces
 * cannot disagree about when "now" is.
 *
 * The type alias stays so the override-taking signatures below keep reading the
 * same way; the shape is the slice's.

/**
 * The unified work rows plus the selection actions on them — shared by the
 * wide sidebar (WorkSections) and the collapsed rail (SidebarRail, #41), so
 * both surfaces select/open work with identical semantics.
 */
export function useUnifiedWork(derivationOverride?: SidebarDerivation) {
  const {
    repos,
    sessions,
    pins,
    trpc,
    selectedWorktree,
    setSelectedWorktree,
    selectedIssueId,
    setSelectedIssueId,
    setOpenIssueId,
    paneA,
    setPane,
    fileTabs,
    setView,
    markIssueRead,
    markSessionRead,
    setIssueTucked,
  } = useStoreSelector(
    (s) => ({
      repos: s.repos,
      sessions: s.sessions,
      pins: s.pins,
      trpc: s.trpc,
      selectedWorktree: s.selectedWorktree,
      setSelectedWorktree: s.setSelectedWorktree,
      selectedIssueId: s.selectedIssueId,
      setSelectedIssueId: s.setSelectedIssueId,
      setOpenIssueId: s.setOpenIssueId,
      paneA: s.paneA,
      setPane: s.setPane,
      fileTabs: s.fileTabs,
      setView: s.setView,
      markIssueRead: s.markIssueRead,
      markSessionRead: s.markSessionRead,
      setIssueTucked: s.setIssueTucked,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { setFocusedIssueId } = useOperatorFocus()
  // Same as useDefaultSpawn: the fallback READS the published slice (POD-331)
  // instead of re-deriving the whole worklist on a private clock. The rail is
  // the consumer this mattered for — it renders without the sidebar's prop, so
  // before this it was running its own `sidebarSections` + `unifiedWorkList`.
  const published = useSlice(worklistSlice)
  const now = derivationOverride?.now ?? published.now
  const sections = derivationOverride?.sections ?? published.sections
  const _repoNavs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
  const allWorktreePaths = derivationOverride?.allWorktreePaths ?? published.allWorktreePaths
  const work = derivationOverride?.work ?? published.work
  // Row PLACEMENT, published (POD-407): the pinned split and the project-group
  // tree arrive derived rather than being rebuilt per consumer.
  const pinned = derivationOverride?.pinned ?? published.pinned
  const groups = derivationOverride?.groups ?? published.groups

  /**
   * EVICTION MOVES THE SELECTION ON, WITHOUT ANNOUNCING A DELETION (POD-407,
   * readiness §3.1 item 2 / POD-1077).
   *
   * An entity that is unshared leaves this principal's slice with its `revision`
   * unmoved: no `remove`, no tombstone, nothing that says "deleted". ADR 2 is
   * explicit that `remove` cannot be reused for it, because the replica would
   * render it as a deletion — and D5 already warns that soft-delete and tombstone
   * "look identical from a distance and are not". So the row simply stops being
   * there, and the correct UI response is silence: no toast, no tombstone, no
   * deletion affordance, and above all NO RE-REQUEST of the id. Re-requesting is
   * the heal loop ADR 2 names as the failure mode of a filtered feed, and it is
   * also an existence oracle — a client that keeps asking learns the row is real
   * but withheld.
   *
   * ABSENT FROM THE WORKLIST IS NOT THE TEST, and this is the whole subtlety. A
   * finished issue decays out of the live list on a timer (`issueVisibleInSidebar`)
   * and a tucked one folds away, while both still exist and are still legitimately
   * selected. The test is absence from the REPLICA's issues — the row is not in
   * this principal's slice at all.
   *
   * WHY A "HAVE I SEEN IT" LATCH AND NOT A LENGTH CHECK. A cold client restores
   * `selectedIssueId` from the route before its first issue payload arrives, so
   * "selected id not in the list" is ALSO what a normal reload looks like for a
   * moment, and clearing there would wipe the selection on every reload. The
   * obvious guard — ignore an empty list — is wrong in the case that matters
   * most: unsharing someone's ONLY issue leaves exactly an empty list, which is
   * the eviction that most needs handling.
   *
   * So the discriminator is whether this client ever OBSERVED the row present.
   * Seen, then gone => evicted, clear. Never seen => still arriving, wait.
   */
  const seenSelected = useRef<string | null>(null)
  useEffect(() => {
    if (selectedIssueId === null) return
    if (issues.some((issue) => issue.id === selectedIssueId)) {
      seenSelected.current = selectedIssueId
      return
    }
    if (seenSelected.current !== selectedIssueId) return
    seenSelected.current = null
    setSelectedIssueId(null)
  }, [issues, selectedIssueId, setSelectedIssueId])

  // Switch-latency trace [POD-701]: a gesture that changes the focused SESSION
  // starts a trace at t0. Skipped for no-op switches (target already in pane A)
  // and for file-tab targets (`file:…` — no session to trace).
  const traceSwitchTo = (target: SessionId | null, issueId: IssueId | null) => {
    if (target && target !== paneA && !target.startsWith('file:')) {
      // The `file:` prefix is excluded above, so what remains is a session id.
      beginSwitch({ sessionId: asSessionId(target), issueId })
    }
  }
  const selectIssue = (issue: IssueNavigationModel, paneSession?: SessionId) => {
    const root = missionRootFor(issues, issue.id)
    setSelectedIssueId(root?.id ?? issue.id)
    setFocusedIssueId(issue.id)
    // Opening an issue marks IT read (email-style, #126): clear the row's unread
    // emphasis optimistically. Its member sessions keep their own unread until
    // each is opened. No-op when already read.
    void markIssueRead(issue.id)
    // A lapsed defer is transient like the session snooze: OPENING an "Unsnoozed"
    // issue clears the stale defer so the tag doesn't linger (email-read semantics).
    // This is the CLEAR path — deliberately defer(null), which nulls deferUntil so
    // `issueReturnedFromDefer` goes false. (It's distinct from the menu's "Unsnooze",
    // issues.undefer, which BACKDATES deferUntil to float the row to the top of WORK
    // WITH the tag — #133.) A still-snoozed issue is left alone.
    if (issueReturnedFromDefer(issue, now)) {
      void trpc.issues.defer.mutate({ id: issue.id, until: null }).catch(() => {})
    }
    if (issue.worktreePath) setSelectedWorktree(issue.worktreePath)
    // Open a pane too (#108): keep the current one if it already belongs to this
    // issue (session or file tab), else the issue's most recently active session.
    // The pane candidates span the whole MISSION, not just the clicked task, so
    // selecting a sessionless child still lands you on the mission's live agent
    // instead of nothing. Same projection the Flight Deck and the tab strip use.
    const missionIds = missionIssueIds(issues, root?.id ?? issue.id, sessions)
    const members = [
      ...new Map(
        issues
          .filter((candidate) => missionIds.has(candidate.id))
          .flatMap((candidate) =>
            sessionsForIssueNav(candidate, sessions, allWorktreePaths, { includeShells: true }),
          )
          .map((session) => [session.sessionId, session] as const),
      ).values(),
    ]
    const rowFileIds = issue.worktreePath
      ? fileTabs.filter((f) => f.worktreePath === issue.worktreePath).map((f) => f.id)
      : []
    // `paneSession` (a row's specific member, from selectPanelForIssue) wins over
    // the keep-or-most-recent pick, so the trace targets the session that really
    // opens and the pane is only set once.
    const target = paneSession ?? pickPaneSession(members, paneA, rowFileIds)
    traceSwitchTo(target, issue.id)
    // Sessionless task focus follows the inspector while the current chat stays
    // put. Selecting work must never manufacture or require a session.
    if (target) setPane('A', target)
    setView('workspace')
  }
  const selectPanelForIssue = (issue: IssueNavigationModel, sessionId: SessionId) => {
    selectIssue(issue, sessionId)
    // Opening a specific member session marks THAT session read too (#126).
    void markSessionRead(sessionId)
  }
  const selectWorktree = (path: string) => {
    setSelectedIssueId(null)
    setSelectedWorktree(path)
    // Same pane-opening rule as selectIssue, keyed by the worktree's sessions.
    const members = sessionsForWorktree(sessions, path, allWorktreePaths)
    const rowFileIds = fileTabs.filter((f) => f.worktreePath === path).map((f) => f.id)
    const opened = pickPaneSession(members, paneA, rowFileIds)
    traceSwitchTo(opened, null)
    setPane('A', opened)
    // A worktree has no unread flag of its own — opening it opens one session, so
    // mark THAT session read (#126). Other unread sessions keep the row emphasized.
    if (opened && members.some((s) => s.sessionId === opened)) void markSessionRead(opened)
    setView('workspace')
  }
  const selectPanel = (worktreePath: string, sessionId: SessionId) => {
    traceSwitchTo(sessionId, null)
    setSelectedIssueId(null)
    setSelectedWorktree(worktreePath)
    setPane('A', sessionId)
    // Opening a session marks it read (#126).
    void markSessionRead(sessionId)
    setView('workspace')
  }
  // Open the issue PAGE (the right-click "Open" action), leaving the workspace.
  const openIssuePage = (id: IssueId) => {
    setOpenIssueId(id)
    setView('issues')
  }

  // Concrete mutation callbacks rather than the raw trpc client, so the hook's
  // inferred return type stays portable across packages.
  const renameIssue = (id: string, title: string): void => {
    void trpc.issues.update.mutate({ id, patch: { title } }).catch(() => {})
  }
  const setIssueColor = (id: string, color: IssueColorSlot | null): Promise<unknown> =>
    trpc.issues.update.mutate({ id, patch: { color } })
  const archiveIssue = (id: string): Promise<unknown> => trpc.issues.archive.mutate({ id })
  // Manual-sort persistence (POD-168): one patch per row whose key changes
  // (fast path = exactly the dragged row; legacy backfill = the whole scope).
  const applySortPatches = (
    patches: Array<{ id: string; sortKey: string; pinned?: boolean }>,
  ): Promise<unknown> =>
    Promise.all(
      patches.map(({ id, sortKey, pinned }) =>
        trpc.issues.update.mutate({
          id,
          patch: { sortKey, ...(pinned === undefined ? {} : { pinned }) },
        }),
      ),
    )

  return {
    work,
    pinned,
    groups,
    sessions,
    issues,
    allWorktreePaths,
    now,
    paneA,
    selectedIssueId,
    selectedWorktree,
    selectIssue,
    selectPanelForIssue,
    selectWorktree,
    selectPanel,
    openIssuePage,
    renameIssue,
    setIssueColor,
    archiveIssue,
    applySortPatches,
    setIssueTucked,
  }
}
