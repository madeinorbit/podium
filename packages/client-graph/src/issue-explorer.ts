import { keyedComputed } from '@podium/mobx-helpers'
import { observe } from 'mobx'
import type { BoardQuery } from './issue-board-schema'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { LOADING, type Loaded } from './worklist/rollup'

/** Explorer membership and recency are scalar answers, independent of card
 * payloads. The existing ordered-query primitive publishes an ID snapshot
 * by changed key; the virtual window decides which cards to demand. */
export function createIssueExplorer(
  pool: MobxPool,
  matches: (id: string, query: BoardQuery) => Loaded<boolean>,
) {
  const eligible = keyedComputed('IssueExplorer.eligible', (key: string) => {
    const [id, query] = JSON.parse(key) as [string, BoardQuery]
    return matches(id, query)
  })
  const recency = keyedComputed('IssueExplorer.recency', (id: string) => {
    const row = pool.row('issue', id, 'summary-fields') as Loaded<{ updatedAt?: string }>
    return row && row !== LOADING ? row.updatedAt ?? '' : ''
  })
  const results = new Map<string, ReturnType<typeof createQueryResult<string>>>()
  const ids = keyedComputed('IssueExplorer.ids', (key: string): Loaded<string[]> => {
    const [query, ordered] = JSON.parse(key) as [BoardQuery, boolean]
    const question = { kind: 'boardIssues' as const, explorerTab: query.tab ?? '',
      searching: !!query.query?.trim() }
    let result = results.get(key)
    if (!result) {
      result = createQueryResult({
        name: `IssueExplorer.result:${key}`,
        // createQueryResult owns the untracked membership seed. Per-row
        // eligibility below supplies the ordinary tracked dependencies.
        ids: () => pool.queries.ids(question),
        has: id => pool.queries.has(question, id),
        read: id => {
          const value = eligible(JSON.stringify([id, query]))
          return value === LOADING ? LOADING : value ? id : undefined
        },
        order: ordered ? id => {
          // Canonical ISO dates sort newest first by reversing their scalar
          // characters. Equal dates retain the old query's ID tie order.
          let reversed = ''
          for (const character of recency(id))
            reversed += String.fromCharCode(0xffff - character.charCodeAt(0))
          return reversed + '\uffff'
        } : undefined,
        subscribe: changed => {
          const stopTable = observe(pool.tables.issue, change => changed(change.name))
          const stopFeed = pool.queries.onChange(event => {
            if (event.type === 'replace') changed(undefined)
            else for (const row of event.rows) if (row.kind === 'issue') changed(row.id)
          })
          return () => { stopTable(); stopFeed() }
        },
        released: () => results.delete(key),
      })
      results.set(key, result)
    }
    return result.get()
  })
  return {
    ids: (query: BoardQuery, ordered = false) => ids(JSON.stringify([query, ordered])),
    stats: () => ({ demandKeys: results.size, cached: ids.size + eligible.size + recency.size }),
    dispose() {
      for (const result of [...results.values()]) result.dispose()
      results.clear()
      for (const cache of [ids, eligible, recency]) cache.clear()
    },
  }
}
