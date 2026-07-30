/** Prev/next neighbors of `id` within a flat, visually-ordered id list — the
 *  basis for the issue page's up/down navigation. Missing ends (or an absent id)
 *  simply omit that key, so the header can disable the button. */
import type { IssueId } from '@podium/model'

export function issueNeighbors(
  orderedIds: IssueId[],
  id: IssueId,
): { prev?: IssueId; next?: IssueId } {
  const i = orderedIds.indexOf(id)
  if (i < 0) return {}
  return {
    ...(i > 0 ? { prev: orderedIds[i - 1] } : {}),
    ...(i < orderedIds.length - 1 ? { next: orderedIds[i + 1] } : {}),
  }
}
