import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { loadSyncedModels } from './models'
import { requireHere } from './lookup'
import { LOADING } from './loading'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'

it('rows arrive before deferred definitions, then every waiting view gets the same live model', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const examples = [
    ['machine', 'host', 'name', { id: 'host', name: 'Original host' }],
    ['automation', 'schedule', 'name', { id: 'schedule', name: 'Original schedule' }],
    ['automationRun', 'fire', 'outcome', { id: 'fire', outcome: 'launched' }],
  ] as const
  const records = examples.map(([kind, id, , value]) => ({ kind, id, value })) as RowRecord[]
  pool.apply({ type: 'replace', rows: records })
  const views = examples.map(([kind, id, field]) => {
    const first: unknown[] = [], second: unknown[] = []
    const watch = (answers: unknown[]) => autorun(() => {
      const model = pool.model(kind, id)
      answers.push(model === LOADING ? LOADING : Reflect.get(requireHere(model), field))
    })
    return { first, second, stops: [watch(first), watch(second)] }
  })
  try {
    for (const view of views) {
      expect(view.first).toEqual([LOADING])
      expect(view.second).toEqual([LOADING])
    }
    // The input rows already belong to the generic tables before a model read.
    for (const record of records) expect(pool.row(record.kind, record.id)).toBe(record.value)
    await loadSyncedModels()
    for (const [index, [kind, id, field, row]] of examples.entries()) {
      const model = requireHere(pool.model(kind, id))
      expect(Reflect.get(model, field)).toBe(Reflect.get(row, field))
      expect(pool.model(kind, id)).toBe(model)
      expect(views[index]!.first).toEqual([LOADING, Reflect.get(row, field)])
      expect(views[index]!.second).toEqual(views[index]!.first)
      const value = { ...row, [field]: kind === 'automationRun' ? 'failed' : 'Renamed' }
      pool.apply({ type: 'update', rows: [{ kind, id, value } as RowRecord] })
      expect(pool.model(kind, id)).toBe(model)
      expect(views[index]!.first.at(-1)).toBe(Reflect.get(value, field))
      expect(views[index]!.second).toEqual(views[index]!.first)
    }
  } finally {
    for (const view of views) for (const stop of view.stops) stop()
    pool.dispose()
  }
})
