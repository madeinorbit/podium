import type { MachineWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { machineViewsFromWire } from './authority'

const machine = (id: string, use?: 'granted' | 'denied'): MachineWire => ({
  id: id as MachineWire['id'],
  name: id,
  hostname: `${id}.test`,
  online: true,
  lastSeenAt: '2026-08-03T00:00:00.000Z',
  ...(use === undefined ? {} : { use }),
})

describe('machineViewsFromWire — optional use is evaluated per list', () => {
  it('keeps an omitted peer usable in an unscoped list', () => {
    const views = machineViewsFromWire([machine('single')])
    expect(views[0]?.grants.use).toBe(true)
    expect(views[0]?.availability).toBe('available')
  })

  it('denies omitted peers once any visible machine is explicitly scoped', () => {
    const views = machineViewsFromWire([
      machine('granted', 'granted'),
      machine('omitted'),
      machine('denied', 'denied'),
    ])
    expect(views.map((view) => [view.machine.id, view.availability])).toEqual([
      ['granted', 'available'],
      ['omitted', 'unauthorized'],
      ['denied', 'unauthorized'],
    ])
  })
})
