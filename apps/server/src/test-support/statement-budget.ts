/** Query-attribution deltas for one isolated operation. Run the test process at
 * PODIUM_LOOP_PROFILE=attribution; absence of instrumentation is not zero cost.
 * No reset: independent evidence collected before this operation is preserved.
 */
import {
  queryAttributionEnabled,
  queryAttributionSnapshot,
} from '@podium/runtime/query-attribution'

export async function statementBudget<T>(fn: () => T | Promise<T>): Promise<{
  result: T
  statements: number
  byQuery: ReadonlyMap<string, number>
}> {
  if (!queryAttributionEnabled)
    throw new Error('statementBudget requires PODIUM_LOOP_PROFILE=attribution before module import')
  // Snapshot values are mutable counter objects; copy the counts themselves.
  const before = new Map([...queryAttributionSnapshot()].map(([sql, cost]) => [sql, cost.count]))
  const result = await fn()
  const byQuery = new Map<string, number>()
  for (const [sql, cost] of queryAttributionSnapshot()) {
    const count = cost.count - (before.get(sql) ?? 0)
    if (count < 0) throw new Error('query attribution reset during statementBudget')
    if (count > 0) byQuery.set(sql, count)
  }
  return {
    result,
    statements: [...byQuery.values()].reduce((sum, count) => sum + count, 0),
    byQuery,
  }
}
