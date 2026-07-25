import type { IssueWire, SessionMeta } from '@podium/protocol'

export interface WorkIssue {
  issue: IssueWire
  sessions: SessionMeta[]
  /** Finished work held open until the operator tucks it (desktop POD-293). */
  awaitsTuck: boolean
  /** Folded into the Closed disclosure for this repo group. */
  folded: boolean
}

export interface WorkSection {
  key: string
  title: string
  data: WorkIssue[]
  /** Closed/tucked rows for this group (newest finished first). */
  closed: WorkIssue[]
}

/** Match desktop SIDEBAR_FINISHED_GRACE_MS so mobile tuck windows agree. */
export const WORK_FINISHED_GRACE_MS = 48 * 60 * 60 * 1000

const ACTIVE_STAGES = new Set(['planning', 'in_progress', 'review', 'backlog'])

export interface BuildWorkSectionsOpts {
  now?: number
  /** Issue ids the operator has tucked away (AsyncStorage / ui-state). */
  tuckedIds?: ReadonlySet<string>
}

const repoName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

function isFinished(issue: IssueWire): boolean {
  return issue.stage === 'done' || issue.closedReason != null
}

function finishedAt(issue: IssueWire): number {
  if (issue.closedAt) return Date.parse(issue.closedAt) || 0
  return Date.parse(issue.updatedAt) || 0
}

/** Manual order within a band (desktop POD-168): sortKey ASC, then newest-created. */
function compareManualOrder(a: WorkIssue, b: WorkIssue): number {
  const ka = a.issue.sortKey
  const kb = b.issue.sortKey
  if (ka && kb && ka !== kb) return ka < kb ? -1 : 1
  if (ka && !kb) return -1
  if (!ka && kb) return 1
  const dt = (Date.parse(b.issue.createdAt) || 0) - (Date.parse(a.issue.createdAt) || 0)
  if (dt !== 0) return dt
  return b.issue.seq - a.issue.seq
}

function liveSessionsFor(
  issue: IssueWire,
  sessionsByIssue: Map<string, SessionMeta[]>,
): SessionMeta[] {
  const direct = sessionsByIssue.get(issue.id) ?? []
  const included = new Map<string, SessionMeta>()
  for (const session of [...direct, ...(issue.sessions ?? [])]) {
    if (session.archived || session.agentKind === 'shell' || session.headless === true) continue
    included.set(session.sessionId, session)
  }
  return [...included.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
}

/**
 * Phone counterpart of the desktop work sidebar / taskbar:
 * pinned first, then stable repository groups, nested live agents, finished
 * rows held open until tuck (or the grace backstop), closed fold per group.
 * Proposed and deleted work stay out of workspace navigation.
 */
export function buildWorkSections(
  issues: IssueWire[],
  sessions: SessionMeta[],
  opts: BuildWorkSectionsOpts = {},
): WorkSection[] {
  const now = opts.now ?? Date.now()
  const tuckedIds = opts.tuckedIds ?? new Set<string>()

  const liveSessions = sessions.filter(
    (session) => !session.archived && session.agentKind !== 'shell' && session.headless !== true,
  )
  const sessionsByIssue = new Map<string, SessionMeta[]>()
  for (const session of liveSessions) {
    if (!session.issueId) continue
    const group = sessionsByIssue.get(session.issueId) ?? []
    group.push(session)
    sessionsByIssue.set(session.issueId, group)
  }

  const rows: WorkIssue[] = []
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt || issue.stage === 'proposed') continue
    // Agent-audience internals stay nested under their parent on desktop; skip
    // them at the top level of the phone work list.
    if (issue.audience === 'agent') continue

    const issueSessions = liveSessionsFor(issue, sessionsByIssue)
    const finished = isFinished(issue)
    const tucked = tuckedIds.has(issue.id)
    const withinGrace = finished && now - finishedAt(issue) <= WORK_FINISHED_GRACE_MS
    const awaitsTuck = finished && !tucked && withinGrace
    const folded = finished && (tucked || !withinGrace)

    // Active stages, live agents, or recently finished (pre-tuck / grace).
    const active =
      ACTIVE_STAGES.has(issue.stage) || issueSessions.length > 0 || awaitsTuck || folded
    if (!active) continue
    // After grace + tuck, keep a thin closed fold only while still finished.
    if (folded && issueSessions.length === 0 && !withinGrace && !tucked) {
      // Past grace and not explicitly tucked — still show in Closed if finished
      // within a longer history window so Closed is useful.
      if (now - finishedAt(issue) > WORK_FINISHED_GRACE_MS * 7) continue
    }

    rows.push({ issue, sessions: issueSessions, awaitsTuck, folded })
  }

  const pinned = rows
    .filter((row) => row.issue.pinned && !row.folded)
    .sort(compareManualOrder)

  const byRepo = new Map<string, { open: WorkIssue[]; closed: WorkIssue[] }>()
  for (const row of rows) {
    if (row.issue.pinned && !row.folded) continue
    const key = row.issue.repoPath
    const bucket = byRepo.get(key) ?? { open: [], closed: [] }
    if (row.folded) bucket.closed.push(row)
    else bucket.open.push(row)
    byRepo.set(key, bucket)
  }

  const sections: WorkSection[] = []
  if (pinned.length > 0) {
    sections.push({ key: 'pinned', title: 'Pinned', data: pinned, closed: [] })
  }
  for (const [path, bucket] of [...byRepo.entries()].sort(([a], [b]) =>
    repoName(a).localeCompare(repoName(b)),
  )) {
    bucket.open.sort(compareManualOrder)
    bucket.closed.sort((a, b) => finishedAt(b.issue) - finishedAt(a.issue))
    if (bucket.open.length === 0 && bucket.closed.length === 0) continue
    sections.push({
      key: path,
      title: repoName(path),
      data: bucket.open,
      closed: bucket.closed,
    })
  }
  return sections
}
