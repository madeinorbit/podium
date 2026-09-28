/**
 * POD-4715 — the rescope grown state's true visible rows.
 *
 * The fixture oracle over the grown corpus: every rescope record must hold
 * exactly this many grown rows (the floor draws its frozen boot snapshot by
 * design, so it holds the 1x truth instead). Split out of
 * `harness/browser/run.ts` so the gate is unit-testable without launching a
 * browser (run.ts self-executes on import).
 */
import { FIXTURE_SEED } from '../../shared/src/scenarios'
import { buildCorpus } from '../src/fixture/index'
import { expectedSnapshot } from '../src/oracle/index'

const truthRowsByScale = new Map<number, number>()

/** True visible rows at `scale`, computed once per process. */
export function truthRows(scale: 1 | 2 | 4): number {
  const hit = truthRowsByScale.get(scale)
  if (hit !== undefined) return hit
  const corpus = buildCorpus(scale, FIXTURE_SEED)
  const rows = Object.keys(
    expectedSnapshot(corpus, { selectedIssueId: null, coarseNow: corpus.fixedNow }).rowsById,
  ).length
  truthRowsByScale.set(scale, rows)
  return rows
}
