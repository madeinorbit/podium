import { describe, expect, it } from 'vitest'
import { type IssuesNav, issuesKeyReduce } from './issues-keys'

const rows = (ids: string[]): IssuesNav => ({ kind: 'rows', ids })
const cols = (columns: string[][]): IssuesNav => ({ kind: 'columns', columns })

describe('issuesKeyReduce — next / prev over rows', () => {
  it('from null focus, next focuses the first id', () => {
    expect(
      issuesKeyReduce({ focusId: null, selected: [] }, { kind: 'next' }, rows(['a', 'b'])).focusId,
    ).toBe('a')
  })
  it('from null focus, prev also focuses the first id', () => {
    expect(
      issuesKeyReduce({ focusId: null, selected: [] }, { kind: 'prev' }, rows(['a', 'b'])).focusId,
    ).toBe('a')
  })
  it('next advances to the following id', () => {
    expect(
      issuesKeyReduce({ focusId: 'a', selected: [] }, { kind: 'next' }, rows(['a', 'b'])).focusId,
    ).toBe('b')
  })
  it('next clamps at the end (no wrap)', () => {
    expect(
      issuesKeyReduce({ focusId: 'b', selected: [] }, { kind: 'next' }, rows(['a', 'b'])).focusId,
    ).toBe('b')
  })
  it('prev clamps at the start (no wrap)', () => {
    expect(
      issuesKeyReduce({ focusId: 'a', selected: [] }, { kind: 'prev' }, rows(['a', 'b'])).focusId,
    ).toBe('a')
  })
  it('prev moves backward', () => {
    expect(
      issuesKeyReduce({ focusId: 'b', selected: [] }, { kind: 'prev' }, rows(['a', 'b'])).focusId,
    ).toBe('a')
  })
  it('next on an empty nav yields null focus', () => {
    expect(
      issuesKeyReduce({ focusId: null, selected: [] }, { kind: 'next' }, rows([])).focusId,
    ).toBe(null)
  })
})

describe('issuesKeyReduce — next / prev flatten columns', () => {
  const nav = cols([
    ['a', 'b'],
    ['x', 'y'],
  ])
  it('next crosses the column boundary in visual order', () => {
    expect(issuesKeyReduce({ focusId: 'b', selected: [] }, { kind: 'next' }, nav).focusId).toBe('x')
  })
  it('prev crosses back across the boundary', () => {
    expect(issuesKeyReduce({ focusId: 'x', selected: [] }, { kind: 'prev' }, nav).focusId).toBe('b')
  })
  it('next clamps at the last flattened id', () => {
    expect(issuesKeyReduce({ focusId: 'y', selected: [] }, { kind: 'next' }, nav).focusId).toBe('y')
  })
})

describe('issuesKeyReduce — left / right across columns', () => {
  it('right moves to the same row index in the adjacent non-empty column', () => {
    expect(
      issuesKeyReduce({ focusId: 'a', selected: [] }, { kind: 'right' }, cols([['a'], ['x', 'y']]))
        .focusId,
    ).toBe('x')
  })
  it('right clamps the row index to the target column length', () => {
    expect(
      issuesKeyReduce({ focusId: 'b', selected: [] }, { kind: 'right' }, cols([['a', 'b'], ['x']]))
        .focusId,
    ).toBe('x')
  })
  it('left moves to the previous column keeping the row index', () => {
    expect(
      issuesKeyReduce(
        { focusId: 'y', selected: [] },
        { kind: 'left' },
        cols([
          ['a', 'b'],
          ['x', 'y'],
        ]),
      ).focusId,
    ).toBe('b')
  })
  it('right skips an empty column', () => {
    expect(
      issuesKeyReduce({ focusId: 'a', selected: [] }, { kind: 'right' }, cols([['a'], [], ['z']]))
        .focusId,
    ).toBe('z')
  })
  it('right is a no-op with no non-empty column to the right', () => {
    expect(
      issuesKeyReduce({ focusId: 'x', selected: [] }, { kind: 'right' }, cols([['a'], ['x']]))
        .focusId,
    ).toBe('x')
  })
  it('left/right are no-ops on rows nav', () => {
    expect(
      issuesKeyReduce({ focusId: 'a', selected: [] }, { kind: 'right' }, rows(['a', 'b'])).focusId,
    ).toBe('a')
    expect(
      issuesKeyReduce({ focusId: 'b', selected: [] }, { kind: 'left' }, rows(['a', 'b'])).focusId,
    ).toBe('b')
  })
})

describe('issuesKeyReduce — toggleSelect', () => {
  it('adds the focused id to the selection', () => {
    expect(
      issuesKeyReduce({ focusId: 'a', selected: [] }, { kind: 'toggleSelect' }, rows(['a', 'b']))
        .selected,
    ).toEqual(['a'])
  })
  it('removes an already-selected focused id', () => {
    expect(
      issuesKeyReduce({ focusId: 'a', selected: ['a'] }, { kind: 'toggleSelect' }, rows(['a', 'b']))
        .selected,
    ).toEqual([])
  })
  it('no-ops when focus is null', () => {
    expect(
      issuesKeyReduce({ focusId: null, selected: [] }, { kind: 'toggleSelect' }, rows(['a', 'b']))
        .selected,
    ).toEqual([])
  })
})

describe('issuesKeyReduce — clear', () => {
  it('drops the selection first, keeping focus', () => {
    const r = issuesKeyReduce({ focusId: 'a', selected: ['a'] }, { kind: 'clear' }, rows(['a']))
    expect(r.selected).toEqual([])
    expect(r.focusId).toBe('a')
  })
  it('drops focus once the selection is already empty', () => {
    expect(
      issuesKeyReduce({ focusId: 'a', selected: [] }, { kind: 'clear' }, rows(['a'])).focusId,
    ).toBe(null)
  })
})

describe('issuesKeyReduce — normalization of vanished focus', () => {
  it('next from a focus id no longer in nav lands on the first id', () => {
    expect(
      issuesKeyReduce({ focusId: 'gone', selected: [] }, { kind: 'next' }, rows(['a'])).focusId,
    ).toBe('a')
  })
  it('never returns a focus id absent from nav (toggleSelect no-ops)', () => {
    const r = issuesKeyReduce(
      { focusId: 'gone', selected: [] },
      { kind: 'toggleSelect' },
      rows(['a']),
    )
    expect(r.focusId).toBe(null)
    expect(r.selected).toEqual([])
  })
  it('clear on a vanished focus normalizes to null', () => {
    expect(
      issuesKeyReduce({ focusId: 'gone', selected: [] }, { kind: 'clear' }, rows(['a'])).focusId,
    ).toBe(null)
  })
})
