/**
 * WORKLIST SLICE — how a row's sessions are bucketed and nested (POD-330).
 *
 * Three questions, all about a SET of sessions inside one row or one worktree:
 * which bucket each session is in (attention / working / pinned), which ones
 * sink into the stale tail, and which nest under which spawner.
 *
 * Not F3: F3 answers "which session matters more" and returns an order or a
 * rank. These return PARTITIONS and TREES — a different shape, and only the
 * worklist asks for them.
 *
 * EVICTION IS NOT A DELETION. Every function here is rebuilt from whatever
 * sessions are present, so a session that leaves the replica leaves each bucket
 * and each group cleanly: no tombstone, no "deleted" placeholder, and — the one
 * that would actually loop — `groupSessionsByParent` treats a spawn parent that
 * is no longer visible as *not listed*, which makes the child top-level rather
 * than an orphan waiting for a parent that will never arrive.
 *
 * Depends on F1 and F3.
 * Platform-neutral: no DOM, no storage.
 */
import {
  isHeadlessSession,
  isSnoozed,
  type SessionId,
  type SessionMeta,
  spawnedByParentSessionId,
} from '@podium/model'
import { attentionGroup, compareRecency } from '../../../focus'
import { isConsumedChild, sessionHasNativeSubagents } from '../../session-status'
import { STALE_INACTIVE_MS } from '../../session-urgency'

export interface WorkItemPartition {
  /** Sessions needing the user's attention: blocked, finished-idle, errored, or exited. */
  attention: SessionMeta[]
  /** Sessions actively running without needing the user. */
  working: SessionMeta[]
  /** Pinned sessions — also listed in attention/working when their state warrants it. */
  pinnedPanels: SessionMeta[]
}

/**
 * Partition sessions into the three WORK ITEMS buckets used by work-list views.
 *
 * Non-archived sessions are classified into `attention` or `working` by agent
 * state regardless of pin status. Pinned sessions additionally appear in
 * `pinnedPanels` for quick reach (same lift-and-keep pattern as worktree lists).
 *   - `attention` — any attentionGroup result other than 'working'
 *     (i.e. needsYou, idle, exited/hibernated/ended), minus snoozed/shells.
 *   - `working` — phase 'working' | 'compacting', or an active shell/uninstrumented live process.
 * Archived sessions are excluded entirely.
 */
export function partitionWorkItems(
  sessions: SessionMeta[],
  pinnedSessionIds: Set<string>,
  now: number = Date.now(),
): WorkItemPartition {
  const attention: SessionMeta[] = []
  const working: SessionMeta[] = []
  const pinnedPanels: SessionMeta[] = []

  for (const s of sessions) {
    if (s.archived || isHeadlessSession(s)) continue
    // Shells never appear in the sidebar — not in WORKING, PINNED, or attention.
    if (s.agentKind === 'shell') continue
    if (pinnedSessionIds.has(s.sessionId)) pinnedPanels.push(s)
    const group = attentionGroup(s)
    if (group === 'working') {
      working.push(s)
    } else if (isSnoozed(s, now)) {
    } else {
      attention.push(s)
    }
  }

  // Every WORK ITEMS section in the repo tree reads newest-active first. Without this,
  // raw arrival order would put the newest attention session at the bottom.
  attention.sort((a, b) => compareRecency(a, b, now))
  working.sort((a, b) => compareRecency(a, b, now))
  pinnedPanels.sort((a, b) => compareRecency(a, b, now))
  return { attention, working, pinnedPanels }
}

/** A session is "stale" when it's been inactive longer than this. */
export interface StalePartition {
  /** Sessions to render normally. */
  visible: SessionMeta[]
  /** Sessions sunk into the collapsed "Stale" subsection at the bottom. */
  stale: SessionMeta[]
}

/**
 * Split a worktree's (or attention list's) already-sorted sessions into a
 * visible head and a collapsed "Stale" tail. Stale candidates are non-working
 * sessions inactive for more than {@link STALE_INACTIVE_MS}. The split only
 * kicks in for a crowded group — MORE than 5 sessions total AND MORE than 3
 * stale candidates — and even then the 3 most-recently-active candidates stay
 * visible; only the rest collapse. Working sessions are never collapsed.
 */
export function partitionStaleSessions(
  sorted: SessionMeta[],
  now: number = Date.now(),
): StalePartition {
  const isCandidate = (s: SessionMeta): boolean =>
    attentionGroup(s) !== 'working' && now - Date.parse(s.lastActiveAt) > STALE_INACTIVE_MS
  const candidates = sorted.filter(isCandidate)
  if (sorted.length <= 5 || candidates.length <= 3) return { visible: sorted, stale: [] }
  // Keep the 3 most-recently-active candidates visible; collapse the remainder.
  const byRecency = [...candidates].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  const staleIds = new Set(byRecency.slice(3).map((s) => s.sessionId))
  return {
    visible: sorted.filter((s) => !staleIds.has(s.sessionId)),
    stale: sorted.filter((s) => staleIds.has(s.sessionId)),
  }
}

/** One sidebar session group (#237) [spec:SP-34d7 web]: a top-level session
 *  plus the cross-harness children spawned by it (`spawnedBy: 'session:<id>'`,
 *  resolved to the topmost listed ancestor so deep fan-out stays one level in
 *  the UI). Children split into `children` (live/attention-worthy) and
 *  `consumed` (exited — auto-tucked behind a disclosure). */
export interface SessionGroup {
  session: SessionMeta
  children: SessionMeta[]
  consumed: SessionMeta[]
}

/** The spawning parent, read through the ONE `spawnedBy` reader (POD-1133).
 *  This used to be a local regex — the second of two hand-rolled parsers of a
 *  tag that seven other sites rebuilt by hand to compare. */
const spawnedByParentId = (s: SessionMeta): SessionId | undefined =>
  spawnedByParentSessionId(s.spawnedBy)

/**
 * Whether a sidebar issue/worktree row should expand to show nested session
 * rows (remote spawn children and/or native-subagent indicators).
 *
 * - A genuine remote spawn-child must nest under its spawner even when it is
 *   the only extra session (parent + 1 child) — never hide it behind the
 *   parent status line just because the list is short.
 * - A lone parent with `nativeSubagentCount > 0` still expands so the native
 *   indicator is visible.
 * - Unrelated multi-agent rows keep expanding as before.
 */
export function sessionsNeedChildRows(sessions: SessionMeta[]): boolean {
  if (sessions.length === 0) return false
  // Native Task subagents: expand even for a lone parent session so the
  // nested "N subagents" indicator is visible under the parent row.
  if (sessions.some(sessionHasNativeSubagents)) return true
  // Multi-session list: expand so remote spawn children and sibling agents
  // are visible as rows. Parent + a single remote child is length 2 — never
  // collapse that genuine spawn-child into the parent status line.
  return sessions.length >= 2
}

/**
 * Group a row's sessions by spawn parentage so cross-harness fan-out doesn't
 * flatten into an unusable list: a session whose spawner is ALSO in the list
 * nests under it (grandchildren fold into the topmost listed ancestor); a
 * session whose spawner isn't listed stays top-level. Input order is preserved
 * on both levels.
 */
export function groupSessionsByParent(sessions: SessionMeta[]): SessionGroup[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]))
  // Topmost listed ancestor (cycle-guarded); null = top-level.
  const anchorOf = (s: SessionMeta): SessionId | null => {
    let cur = s
    let anchor: SessionId | null = null
    const seen = new Set<string>([s.sessionId])
    for (;;) {
      const pid = spawnedByParentId(cur)
      if (!pid || seen.has(pid)) break
      // No cast: the shared reader returns a `SessionId`, so the brand is applied
      // once where the tag is parsed rather than at each site that consumes it.
      const parent = byId.get(pid)
      // A parent that is not in `sessions` is not listed — whether it was never
      // there, has not arrived, or is no longer VISIBLE to this principal. The
      // child stays top-level in all three cases, which is why an eviction
      // cannot leave a row waiting on a parent that will never come.
      if (!parent) break
      anchor = pid
      seen.add(pid)
      cur = parent
    }
    return anchor
  }
  const groups: SessionGroup[] = []
  const groupByAnchor = new Map<string, SessionGroup>()
  for (const s of sessions) {
    if (anchorOf(s) === null) {
      const g: SessionGroup = { session: s, children: [], consumed: [] }
      groups.push(g)
      groupByAnchor.set(s.sessionId, g)
    }
  }
  for (const s of sessions) {
    const anchor = anchorOf(s)
    if (anchor === null) continue
    const g = groupByAnchor.get(anchor)
    if (!g) continue // ancestor listed but itself nested-orphaned — treat as top-level
    ;(isConsumedChild(s) ? g.consumed : g.children).push(s)
  }
  // Orphaned nested children (anchor resolved but the anchor never became a
  // group — can't happen with anchorOf's topmost rule, but stay total):
  for (const s of sessions) {
    const anchor = anchorOf(s)
    if (anchor !== null && !groupByAnchor.has(anchor)) {
      groups.push({ session: s, children: [], consumed: [] })
    }
  }
  return groups
}
