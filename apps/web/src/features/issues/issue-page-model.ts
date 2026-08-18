/**
 * Viewmodel for the issue page (P5d, issue #264): the busy/error mutation
 * runner, the lazy comment thread, the event-log drain, and the pure
 * "what to show" derivations — everything IssuePage renders but none of the
 * JSX. Extracted verbatim from IssuePage.tsx; behavior is unchanged.
 */

import { shallowEqual } from '@podium/client-core'
import {
  type ActivityComment,
  type ActivityItem,
  buildActivityFeed,
  type IssueEvent,
  subIssuesOf,
} from '@podium/client-core/viewmodels'
import type { IssueId, SessionId, SessionMeta, UserId } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Store } from '@/app/store'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import type { PropertyOption } from '@/lib/PropertyMenu'
import { issueNeighbors } from './issue-page'
import {
  type IssueMailMessage,
  loadIssueComments,
  loadIssueEventsPage,
  loadIssueMail,
  loadMergeStyle,
  type MergeStyle,
  type RunMutation,
} from './issue-page-commands'

/** Page size for the subject-narrowed event drain. One issue's whole history is
 *  normally far below this, so the drain is a single round trip; a full page is
 *  the signal that more remain. */
const EVENTS_PAGE = 200

export interface IssuePageModel {
  trpc: Trpc
  issueWrites: Pick<
    Store,
    | 'updateIssue'
    | 'deleteIssue'
    | 'closeIssue'
    | 'deferIssue'
    | 'undeferIssue'
    | 'setIssueLabels'
    | 'restoreIssue'
  >
  issues: IssueViewModel[]
  busy: boolean
  /** Run a mutation, surfacing any thrown error verbatim as an error toast. */
  run: RunMutation
  prev?: IssueId
  next?: IssueId
  /** Last path segment of the repo — the breadcrumb label. */
  repoName: string
  /** Comments and state-transition events interleaved chronologically. */
  feed: ActivityItem[]
  /** Agent mail addressed to this issue (issue #103) — operator peek, so
   *  listing here never consumes the recipient's unread status. */
  mail: IssueMailMessage[]
  /** Sub-issues (archived children stay visible — issue #133). */
  children: IssueViewModel[]
  /** This issue's member sessions, resolved against the session world. The Now
   *  block and the rail's roster both render from this one list (POD-591), so
   *  they can never disagree about who is on the task. */
  memberSessions: SessionMeta[]
  /** [spec:SP-a1c0] (#411) Route through the central action — never roll
   *  per-feature navigation (setPane+setView flips the URL then reverts). */
  openSession: (sessionId: SessionId) => void
  /** Optimistic local append after a posted comment (the updatedAt-keyed
   *  refetch then replaces it with server truth). */
  appendLocalComment: (body: string) => void
}

export function useIssuePageModel(issue: IssueViewModel, orderedIds: IssueId[]): IssuePageModel {
  const {
    trpc,
    hub,
    sessions,
    navigateToSession,
    updateIssue,
    deleteIssue,
    closeIssue,
    deferIssue,
    undeferIssue,
    setIssueLabels,
    restoreIssue,
  } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      hub: s.hub,
      sessions: s.sessions,
      navigateToSession: s.navigateToSession,
      updateIssue: s.updateIssue,
      deleteIssue: s.deleteIssue,
      closeIssue: s.closeIssue,
      deferIssue: s.deferIssue,
      undeferIssue: s.undeferIssue,
      setIssueLabels: s.setIssueLabels,
      restoreIssue: s.restoreIssue,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const [busy, setBusy] = useState(false)
  const [events, setEvents] = useState<IssueEvent[]>([])
  const [comments, setComments] = useState<ActivityComment[]>([])
  const [mail, setMail] = useState<IssueMailMessage[]>([])

  // Seed comments on issue switch from the (legacy, pre-#175) embedded thread if
  // the wire still carries one; the lazy fetch below replaces it with server
  // truth.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setComments(issue.comments ?? [])
  }, [issue.id])

  // Lazy comment fetch (#175): comment bodies no longer ride IssueViewModel — fetch
  // the thread on open via issues.comments, and re-fetch whenever the live wire
  // row's updatedAt moves (every addComment broadcasts the updated issue, so
  // a new comment — ours or an agent's — pulls the fresh thread). Best-effort:
  // a fetch error keeps whatever is shown. The wrapping Promise.resolve() also
  // absorbs a missing proc on the client seam instead of crashing the render.
  // Legacy fallback: a pre-#175 wire may still EMBED comments and lack the proc's
  // data locally — use the embedded thread when the fetch comes back empty.
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
  }, [issue.id, issue.updatedAt])

  // Agent mailbox (issue #103): fetched on open and re-fetched when the live
  // wire row moves (a mailSend bumps nothing on the wire itself, but the
  // updatedAt tick from the same agent's other writes usually follows; the
  // fetch is cheap and best-effort either way). The wrapping Promise.resolve()
  // absorbs a missing proc on the client seam (older servers, test mocks)
  // instead of crashing the render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on issue switch / update tick only; trpc is a stable store singleton
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => loadIssueMail(trpc, issue.id))
      .then((rows) => {
        if (!cancelled) setMail(rows)
      })
      .catch(() => {
        if (!cancelled) setMail([])
      })
    return () => {
      cancelled = true
    }
  }, [issue.id, issue.updatedAt])

  // Load this issue's state-transition events for the activity feed (interleaved
  // with comments below). The events route is cursor-paged (ascending from
  // `since`) and narrowed to this issue's subject SERVER-SIDE (POD-532), so a
  // page holds only rows this feed will render — no repo-wide download, and no
  // issue silently emptied by its events falling outside the newest page. On
  // open we drain to the end, then advance the cursor and let each
  // `issuesChanged` broadcast pull only the new tail. This is best-effort: a
  // fetch error just leaves the comment-only feed intact.
  // Deps are the issue identity only — `trpc`/`hub` are stable store singletons,
  // so keying on them would just risk a refetch loop if their identity churned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only on issue switch; trpc/hub are stable
  useEffect(() => {
    let cancelled = false
    let since = 0
    const absorb = (rows: IssueEvent[]): void => {
      if (cancelled || rows.length === 0) return
      since = rows.reduce((m, r) => Math.max(m, r.id), since)
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id))
        const added = rows.filter((e) => !seen.has(e.id))
        return added.length > 0 ? [...prev, ...added] : prev
      })
    }
    const drain = (): void => {
      loadIssueEventsPage(trpc, {
        since,
        repoPath: issue.repoPath,
        subject: issue.id,
        limit: EVENTS_PAGE,
      })
        .then((rows) => {
          if (cancelled) return
          absorb(rows)
          if (rows.length === EVENTS_PAGE) drain() // a full page means more remain
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

  // A REFUSED WRITE IS AN ALERT, NOT A FOOTNOTE (POD-1266). This used to set a
  // string that IssuePage drew as a muted strip pinned under the whole page —
  // so `Start work` failing on an existing branch answered three hundred pixels
  // below the button, in the grey reserved for captions, in the one place the
  // eye is not after pressing something. It goes through the app's own
  // `<Toaster/>` now, which is where every other refusal in the app already
  // lands (IssueCompactControls fires the SAME start error that way) and which
  // is already cut for this content: `.cn-toast` sizes to the message and wraps
  // a worktree path without shredding it.
  const run: RunMutation = async (fn) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const { prev, next } = issueNeighbors(orderedIds, issue.id)

  return {
    trpc,
    issueWrites: {
      updateIssue,
      deleteIssue,
      closeIssue,
      deferIssue,
      undeferIssue,
      setIssueLabels,
      restoreIssue,
    },
    issues,
    busy,
    run,
    prev,
    next,
    repoName: issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath,
    feed: buildActivityFeed(comments, events),
    mail,
    memberSessions: (issue.memberSessionIds ?? [])
      .map((id) => (sessions ?? []).find((session) => session.sessionId === id))
      .filter((session): session is SessionMeta => session !== undefined),
    openSession: navigateToSession,
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
export function repoMatesOf(issues: IssueViewModel[], issue: IssueViewModel): IssueViewModel[] {
  return issues
    .filter((i) => i.repoPath === issue.repoPath && i.id !== issue.id)
    .sort((a, b) => a.seq - b.seq)
}

export function mateOptionsOf(repoMates: IssueViewModel[]): PropertyOption[] {
  return repoMates.map((i) => ({ value: i.id, label: `${issueDisplayRef(i)} ${i.title}` }))
}

/** Sentinel option value for "no assignee" in the assignee menu. */
export const UNASSIGNED = '__unassigned__'

/** Distinct assignees across all issues — the suggestion pool. */
export function assigneeOptionsOf(issues: IssueViewModel[]): PropertyOption[] {
  return [
    { value: UNASSIGNED, label: 'Unassigned' },
    ...[...new Set(issues.map((i) => i.assignee).filter((a): a is UserId => !!a))]
      .sort()
      .map((a) => ({ value: a, label: a })),
  ]
}

/** Distinct labels across all issues not already on this one. */
export function labelPoolOf(issues: IssueViewModel[], issue: IssueViewModel): string[] {
  return [...new Set(issues.flatMap((i) => i.labels))]
    .filter((l) => !issue.labels.includes(l))
    .sort()
}
