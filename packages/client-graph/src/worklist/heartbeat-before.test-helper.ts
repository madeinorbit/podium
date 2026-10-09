import { here, omitGone, requireHere } from '../lookup'
/** Frozen HB05/HB07 algorithms from ddc113ec4c, retained only for parity.
 * They deliberately read raw seats. Production must not import this file. */
import type { SessionView } from '@podium/client-core/session-values'
import { machinePathsEqual } from '@podium/model/browser'
import { headerModel } from '../header-companion'
import { missions } from '../mission'
import type { MobxPool } from '../pool'
import { sessionSeats } from '../session-seats'
import { isFinished } from '../shared/predicates'
import { createRowOverlay } from '../shared/overlay-row'
import type { SliceIssue, SliceSession, SliceWorktree } from '../shared/slice-types'
import { attentionGroup, isSessionWorking, LOADING } from './rollup'
import { sidebarIssueProgress, type SidebarState, type SidebarWorktree } from './sidebar'
import { sortedSidebarSessions } from './sidebar-row'
import { worklistView } from './view-model'
const overlayRow = createRowOverlay()
const NO_PROGRESS = { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
const FOLDED_LOADING = { root: undefined, progress: NO_PROGRESS, live: 0, working: 0, needs: 0, loading: true }
const FOLDED_NONE = { ...FOLDED_LOADING, loading: false }
const sessionPresentOnTask = (session: SessionView) => !session.archived && session.status !== 'exited'
export function foldedBefore(pool: MobxPool, rootId: string) {
  const issue = (id: string) => omitGone(pool.row('issue', id)) as SliceIssue | typeof LOADING | undefined
  const sessionSummary = (id: string) => {
    const model = here(pool.model('session', id))
    if (model) return headerModel(pool).session(model).headerDock
    const row = omitGone(pool.row('session', id, 'summary'))
    return row === LOADING ? undefined : row as Partial<SliceSession> | undefined
  }
    const value = issue(rootId)
    if (value === LOADING) return FOLDED_LOADING
    // The same root value selectedIssue() gives when the root is selected.
    const root = value && {
      ...value,
      displayRef: here(pool.model('issue', value.id))?.displayRef ?? `#${value.seq}`,
    }
    if (!root || root.archived || root.deletedAt) return FOLDED_NONE
    const ids = missions(pool).members(root.id)
    if (ids === LOADING) return FOLDED_LOADING
    const seats = sessionSeats(pool)
    const sessions = new Map<string, SliceSession>()
    let loading = false,
      needs = 0
    // Placement can hide a provenance branch behind an archived owner.
    // Keep formal edges when their parent is in the mission; otherwise graft
    // under the starter's owner, falling back to the selected mission root.
    const grafts = new Map<string, string[]>()
    for (const id of ids) {
      if (id === root.id) continue
      const value = issue(id)
      if (value === LOADING) {
        loading = true
        continue
      }
      if (
        !value ||
        value.archived ||
        value.deletedAt ||
        (value.parentId && ids.has(value.parentId))
      )
        continue
      const owner = value.startedBySession
        ? sessionSummary(value.startedBySession)?.issueId
        : undefined
      const parent = owner && ids.has(owner) && owner !== id ? owner : root.id
      const siblings = grafts.get(parent) ?? []
      siblings.push(id)
      grafts.set(parent, siblings)
    }
    /** Seated members, and cold ones whose summary does not say: their rows
     * settle the flag below. Known archived history is never read. */
    function present(id: string): readonly string[] {
      const partition = seats.partition('sessions', id)
      if (partition === LOADING) {
        loading = true
        return []
      }
      return partition.unknown.length
        ? [...partition.present, ...partition.unknown]
        : partition.present
    }
    const visible = new Set<string>()
    function collect(id: string): void {
      if (visible.has(id)) return
      const value = issue(id)
      if (value === LOADING) {
        loading = true
        return
      }
      if (!value || value.archived || value.deletedAt) return
      visible.add(id)
      let asking = false,
        staffed = false
      for (const sid of present(id)) {
        const member = omitGone(pool.row('session', sid)) as SliceSession | typeof LOADING | undefined
        if (member === LOADING) {
          loading = true
          continue
        }
        if (!member || member.archived || member.headless || member.agentKind === 'shell') continue
        sessions.set(sid, member)
        staffed ||= sessionPresentOnTask(member as SessionView)
        asking ||=
          member.agentState?.phase === 'needs_user' ||
          member.agentState?.phase === 'errored' ||
          !!member.offer
      }
      const vacated = !staffed && pool.graph.size('issue', id, 'spinOffs') > 0
      if (
        !isFinished(value) &&
        (asking || value.needsHuman || (value.stage === 'review' && !vacated))
      )
        needs++
      for (const child of pool.graph.many('issue', id, 'children')) collect(child)
      for (const child of grafts.get(id) ?? []) collect(child)
    }
    collect(root.id)
    const crew = [...sessions.values()].filter((member) =>
      sessionPresentOnTask(member as SessionView),
    )
    if (
      root.isDraftVessel &&
      !root.worktreePath &&
      !present(root.id).some((sid) => {
        const member = omitGone(pool.row('session', sid)) as SliceSession | typeof LOADING | undefined
        return member && member !== LOADING && !member.archived
      })
    )
      return { root: undefined, progress: NO_PROGRESS, live: 0, working: 0, needs: 0, loading }
    const model = here(pool.model('issue', root.id))
    const progress = model === undefined ? undefined : sidebarIssueProgress(model)
    if (progress === LOADING) loading = true
    return {
      root,
      progress: progress && progress !== LOADING ? progress : NO_PROGRESS,
      live: crew.length,
      working: crew.filter(isSessionWorking).length,
      needs,
      loading,
    }
  }

export function worktreeBefore(pool: MobxPool, path: string, state: SidebarState = {}): SidebarWorktree | undefined {
    const view = worklistView(pool)
    const lane = omitGone(pool.row('worktree', path))
    if (lane === undefined || lane === LOADING) return undefined
    const sessions: SliceSession[] = []
    const issues = new Map<string, SliceIssue & { readonly displayRef: string }>()
    const tree = here(pool.model('worktree', path))
    const roster = tree ? view.tree(tree).roster : undefined
    if (roster === undefined || (!roster.ids.length && roster.pending === 0)) return undefined
    let activityAt = 0,
      pending = roster.pending
    for (const id of roster.ids) {
      const sessionModel = here(pool.model('session', id))
      const row = omitGone(pool.row('session', id))
      if (row === LOADING) {
        pending += 1
        continue
      }
      if (row === undefined || sessionModel === undefined) continue
      const session = row as SliceSession
      const owner =
        sessionModel.issueLink === null ? undefined : pool.knownIssue(sessionModel.issueLink)
      if (session.issueId && owner) {
        const raw = omitGone(pool.row('issue', session.issueId))
        if (raw === LOADING) pending += 1
        else if (raw !== undefined)
          issues.set(
            session.issueId,
            overlayRow(raw as SliceIssue, {
              displayRef: requireHere(pool.issue(session.issueId))!.displayRef,
            }),
          )
      }
      activityAt = Math.max(activityAt, sessionModel.activityMs ?? 0)
      if (session.status !== 'exited') sessions.push(session)
    }
    const sorted = sortedSidebarSessions(sessions, pool.inputs.reached)
    const candidates = sorted.filter(
      (s) =>
        attentionGroup(s) !== 'working' &&
        pool.inputs.passed((Date.parse(s.lastActiveAt) || 0) + 16 * 60 * 60 * 1000),
    )
    const staleIds = new Set(
      sorted.length > 5 && candidates.length > 3
        ? [...candidates]
            .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
            .slice(3)
            .map((s) => s.sessionId)
        : [],
    )
    return {
      worktree: lane as SliceWorktree,
      sessions: sorted,
      visible: sorted.filter((s) => !staleIds.has(s.sessionId)),
      stale: sorted.filter((s) => staleIds.has(s.sessionId)),
      issues: [...issues.values()],
      activityAt,
      pending,
      // The selection is read only for the selected worktree: a click
      // elsewhere wakes no other worktree row (POD-5423).
      active: state.selectedWorktree != null && machinePathsEqual(state.selectedWorktree, path) && view.selectedId === null,
    }
  }

