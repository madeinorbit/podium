import { describe, expect, it } from 'vitest'
import { pageHistory } from './history'
import type { TranscriptItem } from '@podium/model'

const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'text', text: id })) as unknown as TranscriptItem[]

describe('contract history paging', () => {
  it('returns a newest page and follows its head backward and tail forward', () => {
    const newest = pageHistory(items, 'session', { direction: 'before', limit: 2 })
    expect(newest.items).toEqual(items.slice(2))
    expect(newest.hasMore).toBe(true)
    const older = pageHistory(items, 'session', { direction: 'before', from: newest.head, limit: 2 })
    expect(older.items).toEqual(items.slice(0, 2))
    expect(older.hasMore).toBe(false)
    expect(pageHistory(items, 'session', { direction: 'after', from: older.tail, limit: 2 })).toEqual({ ...newest, hasMore: false })
  })

  it('starts forward reads at the beginning and rejects foreign or malformed cursors', () => {
    expect(pageHistory(items, 'session', { direction: 'after', limit: 1 }).items).toEqual(items.slice(0, 1))
    expect(() => pageHistory(items, 'session', { direction: 'before', limit: 2, from: { segmentId: 'other', components: { item: 1 } } })).toThrow()
    expect(() => pageHistory(items, 'session', { direction: 'before', limit: 2, from: { segmentId: 'session', components: {} } })).toThrow()
  })
})
