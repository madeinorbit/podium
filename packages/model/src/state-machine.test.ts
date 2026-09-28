import { describe, expect, it } from 'vitest'
import {
  defineMachine,
  IllegalMoveError,
  isForwardOnly,
  type MoveOutcome,
  walkMoves,
} from './state-machine'

const door = () =>
  defineMachine('door', {
    states: ['closed', 'open', 'locked', 'gone'],
    edges: {
      closed: ['open', 'locked', 'gone'],
      open: ['closed', 'gone'],
      locked: ['closed'],
      gone: [],
    },
    terminal: ['gone'],
  })

describe('defineMachine', () => {
  it('answers moves from the table', () => {
    const m = door()
    expect(m.canMove('closed', 'open')).toBe(true)
    expect(m.canMove('open', 'locked')).toBe(false)
    expect(m.canMove('gone', 'closed')).toBe(false)
    expect(m.next('locked')).toEqual(['closed'])
    expect(m.isTerminal('gone')).toBe(true)
    expect(m.isTerminal('open')).toBe(false)
    expect(m.isState('open')).toBe(true)
    expect(m.isState('ajar')).toBe(false)
    expect(m.isState(3)).toBe(false)
  })

  it('lists the states a move into a state may start from', () => {
    const m = door()
    expect([...m.allowedFrom('closed')].sort()).toEqual(['locked', 'open'])
    expect([...m.allowedFrom('gone')].sort()).toEqual(['closed', 'open'])
    expect(m.allowedFrom('locked')).toEqual(['closed'])
  })

  it('throws a named error for an illegal move', () => {
    const m = door()
    expect(() => m.assertMove('closed', 'open')).not.toThrow()
    expect(() => m.assertMove('locked', 'open')).toThrow(IllegalMoveError)
    expect(() => m.assertMove('locked', 'open')).toThrow('door: illegal move locked → open')
    // Staying put is never a move: a repeat is answered "already there".
    expect(() => m.assertMove('open', 'open')).toThrow(IllegalMoveError)
  })

  it('refuses a table that contradicts itself', () => {
    expect(() =>
      defineMachine('t', { states: ['a', 'b'], edges: { a: ['b'], b: ['a'] }, terminal: ['b'] }),
    ).toThrow('terminal state b has outgoing moves')
    expect(() =>
      defineMachine('t', { states: ['a', 'b'], edges: { a: [], b: [] }, terminal: ['b'] }),
    ).toThrow('non-terminal state a has no way out')
    expect(() =>
      defineMachine('t', { states: ['a', 'b'], edges: { a: ['a', 'b'], b: [] }, terminal: ['b'] }),
    ).toThrow('a moves to itself')
    expect(() =>
      defineMachine('t', {
        states: ['a', 'b'],
        edges: { a: ['c' as 'b'], b: [] },
        terminal: ['b'],
      }),
    ).toThrow('a moves to unknown state c')
    expect(() =>
      defineMachine('t', { states: ['a', 'a'], edges: { a: [] }, terminal: ['a'] }),
    ).toThrow('duplicate state')
    expect(() =>
      defineMachine('t', { states: ['a', 'b'], edges: { a: ['b', 'b'], b: [] }, terminal: ['b'] }),
    ).toThrow('duplicate move from a')
    expect(() =>
      defineMachine('t', {
        states: ['a', 'b'],
        edges: { a: ['b'], b: [] },
        terminal: ['b', 'z' as 'b'],
      }),
    ).toThrow('terminal state z is not a state')
  })
})

describe('isForwardOnly', () => {
  it('rejects a table with a way back', () => {
    expect(isForwardOnly(door())).toBe(false)
  })

  it('accepts a table that only moves forward', () => {
    const m = defineMachine('line', {
      states: ['a', 'b', 'c'],
      edges: { a: ['b', 'c'], b: ['c'], c: [] },
      terminal: ['c'],
    })
    expect(isForwardOnly(m)).toBe(true)
  })
})

describe('walkMoves', () => {
  const faithful =
    (m: ReturnType<typeof door>) =>
    async (from: 'closed' | 'open' | 'locked' | 'gone', to: typeof from) =>
      (from === to
        ? { kind: 'already-there' }
        : m.canMove(from, to)
          ? { kind: 'applied' }
          : { kind: 'refused', current: from }) satisfies MoveOutcome<typeof from>

  it('finds nothing wrong with an implementation that follows the table', async () => {
    const m = door()
    expect(await walkMoves(m, faithful(m))).toEqual([])
  })

  it('names a missing edge the implementation lets through', async () => {
    const m = door()
    const leaky = async (
      from: 'closed' | 'open' | 'locked' | 'gone',
      to: typeof from,
    ): Promise<MoveOutcome<typeof from>> =>
      from === 'locked' && to === 'open' ? { kind: 'applied' } : faithful(m)(from, to)
    expect(await walkMoves(m, leaky)).toEqual([
      { from: 'locked', to: 'open', expected: 'refused', actual: 'applied' },
    ])
  })

  it('names a refusal that misreports where the row was', async () => {
    const m = door()
    const lying = async (
      from: 'closed' | 'open' | 'locked' | 'gone',
      to: typeof from,
    ): Promise<MoveOutcome<typeof from>> =>
      from === 'gone' && to === 'open' ? { kind: 'refused', current: null } : faithful(m)(from, to)
    expect(await walkMoves(m, lying)).toEqual([
      { from: 'gone', to: 'open', expected: 'refused', actual: 'refused' },
    ])
  })
})
