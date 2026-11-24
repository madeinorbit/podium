/**
 * A number that changes whenever a native list's row order changes: its groups,
 * their fold state and their row ids, in order. Fed to SwiftUI's
 * `animation(_:value:)` so one pool update (a resume catch-up, a live re-sort)
 * moves rows with the system list animation instead of jumping. Row identity
 * itself comes from React keys, which keep each native child across reorders.
 *
 * Cost: the projections keep their id/row arrays referentially stable until the
 * order changes (`@lazy({ equals: compareShallow })`), so each array is hashed
 * once and a render only combines one cached number per group.
 */
type OrderedIds = readonly (string | { readonly id: string })[]

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193
const byArray = new WeakMap<OrderedIds, number>()

function mix(hash: number, text: string): number {
  let next = hash
  for (let i = 0; i < text.length; i++) next = Math.imul(next ^ text.charCodeAt(i), FNV_PRIME)
  // A separator, so ['12'] and ['1', '2'] differ.
  return Math.imul(next ^ 0x1f, FNV_PRIME)
}

function idsHash(ids: OrderedIds): number {
  let hash = byArray.get(ids)
  if (hash !== undefined) return hash
  hash = FNV_OFFSET
  for (const id of ids) hash = mix(hash, typeof id === 'string' ? id : id.id)
  byArray.set(ids, hash)
  return hash
}

export function listOrderRevision(
  groups: readonly { key: string; folded: boolean; ids: OrderedIds }[],
): number {
  let hash = FNV_OFFSET
  for (const group of groups) {
    hash = mix(hash, group.folded ? `-${group.key}` : `+${group.key}`)
    if (!group.folded) hash = Math.imul(hash ^ idsHash(group.ids), FNV_PRIME)
  }
  return hash >>> 0
}
