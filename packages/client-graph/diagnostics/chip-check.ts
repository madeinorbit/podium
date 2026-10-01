/** Optional differential, following sidebar-check's privacy contract. Only
 * counts, positions, field names and opaque ids leave the comparison. */
import { canonicalIssueRef, issueReferenceModel, type IssueReferenceModel, type IssueReferenceSource } from '@podium/client-core/viewmodels'
import { compareStructural } from 'mobx'
import { issueRefKey, type IssueReferenceReader } from '../src/issue-reference'
import { LOADING } from '../src/worklist/rollup'

export interface ChipDifference {
  readonly chipIndex: number
  readonly expectedId: string | null
  readonly actualId: string | null
  readonly field: keyof IssueReferenceModel
}
export interface ChipCheckResult {
  readonly chips: number
  readonly pending: number
  readonly differences: number
  readonly first: ChipDifference | null
}
const FIELDS = ['ref', 'issueId', 'title', 'stage', 'availability', 'accessibleLabel'] as const

export function checkIssueChips(
  reader: IssueReferenceReader,
  legacy: readonly IssueReferenceSource[],
  tokens: readonly string[],
): ChipCheckResult {
  // This whole-list work exists ONLY in the explicit diagnostic. Neither the
  // production reader nor its counters invoke the legacy projection.
  const expected = new Map(legacy.map(row => [issueRefKey(canonicalIssueRef(row)), issueReferenceModel(row)]))
  let pending = 0, differences = 0
  let first: ChipDifference | null = null
  for (let chipIndex = 0; chipIndex < tokens.length; chipIndex++) {
    const token = tokens[chipIndex]!
    const a = reader.read(token)
    if (a === LOADING) { pending++; continue }
    const e = expected.get(issueRefKey(token)) ?? null
    for (const field of FIELDS) {
      if (compareStructural(e?.[field] ?? null, a?.[field] ?? null)) continue
      differences++
      first ??= { chipIndex, expectedId: e?.issueId ?? null, actualId: a?.issueId ?? null, field }
    }
  }
  return { chips: tokens.length, pending, differences, first }
}
