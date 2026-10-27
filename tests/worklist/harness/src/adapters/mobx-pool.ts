/**
 * Harness helpers over the product pool's public API: the transient-reaction
 * reader the pool tests use for out-of-reaction reads, and the visible ids in
 * rank order. The product pool exposes neither.
 */
import { autorun } from 'mobx'
import type { MobxPool } from '@podium/client-graph/pool'
import { compareRank } from '@podium/client-graph/shared/row-view'
import { type Layout, worklistGroups } from '@podium/client-graph/worklist/groups'

/**
 * Run `read` inside a transient reaction and return its result, so reads made
 * outside any reaction (the harness's snapshot) are tracked reads and never
 * trip `computedRequiresReaction` / `observableRequiresReaction`.
 *
 * Only the harness reads outside a reaction.
 */
export function tracked<T>(read: () => T): T {
  let result: { value: T } | null = null
  let failure: { error: unknown } | null = null
  const stop = autorun(() => {
    try {
      result = { value: read() }
    } catch (error) {
      failure = { error }
    }
  })
  stop()
  if (failure !== null) throw (failure as { error: unknown }).error
  if (result === null)
    throw new Error('[pool] tracked() ran inside a batch; read after the action ends')
  return (result as { value: T }).value
}

function layoutIds(layout: Layout): string[] {
  return [
    ...layout.pinnedIds,
    ...layout.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
  ]
}

/**
 * The visible ids in L1b rank order, read from the group lanes (the product
 * `VisibleCollection` maintains them but exposes no copy): the layout's ids
 * sorted by each row's cached rank. What the deleted `worklist.order` read.
 * A plain read: call inside `tracked()` (or any reaction), like any other
 * observable read — it must never create its own reaction, so it stays
 * usable inside derivations.
 */
export function visibleOrderOf(pool: MobxPool): readonly string[] {
  const layout = worklistGroups(pool).layout
  const ids = layoutIds(layout)
  const ranks = new Map<string, ReturnType<ReturnType<typeof worklistGroups>['rankOf']>>()
  for (const id of ids) ranks.set(id, worklistGroups(pool).rankOf(id))
  return ids.sort((a, b) => compareRank(ranks.get(a)!, ranks.get(b)!))
}
