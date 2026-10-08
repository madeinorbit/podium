// Frozen POD-5822 parity oracle; never imported by production.
import { Reaction, createAtom } from 'mobx'
import { createKeyedAnswer } from './query-result'
export function createIdentityQuery(spec: { name: string; ids(): Iterable<string> }) {
  let answer = createKeyedAnswer<string>()
  let orders = new Map<string, string>()
  let cached: string[] | undefined
  let reader: Reaction | undefined
  const atom = createAtom(spec.name, () => {}, clear)
  function refresh() {
    const next = new Map<string, string>()
    reader!.track(() => {
      for (const id of spec.ids()) if (!next.has(id)) next.set(id, String(next.size).padStart(12, '0'))
    })
    let changed = false
    for (const id of orders.keys()) if (!next.has(id)) { answer.delete(id); changed = true }
    for (const [id, order] of next) if (orders.get(id) !== order) {
      answer.set(id, order, id)
      changed = true
    }
    orders = next
    if (changed) { cached = undefined; atom.reportChanged() }
  }
  function clear() {
    reader?.dispose()
    reader = undefined
    answer = createKeyedAnswer<string>()
    orders.clear()
    cached = undefined
  }
  return {
    get(): readonly string[] {
      if (!reader) { reader = new Reaction(`${spec.name}.membership`, refresh); refresh() }
      const watched = atom.reportObserved()
      const result = cached ??= answer.snapshot()
      if (!watched) clear()
      return result
    },
    dispose: clear,
  }
}
