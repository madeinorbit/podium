import type { IssuesRepository } from '../../store/issues'
import type { IssueRow } from '../../store/types'
import { spanOpen } from '../../store/executor/executor'
import { compareWithIssueMap } from './service/map-parity'

/**
 * ISSUE READS FOR CODE OUTSIDE THE ISSUE MODULE (feed visibility, session
 * projection and authorization, memory, cost, the relay).
 *
 * They used to borrow IssueStore's in-memory map outside a save and ask SQL
 * inside one. Since POD-6195 they ask the repository every time (its read
 * scope memoises a row for an operation, as before inside a save). Until the
 * map is deleted (D1g, POD-6196) the map IssueStore binds here is asked beside
 * each read outside a save, for the old/new comparison (`map-parity.ts`); it
 * never answers.
 */

type IssueReadPort = Pick<IssuesRepository, 'getIssue' | 'getIssues'>
// Repository identity isolates instances; an unbound repository is not compared.
interface CommittedIssueReader {
  rows(): ReadonlyMap<string, IssueRow>
}
const committedReaders = new WeakMap<IssueReadPort, CommittedIssueReader>()
export function bindCommittedIssueReader(repository: IssueReadPort, rows: CommittedIssueReader['rows'] | undefined): void {
  if (rows) committedReaders.set(repository, { rows })
  else committedReaders.delete(repository)
}

/** The bound map, outside a save only: inside one it lags the save's writes. */
function mapOf(repository: IssueReadPort): ReadonlyMap<string, IssueRow> | undefined {
  if (spanOpen()) return undefined
  return committedReaders.get(repository)?.rows()
}

export async function readIssue(repository: IssueReadPort, id: string): Promise<IssueRow | null> {
  const row = await repository.getIssue(id)
  const map = mapOf(repository)
  if (map) compareWithIssueMap('readIssue', id, () => map.get(id) ?? null, row)
  return row
}

export async function readIssues(repository: IssueReadPort, ids: readonly string[]): Promise<Map<string, IssueRow>> {
  const rows = await repository.getIssues(ids)
  const map = mapOf(repository)
  if (map) {
    compareWithIssueMap('readIssues', ids, () => {
      const found = new Map<string, IssueRow>()
      for (const id of new Set(ids)) {
        const row = map.get(id)
        if (row) found.set(id, row)
      }
      return found
    }, rows)
  }
  return rows
}

/**
 * The repository's `ORDER BY repo_path, seq`: SQLite's BINARY collation, i.e.
 * UTF-8 byte order, then sequence. Each repo path is encoded ONCE per row, not
 * once per comparison (POD-5941).
 */
function byRepoPathThenSeq<T extends { repoPath: string; seq: number }>(rows: Iterable<T>): T[] {
  const keyed = Array.from(rows, (row) => ({ row, key: Buffer.from(row.repoPath) }))
  keyed.sort((a, b) => Buffer.compare(a.key, b.key) || a.row.seq - b.row.seq)
  return keyed.map(({ row }) => row)
}

/** Every issue row, in the repository's repo-path/sequence order. */
export async function readIssueRows(repository: IssueReadPort & Pick<IssuesRepository, 'listIssueRows'>): Promise<IssueRow[]> {
  const rows = await repository.listIssueRows()
  const map = mapOf(repository)
  if (map) compareWithIssueMap('readIssueRows', null, () => byRepoPathThenSeq(map.values()), rows)
  return rows
}

export async function readIssueParentEdges(repository: IssueReadPort & Pick<IssuesRepository, 'listIssueParentEdges'>) {
  const edges = await repository.listIssueParentEdges()
  const map = mapOf(repository)
  if (map) {
    const byId = (list: readonly { id: string; parentId: string | null }[]) =>
      [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    compareWithIssueMap('readIssueParentEdges', null, () =>
      byId([...map.values()].filter((row) => row.deletedAt == null).map(({ id, parentId }) => ({ id, parentId }))),
    byId(edges))
  }
  return edges
}
