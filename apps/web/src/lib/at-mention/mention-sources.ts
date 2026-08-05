import type { IssueViewModel } from '@podium/client-core/react'
import type { AtOption } from './at-mention'

/**
 * WHAT THE COMPOSERS OFFER (POD-412) — the pure half of the option sources.
 *
 * Each function turns one already-held collection into ranked `AtOption` rows.
 * Nothing here fetches: issues are in the replica the client already holds, and
 * files come from `useFileMentions`, which asks the server to rank them because
 * the file list must not cross the wire (see `modules/files/path-search.ts`).
 */

/** `POD-412` — the ref the transcript already renders as a chip and an agent can
 *  resolve. An issue with neither ref cannot be inserted usefully, so it is not
 *  offered at all. */
const refOf = (issue: IssueViewModel): string | null =>
  issue.linearIdentifier?.trim() || issue.displayRef?.trim() || null

/**
 * Issues matching `query`, best first.
 *
 * BY REF AND BY TITLE, because both are how a person refers to an issue:
 * `@POD-4` is someone who knows the number, `@composer` is someone who knows
 * what it was about. A ref match outranks a title match — typing something that
 * looks like a ref is an unambiguous statement of intent.
 *
 * TIES BREAK ON THE SEQ, NOT ON RECENCY, and that is not a detail. This list is
 * re-derived whenever the issue replica changes, which on a board with live
 * agents is constantly — and `updatedAt` is exactly the field they churn. Ranked
 * by recency, the rows RE-ORDER UNDER THE KEYBOARD: a browser run of this picker
 * highlighted the third row, an agent elsewhere touched an issue, and Enter
 * inserted the second. Anything a person is aiming at with the arrow keys has to
 * hold still, so equal evidence orders by issue number, which nothing moves.
 *
 * The empty query (just `@`) is the one place recency still orders the list —
 * there is no other evidence, nothing is highlighted but the first row, and
 * "what was touched most recently" is the only useful answer to `@`.
 */
export function issueMentions(
  issues: readonly IssueViewModel[],
  query: string,
  limit: number,
): AtOption[] {
  const q = query.trim().toLowerCase()
  const scored: { issue: IssueViewModel; ref: string; score: number }[] = []
  for (const issue of issues) {
    if (issue.archived) continue
    const ref = refOf(issue)
    if (!ref) continue
    const score = q === '' ? 0 : scoreIssue(ref, issue.title ?? '', String(issue.seq ?? ''), q)
    if (score === null) continue
    scored.push({ issue, ref, score })
  }
  const tieBreak =
    q === ''
      ? (a: IssueViewModel, b: IssueViewModel) => recency(b) - recency(a)
      : (a: IssueViewModel, b: IssueViewModel) => (b.seq ?? 0) - (a.seq ?? 0)
  scored.sort((a, b) => b.score - a.score || tieBreak(a.issue, b.issue))
  return scored.slice(0, limit).map(({ issue, ref }) => ({
    kind: 'issue',
    id: `issue:${issue.id}`,
    label: ref,
    detail: issue.title ?? '',
    insert: ref,
  }))
}

function scoreIssue(ref: string, title: string, seq: string, q: string): number | null {
  const lowRef = ref.toLowerCase()
  if (lowRef.startsWith(q)) return 100
  // A bare number is a ref too — `@412` is how half of everyone types it.
  if (/^\d+$/.test(q) && seq.startsWith(q)) return 90
  if (lowRef.includes(q)) return 70
  const lowTitle = title.toLowerCase()
  if (lowTitle.startsWith(q)) return 60
  // A word start inside the title beats a match buried mid-word: "comp" should
  // find "Composer context picker" before "Recompute the sheet width".
  if (new RegExp(`\\b${escapeRegExp(q)}`).test(lowTitle)) return 50
  if (lowTitle.includes(q)) return 30
  return null
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const recency = (issue: IssueViewModel): number => {
  const at = Date.parse(issue.updatedAt ?? '')
  return Number.isNaN(at) ? 0 : at
}

/**
 * Repo-relative paths as mention rows.
 *
 * The path is inserted INSIDE BACKTICKS: a code span is exactly how the
 * transcript recognises a path and turns it into a clickable file chip
 * (`linkifyCodePaths`), so a mention the user picks comes back as a chip in
 * their own message — the same closing-of-the-loop the issue refs get for free.
 * An agent reads it as the plain path it is.
 */
export function fileMentions(paths: readonly string[]): AtOption[] {
  return paths.map((path) => {
    const cut = path.lastIndexOf('/')
    return {
      kind: 'file',
      id: `file:${path}`,
      label: cut === -1 ? path : path.slice(cut + 1),
      detail: cut === -1 ? '' : path.slice(0, cut),
      insert: `\`${path}\``,
    }
  })
}
