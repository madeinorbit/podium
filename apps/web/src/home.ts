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
  const phase = s.agentState?.phase
  if (phase === 'needs_user' || phase === 'errored') return 'needsYou'
  if (phase === 'idle') {
    const kind = s.agentState?.idle?.kind
    return kind && kind !== 'done' ? 'needsYou' : 'idle'
  }
  if (phase === 'working' || phase === 'compacting') return 'working'
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

const byRecency = (a: SessionMeta, b: SessionMeta): number =>
  b.lastActiveAt.localeCompare(a.lastActiveAt)

export function groupSessions(sessions: SessionMeta[]): HomeGroups {
  const groups: HomeGroups = { needsYou: [], idle: [], working: [] }
  for (const s of sessions) {
    if (s.archived) continue
    groups[attentionGroup(s)].push(s)
  }
  groups.needsYou.sort(byRecency)
  groups.idle.sort(byRecency)
  groups.working.sort(byRecency)
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
  for (const lane of lanes) lane.sessions.sort(byRecency)
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
