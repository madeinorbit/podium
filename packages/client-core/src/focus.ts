import type { SessionMeta, WorkState } from '@podium/protocol'

/**
 * The home board's attention triage. The whole point of the product: the user
 * should know where they're needed without reading terminals.
 *
 *   needsYou — the agent is blocked on the human (question, permission, plan
 *              approval, retryable error, open todos it stopped on).
 *   idle     — finished or quiet; ordered by recency so "parked just now" beats
 *              "parked last week".
 *   working  — running fine without us; lowest priority for the eyes.
 *
 * Archived sessions never appear here (callers filter), exited shells aren't
 * attention-worthy and group as idle.
 */
export interface HomeGroups {
  needsYou: SessionMeta[]
  idle: SessionMeta[]
  working: SessionMeta[]
}

export type AttentionGroup = keyof HomeGroups

export function attentionGroup(s: SessionMeta): AttentionGroup {
  // Offers are explicit requests for a human decision. Reading the transcript
  // clears unread, but it must not make the offer (or its issue row) look idle.
  if (s.offer) return 'needsYou'
  const phase = s.agentState?.phase
  if (phase === 'needs_user' || phase === 'errored') return 'needsYou'
  if (phase === 'idle') {
    const kind = s.agentState?.idle?.kind
    return kind && kind !== 'done' ? 'needsYou' : 'idle'
  }
  if (phase === 'working' || phase === 'compacting') {
    // A gone or parked process cannot be working, however stale its last phase
    // verdict. A harness that emits no terminal event on an abrupt exit (Grok,
    // killed mid-turn) freezes its last live phase at 'working'; the transported
    // status is the ground truth and overrides it, so the row leaves the working
    // bucket. [spec:SP-8b0e]
    if (s.status === 'exited' || s.status === 'hibernated') return 'idle'
    return 'working'
  }
  // Shells have no harness instrumentation: a shell sitting at its prompt is idle,
  // not working. The server's debounced `busy` flag (a process writing to the PTY)
  // is the real signal, so a shell only reads as working while a command runs.
  if (s.agentKind === 'shell') return s.busy ? 'working' : 'idle'
  // Other uninstrumented kinds (Codex/Grok pre-instrumentation, unknown phase):
  // fall back to liveness — a live process counts as working, a parked one idle.
  if (s.status === 'live' || s.status === 'starting' || s.status === 'reconnecting') {
    return 'working'
  }
  return 'idle'
}

/**
 * The one line shown under a needs-you card: the agent's *actual* question when
 * the instrumentation captured one — far higher signal than a generic badge.
 */
export function attentionSummary(s: SessionMeta): string | null {
  const state = s.agentState
  if (!state) return null
  if (state.phase === 'needs_user') {
    if (state.need?.summary) return state.need.summary
    return state.need?.kind === 'question'
      ? 'Asked you a question.'
      : 'Waiting for permission to continue.'
  }
  if (state.phase === 'errored') {
    const cls = state.error?.class ?? 'unknown'
    return state.error?.retryable
      ? `Stopped on a retryable error (${cls}).`
      : `Stopped on an error (${cls}).`
  }
  if (state.phase === 'idle') {
    switch (state.idle?.kind) {
      case 'question':
        return state.idle.summary ?? 'Ended its turn on a question.'
      case 'approval':
        return state.idle.summary ?? 'Has a plan waiting for your approval.'
      case 'open_todos':
        return state.idle.summary ?? 'Stopped with unfinished todos.'
      default:
        return null
    }
  }
  return null
}

/**
 * A session's effective recency: the later of its last real activity and its last
 * unsent-draft edit. Editing a prompt is recent user intent on that session, so a
 * freshly-drafted-but-otherwise-stale session belongs up with the just-active ones
 * (and reads as DRAFT). `draftUpdatedAt` is absent unless a non-empty draft exists.
 */
function effectiveRecency(s: SessionMeta, now: number): string {
  let t = s.lastActiveAt
  if (s.draftUpdatedAt && s.draftUpdatedAt > t) t = s.draftUpdatedAt
  // A snooze whose deadline has already passed re-enters the attention queue *at
  // that moment*: surface the session by its expiry so a just-returned one sorts
  // near the top. A future deadline (still snoozed) must NOT count — that session
  // is filtered out of the attention list anyway.
  if (
    typeof s.snoozedUntil === 'string' &&
    Date.parse(s.snoozedUntil) <= now &&
    s.snoozedUntil > t
  ) {
    t = s.snoozedUntil
  }
  return t
}

/**
 * Recency comparator for session ordering (newest-active first). Effective recency
 * — the latest of last activity, draft edit, and an already-expired snooze deadline
 * — is the primary key; `createdAt` then `sessionId` break ties into a *total*
 * order, so sessions with equal timestamps (common right after a reattach, when
 * several rows carry the same persisted time) keep a fixed, deterministic order
 * instead of reshuffling with the input order frame to frame. `now` resolves the
 * "expired?" test for snoozes; it defaults to wall-clock for callers that sort
 * without a frame-stable clock.
 */
export function compareRecency(a: SessionMeta, b: SessionMeta, now: number = Date.now()): number {
  const byActive = effectiveRecency(b, now).localeCompare(effectiveRecency(a, now))
  if (byActive !== 0) return byActive
  const byCreated = b.createdAt.localeCompare(a.createdAt)
  if (byCreated !== 0) return byCreated
  return a.sessionId.localeCompare(b.sessionId)
}

/**
 * The command center triages *agents*, not shells. A shell sitting at its prompt
 * (or running a one-off command) is not something you steer from the board, so it
 * never belongs in the list, the kanban lanes, or the archived drawer. Filter it
 * out at the command-center boundary; the sidebar's worktree tree still lists
 * shells under their worktree.
 */
export function withoutShells(sessions: SessionMeta[]): SessionMeta[] {
  // Headless superagent sessions are equally out of place on the board — they
  // render only inside the superagent panel's embedded chat.
  return sessions.filter((s) => s.agentKind !== 'shell' && s.headless !== true)
}

export function groupSessions(sessions: SessionMeta[]): HomeGroups {
  const groups: HomeGroups = { needsYou: [], idle: [], working: [] }
  for (const s of sessions) {
    if (s.archived) continue
    groups[attentionGroup(s)].push(s)
  }
  groups.needsYou.sort(compareRecency)
  groups.idle.sort(compareRecency)
  groups.working.sort(compareRecency)
  return groups
}

// Labels keyed by the protocol enum, so a `Record<WorkState, …>` makes adding a
// WorkState member a compile error here until it gets a column — the array form
// let the kanban silently drop a new state into "Unsorted".
const WORK_STATE_LABELS: Record<WorkState, string> = {
  planning: 'Planning',
  implementing: 'Implementing',
  testing: 'Testing',
  done: 'Done',
  icebox: 'Icebox',
}
export const WORK_STATE_COLUMNS: { key: WorkState; label: string }[] = (
  Object.keys(WORK_STATE_LABELS) as WorkState[]
).map((key) => ({ key, label: WORK_STATE_LABELS[key] }))

/** Kanban lanes: the five named columns plus an Unsorted inbox. Recency-ordered.
 *  Archived sessions are "filed away as done" — they always land in the Done lane
 *  (rather than vanishing from the board) so Archive reads as a board move. */
export function kanbanColumns(
  sessions: SessionMeta[],
): { key: WorkState | 'unsorted'; label: string; sessions: SessionMeta[] }[] {
  const lanes: { key: WorkState | 'unsorted'; label: string; sessions: SessionMeta[] }[] = [
    { key: 'unsorted', label: 'Unsorted', sessions: [] },
    ...WORK_STATE_COLUMNS.map((c) => ({ ...c, sessions: [] as SessionMeta[] })),
  ]
  const byKey = new Map(lanes.map((l) => [l.key as string, l]))
  for (const s of sessions) {
    const key = s.archived ? 'done' : (s.workState ?? 'unsorted')
    ;(byKey.get(key) ?? byKey.get('unsorted'))?.sessions.push(s)
  }
  for (const lane of lanes) lane.sessions.sort(compareRecency)
  return lanes
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" — coarse on purpose. */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
