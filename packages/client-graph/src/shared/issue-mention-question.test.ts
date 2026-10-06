import { describe, expect, it } from 'vitest'
import { createIssueMentionIndex } from './issue-mention-question'

const row = (id: string, seq: number, at = '2020-01-01T00:00:00Z') => ({
  id, seq, title: `Title ${id}`, repoId: 'repo', updatedAt: at,
})
function fixture() {
  const index = createIssueMentionIndex()
  index.set('a', row('a', 10))
  index.set('b', row('b', 20))
  index.set('c', row('c', 30))
  const ids = (query = '', prefixes = { repo: 'POD', other: 'ALT' }) =>
    index.ids({ kind: 'issueMentionMatches', query, limit: 10, prefixes })
  return { index, ids }
}

describe('mention rank positions follow their own inputs', () => {
  it('changes title postings while retaining recency and sequence tie positions', () => {
    const { index, ids } = fixture(), revision = index.revision
    index.set('b', { ...row('b', 20), title: 'Unique renamed title' })
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(ids('pod')).toEqual(['c', 'b', 'a'])
    expect(ids('renamed')).toEqual(['b'])
    expect(ids('title b')).toEqual([])
    expect(index.revision).toBe(revision + 1)
    index.set('b', { ...row('b', 20), title: 'Unique renamed title', description: 'private' })
    expect(index.revision).toBe(revision + 1)
  })
  it('moves timestamp order without moving sequence order', () => {
    const { index, ids } = fixture()
    index.set('b', row('b', 20, '2021-01-01T00:00:00Z'))
    expect(ids()).toEqual(['b', 'a', 'c'])
    expect(ids('pod')).toEqual(['c', 'b', 'a'])
    index.set('b', row('b', 20, '2019-01-01T00:00:00Z'))
    expect(ids()).toEqual(['a', 'c', 'b'])
  })
  it('moves sequence order while retaining recency tie order', () => {
    const { index, ids } = fixture()
    index.set('b', row('b', 40))
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(ids('pod')).toEqual(['b', 'c', 'a'])
    expect(ids('pod-4')).toEqual(['b'])
  })
  it('moves repository membership and transitions into and out of native references', () => {
    const { index, ids } = fixture()
    index.set('b', { ...row('b', 20), repoId: 'other' })
    expect(ids('pod')).toEqual(['c', 'a'])
    expect(ids('alt')).toEqual(['b'])
    index.set('b', { ...row('b', 20), linearIdentifier: 'EXT-22' })
    expect(ids('alt')).toEqual([])
    expect(ids('pod')).toEqual(['c', 'a'])
    expect(ids('ext-22')).toEqual(['b'])
    index.set('b', { ...row('b', 20), linearIdentifier: 'EXT-23' })
    expect(ids('ext-22')).toEqual([])
    expect(ids('ext-23')).toEqual(['b'])
    index.set('b', row('b', 20))
    expect(ids('pod')).toEqual(['c', 'b', 'a'])
    expect(ids()).toEqual(['a', 'b', 'c'])
  })
  it('removes and reintroduces archived, deleted and absent members', () => {
    for (const missing of [{ archived: true }, { deletedAt: '2022-01-01T00:00:00Z' }, undefined]) {
      const { index, ids } = fixture()
      index.set('b', missing ? { ...row('b', 20), ...missing } : undefined)
      expect(ids()).toEqual(['a', 'c'])
      expect(ids('pod')).toEqual(['c', 'a'])
      index.set('b', row('b', 20))
      expect(ids()).toEqual(['a', 'c', 'b'])
      expect(ids('pod')).toEqual(['c', 'b', 'a'])
    }
  })
})
