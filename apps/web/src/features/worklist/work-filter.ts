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

/** The query as the filter uses it — trimmed and lowercased; empty means off. */
export function normalizeWorkQuery(query: string): string {
  return query.trim().toLowerCase()
}
