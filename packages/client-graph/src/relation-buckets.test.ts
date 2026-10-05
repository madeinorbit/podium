import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { RelationBuckets } from './shared/relation-buckets'

it('moves a member between addressed buckets without waking another bucket', () => {
  const relations = new RelationBuckets({ trackedForward: true })
  const bucket = (id: string) => `issue:${id}:sessions`
  runInAction(() => {
    relations.move('session:one:issue', 'one', ['a'], bucket)
    relations.move('session:two:issue', 'two', ['b'], bucket)
  })
  const original = relations.many(bucket('b'))
  let otherReads = 0
  const seen: unknown[] = []
  const stopOther = autorun(() => { relations.many(bucket('b')); otherReads++ })
  const stop = autorun(() => seen.push([relations.one('session:one:issue'), [...relations.many(bucket('a'))], [...relations.many(bucket('c'))]]))
  try {
    runInAction(() => relations.move('session:one:issue', 'one', ['c'], bucket))
    expect(seen).toEqual([['a', ['one'], []], ['c', [], ['one']]])
    expect(otherReads).toBe(1)
    expect(relations.many(bucket('b'))).toBe(original)
    runInAction(() => relations.move('session:one:issue', 'one', [], bucket))
    expect(seen.at(-1)).toEqual([undefined, [], []])
  } finally { stop(); stopOther() }
})

it('keeps unchanged multi-target memberships and the source ordering policy', () => {
  const relations = new RelationBuckets({ sorted: true })
  const bucket = (id: string) => id
  runInAction(() => {
    relations.move('one', 'z', ['a', 'b'], bucket)
    relations.move('two', 'a', ['a'], bucket)
  })
  expect(relations.many('a')).toEqual(['a', 'z'])
  const kept = relations.many('a')
  runInAction(() => relations.move('one', 'z', ['a', 'c'], bucket))
  expect(relations.many('a')).toBe(kept)
  expect(relations.many('b')).toEqual([])
  expect(relations.many('c')).toEqual(['z'])
  runInAction(() => relations.clear())
  expect(relations.many('a')).toEqual([])
})
