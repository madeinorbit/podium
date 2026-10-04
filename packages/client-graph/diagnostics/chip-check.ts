import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
/** Optional differential, following sidebar-check's privacy contract. Only
 * counts, positions, field names and opaque ids leave the comparison. */

import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import { reportChipCheck } from '@podium/client-core/perf'

import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import {
  canonicalIssueRef,
  type IssueReferenceModel,
  type IssueReferenceSource,
  issueReferenceModel,
} from '@podium/client-core/values'
import { compareStructural, runInAction } from 'mobx'
import { type IssueReferenceReader, issueRefKey } from '../src/issue-reference'
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
  return runInAction(() => {
    // This whole-list work exists ONLY in the explicit diagnostic. Neither the
    // production reader nor its counters invoke the legacy projection.
    const expected = new Map(
      legacy.map((row) => [issueRefKey(canonicalIssueRef(row)), issueReferenceModel(row)]),
    )
    let pending = 0,
      differences = 0
    let first: ChipDifference | null = null
    for (let chipIndex = 0; chipIndex < tokens.length; chipIndex++) {
      const token = tokens[chipIndex]!
      const a = reader.read(token)
      if (a === LOADING) {
        pending++
        continue
      }
      const e = expected.get(issueRefKey(token)) ?? null
      for (const field of FIELDS) {
        if (compareStructural(e?.[field] ?? null, a?.[field] ?? null)) continue
        differences++
        first ??= { chipIndex, expectedId: e?.issueId ?? null, actualId: a?.issueId ?? null, field }
      }
    }
    return { chips: tokens.length, pending, differences, first }
  })
}

/** Startup opt-in only. Comparison runs outside mount/render and retains no
 * values; it is separate from the normal per-chip read and redraw census. */
export function startChipCheck(
  runtime: { readonly access: Store<PodiumClientApi> },
  reader: IssueReferenceReader,
  tokens: () => readonly string[],
  intervalMs = 5000,
): () => void {
  let disposed = false,
    checks = 0
  const idle = { checks: 0, chips: 0, pending: 0, differences: 0, first: null }
  reportChipCheck(runtime, { state: 'waiting', ...idle })
  const tick = (): void => {
    if (disposed) return
    try {
      const store = referenceState(runtime)
      const result = checkIssueChips(
        reader,
        allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates),
        tokens(),
      )
      checks++
      reportChipCheck(runtime, {
        state: result.pending ? 'waiting' : result.differences ? 'different' : 'match',
        checks,
        ...result,
      })
    } catch {
      reportChipCheck(runtime, { state: 'error', ...idle, checks })
    }
    if (!disposed) timer = setTimeout(tick, intervalMs)
  }
  let timer = setTimeout(tick, intervalMs)
  return () => {
    disposed = true
    clearTimeout(timer)
    reportChipCheck(runtime, { state: 'off', ...idle })
  }
}
