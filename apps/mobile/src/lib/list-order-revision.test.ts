import { expect, it } from 'vitest'
import { listOrderRevision } from './list-order-revision'

const group = (key: string, ids: string[], folded = false) => ({ key, folded, ids })

it('changes on a reorder, a move between groups and a fold, and not otherwise', () => {
  const base = listOrderRevision([group('a', ['1', '2']), group('b', ['3'])])
  expect(listOrderRevision([group('a', ['1', '2']), group('b', ['3'])])).toBe(base)
  expect(listOrderRevision([group('a', ['2', '1']), group('b', ['3'])])).not.toBe(base)
  expect(listOrderRevision([group('a', ['1']), group('b', ['2', '3'])])).not.toBe(base)
  expect(listOrderRevision([group('a', ['1', '2'], true), group('b', ['3'])])).not.toBe(base)
  expect(listOrderRevision([group('b', ['3']), group('a', ['1', '2'])])).not.toBe(base)
  // Id boundaries count: ['12'] is not ['1', '2'].
  expect(listOrderRevision([group('a', ['12']), group('b', ['3'])])).not.toBe(base)
})

it('hashes row objects like their ids and reuses the cached hash of an unchanged array', () => {
  const rows = [{ id: '1' }, { id: '2' }]
  expect(listOrderRevision([group('a', ['1', '2'])])).toBe(
    listOrderRevision([{ key: 'a', folded: false, ids: rows }]),
  )
  const big = Array.from({ length: 2000 }, (_, i) => `issue-${i}`)
  listOrderRevision([group('a', big)])
  const start = performance.now()
  for (let i = 0; i < 1000; i++) listOrderRevision([group('a', big)])
  // 1000 renders over a cached 2000-row group: well under a frame in total.
  expect(performance.now() - start).toBeLessThan(16)
})
