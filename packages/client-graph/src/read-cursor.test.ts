import { reaction } from 'mobx'
import { expect, it } from 'vitest'
import { omitGone } from './lookup'
import { MobxPool } from './pool'
import type { SliceIssue } from './shared/slice-types'

const stamp = '2026-09-01T00:00:00.000Z'
const later = '2026-09-02T00:00:00.000Z'
const task: SliceIssue = {
  id: 'task',
  seq: 1,
  title: 'Archived task',
  stage: 'done',
  archived: true,
  createdAt: stamp,
  updatedAt: stamp,
  readAt: stamp,
  repoPath: '/synthetic',
}

it('reads a held issue cursor from the read-state lane and follows its lifecycle', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(later) })
  const publish = (value: SliceIssue | undefined, type: 'replace' | 'update' = 'update') =>
    pool.apply({
      type,
      rows:
        value === undefined && type === 'replace' ? [] : [{ kind: 'issue', id: task.id, value }],
    })
  const seen: (string | null | undefined)[] = []
  const stop = reaction(
    () => pool.readCursor(task.id),
    (value) => seen.push(value),
    { fireImmediately: true },
  )
  try {
    expect(seen).toEqual([undefined])
    publish(task, 'replace')
    expect(seen).toEqual([undefined, stamp])
    expect(pool.readCursor('absent')).toBeUndefined()
    // A cursor-only update moves the lane and leaves the payload alone.
    const payload = omitGone(pool.row('issue', task.id))
    publish({ ...task, readAt: later })
    expect(seen.at(-1)).toBe(later)
    expect(omitGone(pool.row('issue', task.id))).toBe(payload)
    publish({ ...task, readAt: null })
    expect(seen.at(-1)).toBeNull()
    publish(task, 'replace')
    expect(seen.at(-1)).toBe(stamp)
    // Removal forgets the cursor.
    publish(undefined)
    expect(seen.at(-1)).toBeUndefined()
  } finally {
    stop()
    pool.dispose()
  }
})
