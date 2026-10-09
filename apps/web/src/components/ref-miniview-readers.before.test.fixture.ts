import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import { parseAnyRef } from '@podium/protocol'
import { readAddressedIssueRef } from '@/lib/addressed-issue-ref'
import type { RefIssueLike } from '@/lib/ref-miniview'
import { readReferenceSession } from './ref-miniview-readers'

/** The reference card's old world (POD-5831), kept only as the comparison
 * oracle for its addressed target reader and shared model answers.
 * The named row, its parent labels and its issue seats are the card's world. */
export function readRefMiniview(pool: MobxPool, ref: string) {
  const parsed = parseAnyRef(ref)
  const session = parsed?.kind === 'session' ? readReferenceSession(pool, ref) : undefined
  const sessions: SessionView[] =
    session && typeof session !== 'symbol' ? [session as SessionView] : []
  const issues: RefIssueLike[] = []
  let loading = typeof session === 'symbol'
  const issueId =
    parsed?.kind === 'issue' ? pool.queries.issueReferenceId(ref) : sessions[0]?.issueId
  let next = issueId
  const seen = new Set<string>()
  let haveSeat = false
  while (next && !seen.has(next)) {
    seen.add(next)
    const row = pool.row('issue', next)
    if (typeof row === 'symbol') {
      loading = true
      break
    }
    if (!row) break
    const description = (row as { description?: string | { value?: string } }).description
    const issue = {
      ...row,
      description: typeof description === 'string' ? description : (description?.value ?? ''),
      ...pool.queries.issueChildCounts(next),
      ...readAddressedIssueRef(
        pool,
        next,
        row as { seq: number; prefix?: string; displayRef?: string },
      ),
    } as RefIssueLike
    issues.push(issue)
    if (parsed?.kind === 'issue' && !haveSeat) {
      // Raw attachment includes headless seats. Filter their addressed source
      // membership before reading payloads, and preserve replica-order ties.
      const question = { kind: 'commandIssueSessions', issueId: next, archived: false } as const
      const ids = [...pool.relations.many('issue', next, 'pageSessions')]
        .filter((id) => pool.queries.has(question, id) && !pool.queries.collapsed(id))
        .sort((a, b) => pool.queries.orderKey(a).localeCompare(pool.queries.orderKey(b)))
      for (const id of ids) {
        const seat = pool.row('session', id, 'summary-fields')
        if (typeof seat === 'symbol') loading = true
        else if (seat && (seat as SessionView).status !== 'exited') {
          sessions.push(seat as SessionView)
          haveSeat = true
        }
      }
    }
    next = pool.relations.one('issue', next, 'treeParent') ?? undefined
  }
  return { issues, sessions, loading }
}
