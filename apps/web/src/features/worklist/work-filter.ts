/**
 * THE COLUMN'S INLINE FILTER (POD-1078, the 3b sidebar).
 *
 * One question, asked of the list you are already looking at: which of these
 * thirty rows is the one I mean. It is deliberately NOT the command palette —
 * ⌘K searches the whole product and takes the screen to do it; this narrows the
 * column in place and leaves everything else where it was.
 *
 * WHAT A ROW ANSWERS TO. The design filters on `title + id + meta`, so a row is
 * findable by every string it actually SHOWS: the words in its title, the number
 * in its gutter, and the status phrase on line 2 (`waiting`, `needs review`,
 * `merged`). That last one is what makes the field a triage tool rather than a
 * name lookup — `waiting` collapses the column to the rows that are asking. The
 * full ref (`POD-844`) matches as well as the bare digits, because that is the
 * form a person pastes in from somewhere else.
 *
 * Matching is CASE-INSENSITIVE SUBSTRING, not fuzzy: the operator is looking at
 * the rows while they type, so every keystroke has to remove rows they can see
 * are wrong. A fuzzy match keeps surprises in the list and makes an empty result
 * hard to trust.
 */
import { rowStatusLine, type UnifiedWorkRow } from '@podium/client-core/viewmodels'
import { issueDisplayRef } from '@podium/protocol'

/** Everything about a row a query may match, lowercased into one string. */
function rowHaystack(row: UnifiedWorkRow, now: number): string {
  if (row.kind !== 'issue') {
    // A worktree row is a roster band, not a task: what identifies it is the
    // repo and the branch it says on its face.
    const { repoName, branch, path } = row.worktree
    return `${repoName} ${branch ?? ''} ${path}`.toLowerCase()
  }
  const { issue } = row
  return [issue.title, String(issue.seq), issueDisplayRef(issue), rowStatusLine(row, now)]
    .join(' ')
    .toLowerCase()
}

/** The query as the filter uses it — trimmed and lowercased; empty means off. */
export function normalizeWorkQuery(query: string): string {
  return query.trim().toLowerCase()
}

/**
 * Search text is the expensive half of matching: issue rows derive their live
 * status line from the row and the shared clock. Build it once for a published
 * row set, then reuse it for every query until either the rows or clock change.
 */
export function indexWorkRows(
  rows: readonly UnifiedWorkRow[],
  now: number,
): ReadonlyMap<UnifiedWorkRow, string> {
  return new Map(rows.map((row) => [row, rowHaystack(row, now)]))
}

/** Match a query that the caller already normalized against a memoized index. */
export function matchesIndexedWorkQuery(
  index: ReadonlyMap<UnifiedWorkRow, string>,
  row: UnifiedWorkRow,
  normalizedQuery: string,
): boolean {
  return !normalizedQuery || (index.get(row) ?? '').includes(normalizedQuery)
}

/** Does this row survive `query`? An empty query keeps every row, so callers can
 *  run the predicate unconditionally rather than branching at each call site. */
export function matchesWorkQuery(row: UnifiedWorkRow, query: string, now: number): boolean {
  const needle = normalizeWorkQuery(query)
  if (!needle) return true
  return rowHaystack(row, now).includes(needle)
}
