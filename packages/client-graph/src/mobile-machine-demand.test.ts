import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { sessionPaneView } from './session-pane'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { createMobileSessionReader } from './mobile-session-context'
import { MobxPool } from './pool'
import { createPoolProjection } from './runtime-pool'

it('reads only the conversation machine and keeps first demand and updates flat at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const machine = (id: string, online = true) => ({ kind: 'machine' as const, id, value: {
      id, online, name: id, hostname: id, lastSeenAt: '2020-01-01',
      availability: { epoch: 'one', server: false, daemon: online, supervisor: true },
    } as never })
    headerEntities(pool).apply([machine('target'), ...Array.from({ length: 128 * scale }, (_, n) => machine(`foreign-${n}`))])
    const reader = createMobileSessionReader(pool), row = vi.spyOn(pool, 'row')
    const ids = vi.spyOn(headerView(pool), 'ids'), list = vi.spyOn(sessionPaneView(pool), 'machines')
    const view = createPoolProjection(pool, () => reader.machine('target')), paint = vi.fn()
    const measure = (name: string, action: () => void) => measureWork(async () => insideReader(name, action), { pool })
    let stop = () => {}
    try {
      expect(row).not.toHaveBeenCalled()
      const absent = await measure('phone machine undefined', () => expect(reader.machine(undefined)).toBeUndefined())
      expect(row).not.toHaveBeenCalled()
      const first = await measure('phone machine first demand', () => {
        expect(view.getSnapshot()).toMatchObject({ id: 'target', online: true })
        stop = view.subscribe(paint)
      })
      expect(row.mock.calls).toEqual([['machine', 'target']])
      row.mockClear()
      const unrelated = await measure('phone unrelated machine', () => headerEntities(pool).apply([machine('foreign-0', false)]))
      expect(row).not.toHaveBeenCalled(); expect(paint).not.toHaveBeenCalled()
      const target = await measure('phone target machine offline', () => headerEntities(pool).apply([machine('target', false)]))
      expect(row.mock.calls).toEqual([['machine', 'target']])
      expect(view.getSnapshot()).toMatchObject({ online: false })
      expect(paint).toHaveBeenCalledTimes(1)
      const removed = await measure('phone target machine removed', () => headerEntities(pool).apply([{ kind: 'machine', id: 'target', value: undefined }]))
      expect(view.getSnapshot()).toBeUndefined()
      expect(paint).toHaveBeenCalledTimes(2)
      stop(); row.mockClear(); paint.mockClear()
      const closed = await measure('phone removed conversation', () => headerEntities(pool).apply([machine('target')]))
      expect(row).not.toHaveBeenCalled(); expect(paint).not.toHaveBeenCalled()
      expect(ids).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled()
      return Object.fromEntries(Object.entries({ absent, first, unrelated, target, removed, closed }).map(([name, value]) => [name, value.work]))
    } finally { stop(); row.mockRestore(); ids.mockRestore(); list.mockRestore(); pool.dispose() }
  }
  const first = await measured(1), second = await measured(4)
  console.info('phone named machine work1x4x', JSON.stringify({ first, second }))
  for (const action of Object.keys(first)) for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
    expect(second[action]?.[counter]).toBe(first[action]?.[counter])
})
