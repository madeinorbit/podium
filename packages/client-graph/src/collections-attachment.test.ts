import { autorun } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { fullDevice } from './full-device-fixture'
import { LOADING } from './loading'
import { NOT_VISIBLE } from './lookup'
import { MobxPool } from './pool'
import type { CollectionLoaderPort, LoaderInstance } from './shared/source'

/** The source may be attached after the pool's first render (see PoolCollections.attach). */
function loader(complete: boolean): CollectionLoaderPort {
  const rows = [
    {
      id: 'i-1',
      stub: { id: 'i-1', repoId: 'r-1', seq: 1, stage: 'in_progress', deletedAt: null },
    },
    { id: 'i-2', stub: { id: 'i-2', repoId: 'r-1', seq: 2, stage: 'review', deletedAt: null } },
  ]
  return {
    request: vi.fn(),
    show: vi.fn(() => () => {}),
    status: () => (complete ? 'complete' : 'loading'),
    online: true,
    firstDownload: false,
    isComplete: () => (complete ? {} : undefined),
    wasRefused: () => false,
    stubOf: (_entity, id) => rows.find((row) => row.id === id)?.stub,
    stubsByParent: () => [],
    stubRows: () => rows,
    subscribe: () => () => {},
  }
}

describe('a collection source attached after the first render', () => {
  it('replaces the resident issue count with the device-wide count', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const device = loader(true)
    const seen: unknown[] = []
    const stop = autorun(() => seen.push(pool.undeletedIssueCount))
    try {
      expect(seen).toEqual([0])
      pool.collections.attach(() => device)
      expect(seen.at(-1)).toBe(2)
    } finally {
      stop()
      pool.dispose()
    }
  })

  it('revisits a missing record and starts its load', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const device = loader(false)
    const seen: unknown[] = []
    const stop = autorun(() => seen.push(pool.row('issue', 'i-1')))
    try {
      expect(seen).toEqual([NOT_VISIBLE])
      pool.collections.attach(() => device)
      expect(seen.at(-1)).toBe(LOADING)
      expect(device.request).toHaveBeenCalledWith(
        [{ collection: 'issueProjection.one', args: { id: 'i-1' }, part: 'main' }],
        'visible',
      )
    } finally {
      stop()
      pool.dispose()
    }
  })

  it('rechecks an explicitly full fixture collection against the attached device', () => {
    const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: 0 }))
    const device = loader(false)
    const spec: LoaderInstance = { collection: 'issueProjection.sidebar', part: 'main' }
    const seen: boolean[] = []
    const stop = autorun(() => seen.push(pool.collections.held(spec)))
    try {
      expect(seen).toEqual([true])
      pool.collections.attach(() => device)
      expect(seen.at(-1)).toBe(false)
      expect(pool.collections.treeHeld('i-1')).toBe(false)
      expect(pool.collections.status(spec)).toBe('loading')
      expect(() => fullDevice(pool)).toThrow('without a loader')
      expect(device.request).toHaveBeenCalledWith([spec], 'visible')
      pool.collections.attach(() => undefined)
      expect(pool.collections.held(spec)).toBe(false)
      expect(pool.collections.status(spec)).toBe('loading')
    } finally {
      stop()
      pool.dispose()
    }
  })

  it('refreshes an empty reference lookup when the attached device has its stubs', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const device = loader(true)
    const seen: (string | undefined)[] = []
    const stop = autorun(() => seen.push(pool.collections.stubIdAt('r-1', 1)))
    try {
      expect(seen).toEqual([undefined])
      pool.collections.attach(() => device)
      expect(seen.at(-1)).toBe('i-1')
    } finally {
      stop()
      pool.dispose()
    }
  })
})
