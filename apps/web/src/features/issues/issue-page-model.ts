/**
 * Viewmodel for the issue page (P5d, issue #264): the busy/toast mutation
 * runner, the lazy comment thread, the event-log drain, and the pure
 * "what to show" derivations — everything IssuePage renders but none of the
 * JSX. Extracted verbatim from IssuePage.tsx; behavior is unchanged.
 */
import { shallowEqual } from '@podium/client-core'
import { type IssueWire, issueDisplayRef } from '@podium/protocol'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import { subIssuesOf } from '@/lib/derive'
import type { PropertyOption } from '@/lib/PropertyMenu'
import {
  type ActivityComment,
  type ActivityItem,
  buildActivityFeed,
  type IssueEvent,
} from './issue-events'
import { issueNeighbors } from './issue-page'
import {
  loadIssueComments,
  loadIssueEventsPage,
  loadMergeStyle,
  type MergeStyle,
  type RunMutation,
} from './issue-page-commands'

export interface IssuePageModel {
  trpc: Trpc
  issues: IssueWire[]
  busy: boolean
  toast: string
  /** Run a mutation, surfacing any thrown error verbatim as an inline toast. */
  run: RunMutation
  prev?: string
  next?: string
  /** Last path segment of the repo — the breadcrumb label. */
  repoName: string
  /** Comments and state-transition events interleaved chronologically. */
  feed: ActivityItem[]
  /** Sub-issues (archived children stay visible — issue #133). */
  children: IssueWire[]
  /** Optimistic local append after a posted comment (the commentCount-keyed
   *  refetch then replaces it with server truth). */
  appendLocalComment: (body: string) => void
}

export function useIssuePageModel(issue: IssueWire, orderedIds: string[]): IssuePageModel {
  const { trpc, issues, hub } = useStoreSelector(
    (s) => ({ trpc: s.trpc, issues: s.issues, hub: s.hub }),
    shallowEqual,
  )
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [events, setEvents] = useState<IssueEvent[]>([])
  const [comments, setComments] = useState<ActivityComment[]>([])

  // Reset the toast on issue switch and seed comments from the (legacy,
  // pre-#175) embedded thread if the wire still carries one; the lazy fetch
  // below replaces it with server truth.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setToast('')
    setComments(issue.comments ?? [])
  }, [issue.id])

  // Lazy comment fetch (#175): comment bodies no longer ride IssueWire — fetch
  // the thread on open via issues.comments, and re-fetch whenever the live wire
  // row's commentCount moves (every addComment broadcasts the updated issue, so
  // a new comment — ours or an agent's — pulls the fresh thread). Best-effort:
  // a fetch error keeps whatever is shown. The wrapping Promise.resolve() also
  // absorbs a missing proc on the client seam instead of crashing the render.
  // Legacy fallback: a pre-#175 hub-mirrored wire may still EMBED comments and
  // lack the proc's data locally (the node returns [] for viaHub issues) — use
  // the embedded thread when the fetch comes back empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on issue switch / count change only; trpc is a stable store singleton
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => loadIssueComments(trpc, issue.id))
      .then((rows) => {
        if (cancelled) return
        setComments(rows.length === 0 ? (issue.comments ?? []) : rows)
      })
      .catch(() => {
        // best-effort — keep whatever we already have
      })
    return () => {
      cancelled = true
    }
  }, [issue.id, issue.commentCount])

  // Load this issue's state-transition events for the activity feed (interleaved
  // with comments below). The events route is repo-scoped and cursor-paged
  // (ascending from `since`), so on open we drain to the end, then advance the
  // cursor and let each `issuesChanged` broadcast pull only the new tail. This is
  // best-effort: a fetch error just leaves the comment-only feed intact.
  // Deps are the issue identity only — `trpc`/`hub` are stable store singletons,
  // so keying on them would just risk a refetch loop if their identity churned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only on issue switch; trpc/hub are stable
  useEffect(() => {
    let cancelled = false
    let since = 0
    const absorb = (rows: IssueEvent[]): void => {
      if (cancelled || rows.length === 0) return
      since = rows.reduce((m, r) => Math.max(m, r.id), since)
      const mine = rows.filter((r) => r.subject === issue.id)
      if (mine.length > 0)
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id))
          const added = mine.filter((e) => !seen.has(e.id))
          return added.length > 0 ? [...prev, ...added] : prev
        })
    }
    const drain = (): void => {
      loadIssueEventsPage(trpc, { since, repoPath: issue.repoPath, limit: 1000 })
        .then((rows) => {
          if (cancelled) return
          absorb(rows)
          if (rows.length === 1000) drain() // a full page means more remain
        })
        .catch(() => {
          // best-effort — keep whatever we already have
        })
    }
    setEvents([])
    drain()
    const off = hub.onIssues(() => drain())
    return () => {
      cancelled = true
      off()
    }
  }, [issue.id, issue.repoPath])

  const run: RunMutation = async (fn) => {
    setBusy(true)
    setToast('')
    try {
      await fn()
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const { prev, next } = issueNeighbors(orderedIds, issue.id)

  return {
    trpc,
    issues,
    busy,
    toast,
    run,
    prev,
    next,
    repoName: issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath,
    feed: buildActivityFeed(comments, events),
    children: subIssuesOf(issues, issue.id),
    appendLocalComment: (body) =>
      setComments((cur) => [...cur, { author: 'me', body, createdAt: new Date().toISOString() }]),
  }
}

/** The configured merge style, loaded once per mount ('ff-only' is the safe
 *  default primary while loading / on error). */
export function useMergeStyle(trpc: Trpc): MergeStyle {
  const [mergeStyle, setMergeStyle] = useState<MergeStyle>('ff-only')
  useEffect(() => {
    let cancelled = false
    loadMergeStyle(trpc)
      .then((style) => {
        if (!cancelled) setMergeStyle(style)
      })
      .catch(() => {
        // best-effort — ff-only is a safe default primary
      })
    return () => {
      cancelled = true
    }
  }, [trpc])
  return mergeStyle
}

// ---------------------------------------------------------------------------
// Pure derivations shared by the page, its overflow menu, and the properties
// aside (extracted verbatim from the former inline computations).
// ---------------------------------------------------------------------------

/** Repo-mates: sibling issues in the same repo excluding self, seq-ordered —
 *  the pool for relations, parent, and supersede/duplicate targets. */
export function repoMatesOf(issues: IssueWire[], issue: IssueWire): IssueWire[] {
  return issues
    .filter((i) => i.repoPath === issue.repoPath && i.id !== issue.id)
    .sort((a, b) => a.seq - b.seq)
}

export function mateOptionsOf(repoMates: IssueWire[]): PropertyOption[] {
  return repoMates.map((i) => ({ value: i.id, label: `${issueDisplayRef(i)} ${i.title}` }))
}

/** Sentinel option value for "no assignee" in the assignee menu. */
export const UNASSIGNED = '__unassigned__'

/** Distinct assignees across all issues — the suggestion pool. */
export function assigneeOptionsOf(issues: IssueWire[]): PropertyOption[] {
  return [
    { value: UNASSIGNED, label: 'Unassigned' },
    ...[...new Set(issues.map((i) => i.assignee).filter((a): a is string => !!a))]
      .sort()
      .map((a) => ({ value: a, label: a })),
  ]
}

/** Distinct labels across all issues not already on this one. */
export function labelPoolOf(issues: IssueWire[], issue: IssueWire): string[] {
  return [...new Set(issues.flatMap((i) => i.labels))]
    .filter((l) => !issue.labels.includes(l))
    .sort()
}
