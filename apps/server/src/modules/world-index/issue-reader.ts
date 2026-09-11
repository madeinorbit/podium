import { isIssueClosed } from '@podium/model'
import type { IssuesRepository } from '../../store/issues'
import type { IssueRow } from '../../store/types'
import { spanOpen } from '../../store/executor/executor'

type IssueReadPort = Pick<IssuesRepository, 'getIssue' | 'getIssues'>
// As with grant-reader, repository identity isolates instances and unbound
// repositories remain live. The callback borrows IssueStore's existing map.
interface CommittedIssueReader {
  rows(): ReadonlyMap<string, IssueRow>
}
const committedReaders = new WeakMap<IssueReadPort, CommittedIssueReader>()
export function bindCommittedIssueReader(repository: IssueReadPort, rows: CommittedIssueReader['rows'] | undefined): void {
  if (rows) committedReaders.set(repository, { rows })
  else committedReaders.delete(repository)
}

function copy(row: IssueRow): IssueRow {
  return { ...row, blockedBy: [...row.blockedBy],
    humanQuestionOptions: row.humanQuestionOptions ? [...row.humanQuestionOptions] : row.humanQuestionOptions }
}

/** Never answer read-your-writes from the committed snapshot. */
export async function readIssue(repository: IssueReadPort, id: string): Promise<IssueRow | null> {
  const reader = !spanOpen() && committedReaders.get(repository)
  if (!reader) return await repository.getIssue(id)
  const row = reader.rows().get(id)
  return row ? copy(row) : null
}

export async function readIssues(repository: IssueReadPort, ids: readonly string[]): Promise<Map<string, IssueRow>> {
  const reader = !spanOpen() && committedReaders.get(repository)
  if (!reader) return await repository.getIssues(ids)
  const rows = reader.rows()
  const result = new Map<string, IssueRow>()
  for (const id of ids) {
    const row = rows.get(id)
    if (row) result.set(id, copy(row))
  }
  return result
}

/** Whole-row readers retain the repository's repo-path/sequence ordering. */
export async function readIssueRows(repository: IssueReadPort & Pick<IssuesRepository, 'listIssueRows'>): Promise<IssueRow[]> {
  const reader = !spanOpen() && committedReaders.get(repository)
  if (!reader) return await repository.listIssueRows()
  return [...reader.rows().values()].sort((a, b) =>
    Buffer.compare(Buffer.from(a.repoPath), Buffer.from(b.repoPath)) || a.seq - b.seq,
  ).map(copy)
}


export async function readIssueCwdRows(repository: IssueReadPort & Pick<IssuesRepository, 'listIssueCwdRows' | 'listIssueRows'>) {
  if (spanOpen() || !committedReaders.has(repository)) return await repository.listIssueCwdRows()
  return (await readIssueRows(repository)).map(({ id, repoPath, worktreePath, deletedAt, archived }) =>
    ({ id, repoPath, worktreePath, deletedAt, archived }))
}

export async function readIssueParentEdges(repository: IssueReadPort & Pick<IssuesRepository, 'listIssueParentEdges'>) {
  const reader = !spanOpen() && committedReaders.get(repository)
  if (!reader) return await repository.listIssueParentEdges()
  return [...reader.rows().values()].filter(row => row.deletedAt == null)
    .map(({ id, parentId }) => ({ id, parentId }))
}

export async function readClosedIssueIds(repository: IssueReadPort & Pick<IssuesRepository, 'closedIssueIds'>) {
  const reader = !spanOpen() && committedReaders.get(repository)
  if (!reader) return await repository.closedIssueIds()
  return new Set([...reader.rows().values()].filter(row => row.deletedAt != null || isIssueClosed(row)).map(row => String(row.id)))
}
