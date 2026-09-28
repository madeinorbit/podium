/**
 * POD-4746 — the changed items' neighbourhood (`neighbourhood.ts`): a family
 * for a changed row, the sections for a moved one, nothing beyond.
 */

import { describe, expect, it } from 'vitest'
import type { SliceOrder } from '../../shared/src/slice-types'
import { type NeighbourhoodState, neighbourhoodOf } from './neighbourhood'

// root ─┬─ a ─── a1
//       └─ b
// other (unrelated)
const issues = [
  { id: 'root', parentId: null },
  { id: 'a', parentId: 'root' },
  { id: 'a1', parentId: 'a' },
  { id: 'b', parentId: 'root' },
  { id: 'other', parentId: null },
]
const sessions = [
  { sessionId: 's-a1', issueId: 'a1' },
  { sessionId: 's-root', issueId: 'root' },
  { sessionId: 's-other', issueId: 'other' },
]
const order = (groups: [string, string[], string[]][]): SliceOrder => ({
  pinnedIds: [],
  groups: groups.map(([key, rowIds, closedIds]) => ({ key, label: key, rowIds, closedIds })),
})
const state = (o: SliceOrder): NeighbourhoodState => ({ issues, sessions, order: o })
const g1 = ['root', 'x1', 'x2']
const g2 = ['other', 'y1']

describe('neighbourhoodOf', () => {
  it('a session stands for its issue: the chain, each level’s children and sessions', () => {
    const same = state(
      order([
        ['g1', g1, []],
        ['g2', g2, []],
      ]),
    )
    const { members, moved } = neighbourhoodOf(same, same, ['session:s-a1'], [])
    expect([...members].sort()).toEqual(
      [
        'session:s-a1',
        'issue:a1', // the issue …
        'issue:a', // … its parent and the parent's children (a1) …
        'issue:root', // … the root, its children (a, b) and its session
        'issue:b',
        'session:s-root',
      ].sort(),
    )
    expect(moved).toEqual([])
  })

  it('a row that keeps its place adds no section', () => {
    const same = state(
      order([
        ['g1', g1, []],
        ['g2', g2, []],
      ]),
    )
    expect(neighbourhoodOf(same, same, [], ['other']).members.size).toBe(2) // other, s-other
  })

  it('a moved row adds the sections it leaves and enters', () => {
    const before = state(
      order([
        ['g1', g1, []],
        ['g2', g2, []],
      ]),
    )
    const after = state(
      order([
        ['g1', ['x1', 'x2'], []],
        ['g2', ['other', 'root', 'y1'], []],
      ]),
    )
    const { members, moved } = neighbourhoodOf(before, after, [], ['root'])
    expect(moved).toEqual(['root'])
    for (const id of ['x1', 'x2', 'other', 'y1']) expect(members.has(`issue:${id}`)).toBe(true)
  })

  it('a row whose section moves among the sections moved too', () => {
    const before = state(
      order([
        ['g1', g1, []],
        ['g2', g2, []],
      ]),
    )
    const after = state(
      order([
        ['g2', g2, []],
        ['g1', g1, []],
      ]),
    )
    const { members, moved } = neighbourhoodOf(before, after, [], ['root'])
    expect(moved).toEqual(['root'])
    expect(members.has('issue:x2')).toBe(true)
    expect(members.has('issue:y1')).toBe(false)
  })
})
