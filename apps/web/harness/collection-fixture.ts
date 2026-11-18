/** The corpus behind the generic collection route, not only its first download.
 * Uses the production declarations/evaluator. No per-screen routing rules. */
import { COLLECTIONS, clausesOf, isParam, matchesWhere, recordOf } from '@podium/model'
import { instanceKey } from '../../../packages/sync/src/replica/cache-state'
import {
  comesWithOf,
  resolveInstance,
  stubOfValue,
} from '../../../packages/sync/src/replica/holdings'
import type { InstanceSpec } from '../../../packages/sync/src/replica/types'
import type { WireRow } from './policy-rows'

export function collectionFixture(rows: readonly WireRow[], now: number, recentDays: number) {
  const tables = new Map<string, Map<string, WireRow>>()
  for (const row of rows) {
    let table = tables.get(row.entity)
    if (!table) {
      table = new Map()
      tables.set(row.entity, table)
    }
    table.set(row.entityId, row)
  }
  const fields = new Map<string, Map<string, Map<unknown, WireRow[]>>>()
  const index = (kind: string, field: string) => {
    let kindFields = fields.get(kind)
    if (!kindFields) {
      kindFields = new Map()
      fields.set(kind, kindFields)
    }
    let values = kindFields.get(field)
    if (!values) {
      values = new Map()
      for (const row of tables.get(kind)?.values() ?? []) {
        const value = row.value[field]
        const bucket = values.get(value) ?? []
        bucket.push(row)
        values.set(value, bucket)
      }
      kindFields.set(field, values)
    }
    return values
  }
  // Build fixture indexes before navigation. Otherwise a keyed fixture fetch
  // would scan all history while the real SQL route seeks an index.
  for (const definition of COLLECTIONS.values())
    if (definition.where)
      for (const clause of clausesOf(definition.where))
        for (const [field, test] of Object.entries(clause))
          if (!field.includes('.') && test && typeof test === 'object' && 'eq' in test)
            index(definition.of, field)
  const lists = new Map([...tables].map(([kind, table]) => [kind, [...table.values()]]))
  const select = (request: InstanceSpec & { after?: readonly unknown[] }) => {
    const definition = COLLECTIONS.get(request.collection)
    const spec = { ...request, part: request.part ?? definition?.part ?? 'main' }
    const resolved = resolveInstance(spec, { recentDays })
    if (!resolved) throw new Error(`Unknown fixture collection ${spec.collection}`)
    const table = tables.get(resolved.of) ?? new Map<string, WireRow>()
    const declaration = recordOf(resolved.of)
    if (!declaration) throw new Error(`Unknown fixture record ${resolved.of}`)
    let candidates = lists.get(resolved.of) ?? []
    if (resolved.where) {
      const union = new Map<string, WireRow>()
      for (const clause of clausesOf(resolved.where)) {
        let subset = candidates
        for (const [field, test] of Object.entries(clause)) {
          if (field.includes('.') || !test || typeof test !== 'object' || !('eq' in test)) continue
          const expected = isParam(test.eq) ? resolved.args[test.eq.param] : test.eq
          if (expected === undefined || expected === null || typeof expected === 'object') continue
          const bucket = index(resolved.of, field).get(expected) ?? []
          if (bucket.length < subset.length) subset = bucket
        }
        for (const row of subset) union.set(row.entityId, row)
      }
      candidates = [...union.values()]
    }
    let members = candidates.filter(
      (row) =>
        !resolved.where ||
        matchesWhere(resolved.where, row.value, {
          now,
          args: resolved.args,
          idOf: (value) => value[declaration.key as string] as string,
          parentOf: (id) =>
            table.get(id)?.value[declaration.parentLink ?? 'parentId'] as string | null | undefined,
        }),
    )
    const total = members.length
    const page = definition?.page
    let range: { end: boolean; through?: unknown[] } | undefined
    if (page) {
      const compare = (a: readonly unknown[], b: readonly unknown[]) => {
        for (const [index, sort] of page.sort.entries()) {
          const av = a[index],
            bv = b[index]
          if (av === bv) continue
          if (av == null) return 1
          if (bv == null) return -1
          const order = (av as string | number) < (bv as string | number) ? -1 : 1
          return sort.direction === 'asc' ? order : -order
        }
        return 0
      }
      const key = (row: WireRow) => page.sort.map((sort) => row.value[sort.field] ?? null)
      members.sort((a, b) => compare(key(a), key(b)))
      const after = request.after
      if (after) members = members.filter((row) => compare(key(row), after) > 0)
      const end = members.length <= page.size
      members = members.slice(0, page.size)
      const last = members.at(-1)
      range = { end, ...(last ? { through: key(last) } : {}) }
    }
    return {
      rows: members.map((row) =>
        spec.part === 'stub' ? { ...row, value: stubOfValue(row.entity, row.value) } : row,
      ),
      marker: { ...spec, ...(page ? { range, total } : {}) },
    }
  }
  const answers = new Map<
    string,
    {
      rows: (WireRow & { part?: 'stub' })[]
      markers: ReturnType<typeof select>['marker'][]
      events: {
        root: string
        rows: (WireRow & { part?: 'stub' })[]
        markers: ReturnType<typeof select>['marker'][]
      }[]
    }
  >()
  const close = (requests: readonly InstanceSpec[]) => {
    const answerKey = JSON.stringify(requests)
    const cached = answers.get(answerKey)
    if (cached) return cached
    const visited = new Set<string>()
    const whole = new Set<string>(),
      stubbed = new Set<string>()
    const selected = new Map<string, WireRow & { part?: 'stub' }>()
    const markers: ReturnType<typeof select>['marker'][] = []
    const events: {
      root: string
      rows: (WireRow & { part?: 'stub' })[]
      markers: typeof markers
    }[] = []
    // As on the server: each primary instance, then its related records,
    // before the next primary. Related markers are batched (up to 1,000),
    // rather than manufacturing one storage transaction per related row.
    for (const root of requests) {
      let groups = [[root]]
      for (let round = 0; groups.length; round++) {
        if (round > 64) throw new Error('Fixture companion closure did not settle')
        const next = new Map<string, InstanceSpec[]>()
        for (const group of groups) {
          const fresh: (WireRow & { part?: 'stub' })[] = [],
            complete: typeof markers = []
          for (const request of group) {
            const key = instanceKey(request)
            if (visited.has(key)) continue
            visited.add(key)
            const answer = select(request)
            const resolved = resolveInstance(
              { ...request, part: answer.marker.part },
              { recentDays },
            )
            if (!resolved) throw new Error('Undeclared fixture instance')
            markers.push(answer.marker)
            complete.push(answer.marker)
            for (const row of answer.rows) {
              const address = `${row.entity}\0${row.entityId}`
              const stub = answer.marker.part === 'stub'
              const part = { ...row, ...(stub ? { part: 'stub' as const } : {}) }
              const prior = selected.get(address)
              if (!prior || prior.part === 'stub') selected.set(address, part)
              if (stub ? !whole.has(address) && !stubbed.has(address) : !whole.has(address))
                fresh.push(part)
              if (stub) stubbed.add(address)
              else whole.add(address)
              if (!stub)
                for (const spec of comesWithOf(row.entity, row.value, [resolved], now)) {
                  const batch = `${spec.via ?? ''}>${spec.collection}:${spec.part}`
                  const list = next.get(batch) ?? []
                  list.push(spec)
                  next.set(batch, list)
                }
            }
          }
          if (fresh.length || complete.length)
            events.push({ root: instanceKey(root), rows: fresh, markers: complete })
        }
        groups = [...next.values()]
      }
    }
    const answer = { rows: [...selected.values()], markers, events }
    answers.set(answerKey, answer)
    return answer
  }
  const validate = (answer: ReturnType<typeof close>) => {
    const stored = new Map(answer.rows.map((row) => [`${row.entity}\0${row.entityId}`, row]))
    for (const marker of answer.markers)
      for (const row of select(marker).rows) {
        const resident = stored.get(`${row.entity}\0${row.entityId}`)
        if (!resident || (marker.part !== 'stub' && resident.part === 'stub'))
          throw new Error(
            `False fixture marker: ${marker.collection} lacks ${row.entity}:${row.entityId}`,
          )
      }
  }
  return Object.assign(select, { close, validate })
}
