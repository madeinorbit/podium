import type { MobxPool } from '@podium/client-graph'
import { parseAnyRef } from '@podium/protocol'
import { readAddressedIssueRef } from '@/lib/addressed-issue-ref'
import type { RefIssueLike, RefSessionLike, ResolvedRef } from '@/lib/ref-miniview'

export function readReferenceSession(pool: MobxPool, ref: string) {
  const id = pool.queries.sessionReferenceId(ref)
  return id ? pool.row('session', id, 'summary-fields') : undefined
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
        session && (session as RefSessionLike).displayRef === ref.trim()
          ? { kind: 'session', ref: parsed, session: session as RefSessionLike }
          : null,
      loading: false,
    }
  }
  const id = parsed?.kind === 'issue' ? pool.queries.issueReferenceId(ref) : undefined
  const row = id ? pool.row('issue', id) : undefined
  if (typeof row === 'symbol') return { target: null, loading: true }
  if (!id || !row || !parsed) return { target: null, loading: false }
  const description = (row as { description?: string | { value?: string } }).description
  const issue = {
    ...row,
    description: typeof description === 'string' ? description : (description?.value ?? ''),
    ...pool.queries.issueChildCounts(id),
    ...readAddressedIssueRef(pool, id, row as { seq: number; prefix?: string; displayRef?: string }),
  } as RefIssueLike
  return { target: { kind: 'issue', ref: parsed, issue }, loading: false }
}
