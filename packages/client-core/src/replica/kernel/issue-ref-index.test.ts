import type { EntityRecord } from '@podium/sync/replica'
import { expect, it } from 'vitest'
import { IssueRefIndex } from './issue-ref-index'

it('orders kernel alias claimants without changing ambiguous id lookups', () => {
  const index = new IssueRefIndex([
    { entity: 'issueProjection', entityId: 'z', value: { seq: 8, repoId: 'second' } },
    { entity: 'issueProjection', entityId: 'a', value: { seq: 8, repoId: 'first' } },
  ] as EntityRecord[])
  expect(index.id('#8')).toBeUndefined()
  expect(index.candidates('#008')).toEqual(['a', 'z'])
  const copy = index.candidates('#8') as string[]
  copy.reverse()
  expect(index.candidates('#8')).toEqual(['a', 'z'])
  index.issue('a', undefined)
  expect(index.candidates('#8')).toEqual(['z'])
  expect(index.id('#8')).toBe('z')
  index.repo('second', { prefix: 'NEW' })
  expect(index.candidates('#8')).toEqual([])
  expect(index.candidates('NEW-8')).toEqual(['z'])
  expect(index.id('NEW-8')).toBe('z')
})
