import { compareRank, rankOf, type RowView } from '@podium/client-graph/shared/row-view'

/** Sorting convenience used by the retained parity harness. */
export function compareRows(a: RowView, b: RowView): number {
  return compareRank(rankOf(a), rankOf(b))
}
