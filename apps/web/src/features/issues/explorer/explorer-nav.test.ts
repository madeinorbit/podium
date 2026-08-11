import { describe, expect, it } from 'vitest'
import { crumbTrail, popToDepth, pushLevel, resetTo } from './explorer-nav'

describe('explorer stack', () => {
  it('pushes a level and refuses to stack the same task twice', () => {
    expect(pushLevel(['a'], 'b')).toEqual(['a', 'b'])
    // A relation row clicked twice, or clicked while the transition is running.
    expect(pushLevel(['a', 'b'], 'b')).toEqual(['a', 'b'])
  })

  it('pops to a depth, and depth 0 is the list', () => {
    expect(popToDepth(['a', 'b', 'c'], 1)).toEqual(['a'])
    expect(popToDepth(['a', 'b', 'c'], 0)).toEqual([])
    // Going back further than the task that opened the detail is the whole
    // point: it lands on the full list rather than refusing.
    expect(popToDepth(['a'], 0)).toEqual([])
  })

  it('ignores a pop past the end rather than growing the stack', () => {
    expect(popToDepth(['a'], 5)).toEqual(['a'])
    expect(popToDepth([], -1)).toEqual([])
  })

  it('resets the chain when something outside the panel retargets it', () => {
    // The trail describes how the operator got somewhere. A Flight Deck click
    // is not a step in that trail, so it starts a new one.
    expect(resetTo(['a', 'b', 'c'], 'd')).toEqual(['d'])
  })

  it('keeps the chain when the retarget is the task already on top', () => {
    // Clicking a second session of the task you are already looking at must not
    // throw away the relations you walked to get there.
    expect(resetTo(['a'], 'a')).toEqual(['a'])
    // ...but a deep chain rooted elsewhere still collapses onto the target.
    expect(resetTo(['a', 'b'], 'a')).toEqual(['a'])
  })

  it('keeps what it has when there is nothing to point at', () => {
    expect(resetTo(['a'], null)).toEqual(['a'])
  })
})

describe('breadcrumb trail', () => {
  it('is always rooted at the list', () => {
    expect(crumbTrail([])).toEqual([{ kind: 'root', depth: 0 }])
    expect(crumbTrail(['a'])).toEqual([
      { kind: 'root', depth: 0 },
      { kind: 'issue', id: 'a', depth: 1 },
    ])
  })

  it('elides the middle of a long chain, keeping the root and where you are', () => {
    const trail = crumbTrail(['a', 'b', 'c', 'd'])
    expect(trail).toEqual([
      { kind: 'root', depth: 0 },
      { kind: 'gap' },
      { kind: 'issue', id: 'c', depth: 3 },
      { kind: 'issue', id: 'd', depth: 4 },
    ])
    // The depths survive the elision, so a crumb click still pops to the right
    // level rather than to its position in the rendered trail.
    expect(trail.at(-1)).toEqual({ kind: 'issue', id: 'd', depth: 4 })
  })
})
