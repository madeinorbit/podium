import { describe, expect, it } from 'vitest'
import { mergeVisibleProjectOrder } from './project-order'

describe('project order', () => {
  it('keeps hidden saved projects in place while visible projects are reordered', () => {
    const projects = [
      { key: 'repo-a', name: 'a', aliases: ['repo-a', '/a'] },
      { key: 'repo-b', name: 'b', aliases: ['repo-b', '/b'] },
    ]
    expect(mergeVisibleProjectOrder([...projects].reverse(), ['/a', 'hidden', 'repo-b'])).toEqual([
      'repo-b',
      'hidden',
      'repo-a',
    ])
  })
})
