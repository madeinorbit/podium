import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { omitGone } from '@podium/client-graph/lookup'
import type { SessionId } from '@podium/model/browser'
import { parseAnyRef } from '@podium/protocol'
import { readAddressedIssueRef } from '@/lib/addressed-issue-ref'
import type { RefIssueLike, RefSessionLike, ResolvedRef } from '@/lib/ref-miniview'

export function readReferenceSession(pool: MobxPool, ref: string) {
  const id = pool.queries.sessionReferenceId(ref)
  return id ? omitGone(pool.row('session', id)) : undefined
}

/** The named row is the card's whole input. Its parent label, its session
 * target and a session's working task are leaves on the shared models. */
export function readRefTarget(
  pool: MobxPool,
  ref: string,
): { target: ResolvedRef | null; loading: boolean } {
  const parsed = parseAnyRef(ref)
  if (parsed?.kind === 'session') {
    const session = readReferenceSession(pool, ref)
    if (typeof session === 'symbol') return { target: null, loading: true }
    return {
      target:
        session && (session as unknown as RefSessionLike).displayRef === ref.trim()
          ? { kind: 'session', ref: parsed, session: session as unknown as RefSessionLike }
          : null,
      loading: false,
    }
  }
  const id = parsed?.kind === 'issue' ? pool.queries.issueReferenceId(ref) : undefined
  const row = id ? omitGone(pool.row('issue', id)) : undefined
  if (typeof row === 'symbol') return { target: null, loading: true }
  if (!id || !row || !parsed) return { target: null, loading: false }
  // Child progress over all history, from the stubs (POD-7088).
  const children = pool.queries.issueChildCounts(id)
  if (children === LOADING) return { target: null, loading: true }
  const issue = {
    ...row,
    // The description is its own record (POD-6921), read through the shared
    // model: the read holds and loads it, LOADING until it is here (POD-7545).
    // The stored row holds only a painted value, which the model prefers.
    description: pool.issueObject(id).description,
    ...children,
    ...readAddressedIssueRef(
      pool,
      id,
      row as { seq: number; prefix?: string; displayRef?: string },
    ),
  } as unknown as RefIssueLike
  return { target: { kind: 'issue', ref: parsed, issue }, loading: false }
}

/** The shared issue model's own reference label; empty while it is not loaded. */
export function readIssueDisplayRef(pool: MobxPool, id: string): string {
  return pool.issueObject(id).displayRef
}

/** Where "Go to session" lands: the shared issue answer names the covering
 * task and its live seat. Labels are separate reads, so a seat's heartbeat
 * never rebuilds this answer. */
export function readSessionTarget(
  pool: MobxPool,
  issueId: string,
): { viaId: string; sessionId: SessionId } | null {
  const viaId = pool.issueObject(issueId).seatHolderId
  const sessionId = viaId ? pool.issueObject(viaId).liveSeatId : null
  return viaId && sessionId ? { viaId, sessionId: sessionId as SessionId } : null
}

/** The session's permanent birth ref; empty while its row is loading. */
export function readSessionDisplayRef(pool: MobxPool, id: string): string {
  try {
    return pool.sessionObject(id).displayRef ?? ''
  } catch (error) {
    if (error === LOADING) return ''
    throw error
  }
}
