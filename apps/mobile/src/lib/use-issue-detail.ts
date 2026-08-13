import {
  type ActivityComment,
  type ActivityItem,
  buildActivityFeed,
  type IssueEvent,
} from '@podium/client-core/viewmodels'
import type { IssueWire } from '@podium/model'
import { useEffect, useState } from 'react'
import { useHub, useTrpc } from '../client/hooks'
import {
  type IssueMailMessage,
  loadIssueComments,
  loadIssueEventsPage,
  loadIssueMail,
  shouldContinueEventDrain,
} from './issue-detail'

/**
 * The task page's three lazy reads — the comment thread, the agent mailbox and
 * the state-transition event log — merged into one activity feed [POD-724].
 *
 * Kept as a hook rather than folded into the screen because all three share one
 * discipline that is easy to lose when it is inlined: EVERY ONE IS BEST-EFFORT,
 * INDIVIDUALLY, AGAINST BOTH FAILURE SHAPES.
 *
 * The phone is the surface most likely to be talking to an older node, to a node
 * that does not serve one of these procs, or to no node at all — the demo
 * fixture world has no server behind the origin, so every request there comes
 * back as the app's own `index.html` and rejects on `JSON.parse`. Both shapes
 * are covered the same way, and it has to be BOTH:
 *
 *  · a SYNCHRONOUS throw (a proc the client seam does not name) is absorbed by
 *    starting each call inside `Promise.resolve().then(…)`, so it becomes a
 *    rejection instead of escaping the effect into React;
 *  · a REJECTION (transport error, HTML where JSON was expected) is caught per
 *    call, so the section it feeds stays empty and its two neighbours still load.
 *
 * A task page missing its Mail section is a page. A task page that lets one read
 * escape takes the screen — and, because an unhandled boot-time rejection is
 * indistinguishable from a failed boot, it took the whole app to the
 * "could not open its local data" screen.
 *
 * The refetch keys are the desktop model's, for the same reasons. Comments and
 * mail re-read on `updatedAt` — every `addComment` broadcasts the updated issue,
 * so a comment (ours or an agent's) pulls the fresh thread without a second
 * channel. Events drain to the end on open, then re-drain on each `issuesChanged`
 * broadcast, pulling only the new tail.
 */

/** Page size for the subject-narrowed event drain. One task's whole history is
 *  normally far below this, so the drain is a single round trip; a full page is
 *  the signal that more remain. */
const EVENTS_PAGE = 200

export interface IssueActivity {
  /** Comments and state-transition events interleaved chronologically. */
  feed: ActivityItem[]
  /** Agent mail addressed to this task — an operator peek, so listing it here
   *  never consumes the recipient's unread status. */
  mail: IssueMailMessage[]
  /** Optimistic local append after a posted comment; the updatedAt-keyed refetch
   *  then replaces it with server truth. */
  appendLocalComment: (body: string) => void
}

export function useIssueActivity(issue: IssueWire): IssueActivity {
  const trpc = useTrpc()
  const hub = useHub()
  const [comments, setComments] = useState<ActivityComment[]>([])
  const [events, setEvents] = useState<IssueEvent[]>([])
  const [mail, setMail] = useState<IssueMailMessage[]>([])

  const issueId = issue.id
  const updatedAt = issue.updatedAt
  const repoPath = issue.repoPath
  // The legacy embedded thread (pre-#175 payloads still carry one) is the seed
  // and the fallback: a hub-mirrored row has no local comments, so an empty
  // fetch means "ask the wire", not "there are none".
  const embedded = issue.comments

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on task switch / update tick only; `embedded` is a seed read at that moment and trpc is a stable store singleton
  useEffect(() => {
    let cancelled = false
    setComments(embedded ?? [])
    Promise.resolve()
      .then(() => loadIssueComments(trpc, issueId))
      .then((rows) => {
        // Shape-guarded, not just error-guarded: a seam that answers something
        // other than a row list is a fact about the server, not a reason for
        // `.map` to throw inside a render.
        if (cancelled) return
        const list = Array.isArray(rows) ? rows : []
        setComments(list.length === 0 ? (embedded ?? []) : list)
      })
      .catch(() => {
        // best-effort — keep whatever we already have
      })
    return () => {
      cancelled = true
    }
  }, [issueId, updatedAt])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on task switch / update tick only; trpc is a stable store singleton
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => loadIssueMail(trpc, issueId))
      .then((rows) => {
        if (!cancelled) setMail(Array.isArray(rows) ? rows : [])
      })
      .catch(() => {
        if (!cancelled) setMail([])
      })
    return () => {
      cancelled = true
    }
  }, [issueId, updatedAt])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on task switch only; trpc/hub are stable store singletons
  useEffect(() => {
    let cancelled = false
    let since = 0
    let pages = 0
    let draining = false
    const absorb = (rows: IssueEvent[]): void => {
      if (cancelled || !Array.isArray(rows) || rows.length === 0) return
      since = rows.reduce((m, r) => Math.max(m, r.id), since)
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id))
        const added = rows.filter((e) => !seen.has(e.id))
        return added.length > 0 ? [...prev, ...added] : prev
      })
    }
    const drain = (): void => {
      // One in-flight drain at a time. `hub.onIssues` fires on every task
      // write; stacking them is how a busy board turned this page into a
      // request storm.
      if (draining) return
      draining = true
      const step = (): void => {
        const sinceBefore = since
        // Wrapped, like the two reads above: a missing `issues.events` on the
        // client seam throws where the call is MADE, and `drain` is called from
        // the effect body and from a hub callback — neither of which has a catch.
        Promise.resolve()
          .then(() =>
            loadIssueEventsPage(trpc, { since, repoPath, subject: issueId, limit: EVENTS_PAGE }),
          )
          .then((rows) => {
            if (cancelled) return
            absorb(rows)
            pages += 1
            if (
              shouldContinueEventDrain({
                pageLength: Array.isArray(rows) ? rows.length : 0,
                pageSize: EVENTS_PAGE,
                sinceBefore,
                sinceAfter: since,
                pages,
              })
            ) {
              step()
              return
            }
            draining = false
          })
          .catch(() => {
            draining = false
          })
      }
      step()
    }
    setEvents([])
    drain()
    const off = hub.onIssues(() => drain())
    return () => {
      cancelled = true
      off()
    }
  }, [issueId, repoPath])

  return {
    feed: buildActivityFeed(comments, events),
    mail,
    appendLocalComment: (body) =>
      setComments((cur) => [...cur, { author: 'me', body, createdAt: new Date().toISOString() }]),
  }
}
