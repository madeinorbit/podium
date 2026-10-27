import { describe, expect, it } from 'vitest'
import { type RowVoiceInput, rowVoice } from './pool-row-data'
import { placeInFullOrder } from './work-folders'

describe('placeInFullOrder (POD-2074 folder reorder)', () => {
  it('moves a project within the full order when every project is on screen', () => {
    expect(placeInFullOrder(['a', 'b', 'c'], ['b', 'a', 'c'], 'a')).toEqual(['b', 'a', 'c'])
    expect(placeInFullOrder(['a', 'b', 'c'], ['a', 'c', 'b'], 'b')).toEqual(['a', 'c', 'b'])
  })

  it('keeps projects that are not on screen in their places', () => {
    // Closed lane shows only a and c: c lands right before a; b and d keep order.
    expect(placeInFullOrder(['a', 'b', 'c', 'd'], ['c', 'a'], 'c')).toEqual(['c', 'a', 'b', 'd'])
    // Dropped last among the visible ones: lands right after the previous one.
    expect(placeInFullOrder(['a', 'b', 'c', 'd'], ['c', 'a'], 'a')).toEqual(['b', 'c', 'a', 'd'])
  })
})

const base: RowVoiceInput = {
  decision: null,
  phase: 'queued',
  working: false,
  showsChildProgress: false,
  progress: null,
  issue: { stage: 'in_progress', closedReason: null } as unknown as RowVoiceInput['issue'],
}

describe('rowVoice (POD-2074 status map)', () => {
  it('reserves bronze for what needs you and blue for working', () => {
    expect(rowVoice({ ...base, decision: 'review' })).toMatchObject({
      tone: 'needs',
      word: 'Needs review',
    })
    expect(rowVoice({ ...base, phase: 'waiting' })).toMatchObject({
      tone: 'needs',
      word: 'Waiting on you',
    })
    expect(rowVoice({ ...base, working: true, phase: 'working' })).toMatchObject({
      tone: 'working',
      word: 'Working',
    })
    expect(rowVoice(base)).toMatchObject({ tone: 'active', word: 'In progress' })
  })

  it('tallies two or more subtasks and settles a finished set', () => {
    const progress = { done: 3, total: 7 }
    expect(rowVoice({ ...base, phase: 'waiting', progress }).sub).toBe('· 3/7')
    expect(rowVoice({ ...base, progress: { done: 0, total: 1 } }).sub).toBeNull()
    expect(
      rowVoice({ ...base, showsChildProgress: true, progress: { done: 3, total: 3 } }),
    ).toEqual({ tone: 'settled', word: 'Subtasks done', sub: '3/3' })
  })

  it('separates done from closed, and lets a merge ask outrank done', () => {
    const done = { stage: 'done', closedReason: 'done' } as unknown as RowVoiceInput['issue']
    const cancelled = {
      stage: 'done',
      closedReason: 'cancelled',
    } as unknown as RowVoiceInput['issue']
    expect(rowVoice({ ...base, issue: done })).toMatchObject({ tone: 'done', word: 'Done' })
    expect(rowVoice({ ...base, issue: cancelled })).toMatchObject({ tone: 'closed' })
    expect(rowVoice({ ...base, issue: done, decision: 'merge' })).toEqual({
      tone: 'needs',
      word: 'Ready to merge',
      sub: null,
    })
  })

  it('names a merge-action landing instead of Done or Ready to merge (POD-2151)', () => {
    const landed = {
      stage: 'done',
      closedReason: 'done',
      parentBranch: 'tf.dev',
      landedAt: '2026-10-26T19:59:00Z',
      landedSha: 'fcd1385aa9e0',
    } as unknown as RowVoiceInput['issue']
    expect(rowVoice({ ...base, issue: landed })).toEqual({
      tone: 'done',
      word: 'Landed',
      sub: '· tf.dev · fcd1385',
    })
    // A cancelled close keeps its own word even with a stale stamp.
    const cancelled = { ...landed, closedReason: 'cancelled' } as unknown as RowVoiceInput['issue']
    expect(rowVoice({ ...base, issue: cancelled })).toMatchObject({
      tone: 'closed',
      word: 'Cancelled',
    })
  })
})
