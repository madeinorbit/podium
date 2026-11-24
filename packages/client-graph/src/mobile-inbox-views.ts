import type { SessionView } from '@podium/client-core/session-values'
import type { IssueReferenceModel } from '@podium/client-core/values'
import { lazy } from '@podium/mobx-helpers'
import type { PodiumTarget } from '@podium/protocol'
import { parseSessionRef } from '@podium/protocol'
import { reaction } from 'mobx'
import { readPageIssue } from './issue-page'
import { referenceView } from './issue-reference'
import { omitGone } from './lookup'
import { screeningQueue } from './mobile-triage'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** Constructed only with the enabled attachment. Shared computed readers keep
 * callbacks and retained chips addressed to this pool and this principal. */
export function createMobileInboxViews(pool: MobxPool) {
  const waits = new Set<() => void>()
  const booting = () => {
    const state = omitGone(pool.row('mobileInboxState', 'state'))
    return (
      !state ||
      state === LOADING ||
      (!state.hasCursor &&
        pool.queries.heldCount('session') === 0 &&
        pool.queries.heldCount('issue') === 0)
    )
  }
  class ScreeningQueue {
    @lazy get queue() {
      const ids = screeningQueue(pool)
      return ids === LOADING || !ids ? [] : ids
    }
    @lazy get booting() {
      return booting() || screeningQueue(pool) === LOADING
    }
  }
  const screening = new ScreeningQueue()
  function issue(id: string) {
    return readPageIssue(pool, id)
  }
  function chip(token: string, refKind: 'issue' | 'session', prefix: string) {
    const known = pool.queries.hasIssuePrefix(prefix, true)
    const model = known && refKind === 'issue' ? referenceView(pool).read(token) : null
    const unavailable: IssueReferenceModel | null =
      known && refKind === 'issue'
        ? {
            ref: token.trim(),
            issueId: null,
            title: null,
            stage: null,
            status: null,
            availability: 'unavailable',
            accessibleLabel: `Task ${token.trim()} is unavailable`,
          }
        : null
    return {
      known,
      model: model === LOADING ? unavailable : (model ?? unavailable),
      pending: model === LOADING,
    }
  }
  function session(identifier: string): Loaded<SessionView> {
    const trimmed = identifier.trim()
    // The same indexed identity lookup desktop uses includes exited sessions.
    // Stored rows carry ref fields, not the derived displayRef string.
    const id =
      pool.queries.linkedSessionId(trimmed) ?? (!parseSessionRef(trimmed) ? trimmed : undefined)
    return id ? (omitGone(pool.row('session', id)) as Loaded<SessionView>) : undefined
  }
  function route(target: PodiumTarget): Loaded<string | null> {
    if ((target.kind !== 'issue' && target.kind !== 'session') || target.search || target.hash)
      return null
    if (target.kind === 'session') {
      const row = session(target.session)
      return row === LOADING
        ? LOADING
        : row
          ? `/session/${encodeURIComponent(row.sessionId)}`
          : null
    }
    const direct = omitGone(pool.row('issue', target.issue.trim())) as Loaded<{
      id: string
    }>
    if (direct && direct !== LOADING) return `/issue/${encodeURIComponent(direct.id)}`
    // Bare aliases match the displayed fallback literally. Unlike PREFIX-N,
    // the legacy route does not parse a zero-padded bare sequence number.
    if (/^#0\d+$/.test(target.issue.trim())) return null
    const id = referenceView(pool).id(target.issue)
    return id === LOADING ? LOADING : id ? `/issue/${encodeURIComponent(id)}` : null
  }
  function resolveRoute(target: PodiumTarget): string | null | Promise<string | null> {
    const current = route(target)
    if (current !== LOADING) return current ?? null
    return new Promise((resolve) => {
      let stop: (() => void) | undefined,
        finished = false
      const finish = (value: string | null) => {
        finished = true
        stop?.()
        waits.delete(cancel)
        resolve(value)
      }
      const cancel = () => finish(null)
      waits.add(cancel)
      stop = reaction(
        () => route(target),
        (value) => {
          if (value !== LOADING) finish(value ?? null)
        },
        { fireImmediately: true },
      )
      if (finished) stop()
    })
  }
  return {
    issue,
    chip,
    route,
    resolveRoute,
    booting,
    screening: () => screening,
    session,
    dispose() {
      for (const cancel of [...waits]) cancel()
    },
  }
}
export type MobileInboxViews = ReturnType<typeof createMobileInboxViews>
