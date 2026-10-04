import { reaction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { SliceIssue } from './shared/slice-types'
import type { RowSourceEvent } from './shared/source'
import { LOADING } from './worklist/rollup'

const stamp = '2026-09-01T00:00:00.000Z'
const later = '2026-09-02T00:00:00.000Z'
const cold: SliceIssue = {
  id: 'cold',
  seq: 1,
  title: 'Archived task',
  stage: 'done',
  archived: true,
  createdAt: stamp,
  updatedAt: stamp,
  readAt: stamp,
  repoPath: '/synthetic',
}

it.each([
  'pool',
  'source',
] as const)('reads cold cursors through the %s index without loading and follows their lifecycle', (owner) => {
  let index = createColdIndex(SCHEMA)
  const rows = new Map<string, SliceIssue>()
  const load = vi.fn((_kind: string, id: string) => rows.get(id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(later) }, undefined, {
    load,
    schedule: () => () => {},
    ...(owner === 'source' ? { cold: () => index } : {}),
  })
  const publish = (value: SliceIssue | undefined, type: 'replace' | 'update' = 'update') => {
    if (value === undefined) rows.delete(cold.id)
    else rows.set(cold.id, value)
    const event: RowSourceEvent = {
      type,
      rows:
        value === undefined && type === 'replace' ? [] : [{ kind: 'issue', id: cold.id, value }],
    }
    if (owner === 'source') {
      // A source can replace its index without handing cold rows to the pool.
      if (type === 'replace') index = createColdIndex(SCHEMA)
      index.apply(event)
    }
    pool.apply(owner === 'source' && type === 'replace' ? { type, rows: [] } : event)
  }
  const seen: (string | null | undefined)[] = []
  const read = vi.fn(() => pool.readCursor(cold.id))
  const stop = reaction(read, (value) => seen.push(value), { fireImmediately: true })
  try {
    expect(seen).toEqual([undefined])
    publish(cold, 'replace')
    expect(pool.readStates.has(cold.id)).toBe(false)
    expect(seen).toEqual([undefined, stamp])
    expect(pool.readCursor('absent')).toBeUndefined()

    const reads = read.mock.calls.length
    const unrelated: RowSourceEvent = {
      type: 'update',
      rows: [{ kind: 'issue', id: 'other', value: { ...cold, id: 'other', readAt: later } }],
    }
    if (owner === 'source') index.apply(unrelated)
    pool.apply(unrelated)
    expect(read).toHaveBeenCalledTimes(reads)

    publish({ ...cold, readAt: later })
    expect(seen.at(-1)).toBe(later)
    publish({ ...cold, readAt: null })
    expect(seen.at(-1)).toBeNull()
    publish(cold, 'replace')
    expect(seen.at(-1)).toBe(stamp)
    publish(undefined, 'replace')
    expect(seen.at(-1)).toBeUndefined()
    publish({ ...cold, readAt: undefined })
    expect(seen.at(-1)).toBeNull()
    publish(cold)
    expect(seen.at(-1)).toBe(stamp)
    expect(pool.tables.issue.has(cold.id)).toBe(false)
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()

    // Promotion switches to the existing cursor lane. A cursor-only update
    // still leaves the resident payload alone, and removal forgets the cursor.
    expect(pool.row('issue', cold.id)).toBe(LOADING)
    expect(pool.hydrate()).toBe(1)
    expect(load).toHaveBeenCalledExactlyOnceWith('issue', cold.id)
    const payload = pool.row('issue', cold.id)
    publish({ ...cold, readAt: later })
    expect(seen.at(-1)).toBe(later)
    expect(pool.row('issue', cold.id)).toBe(payload)
    publish(undefined)
    expect(seen.at(-1)).toBeUndefined()
  } finally {
    stop()
    pool.dispose()
  }
})
