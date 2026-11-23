import type { MobxPool } from '@podium/client-graph'
import { omitGone } from '@podium/client-graph/lookup'
import { issueRefText } from '@podium/protocol'

/** Identity labels need the named row and its declared repo, never the
 * resident reference-reader bootstrap or any other issue's payload. */
export function readAddressedIssueRef(
  pool: MobxPool,
  id: string,
  row: { seq: number; prefix?: string; displayRef?: string },
) {
  const repoId = pool.relations.one('issue', id, 'repo')
  const repo = repoId ? omitGone(pool.row('repo', repoId)) : undefined
  const prefix =
    (repo && typeof repo !== 'symbol' ? (repo as { prefix?: string }).prefix : undefined) ??
    row.prefix
  return {
    prefix,
    displayRef: repoId
      ? issueRefText(row.seq, prefix)
      : (row.displayRef ?? issueRefText(row.seq, prefix)),
  }
}
