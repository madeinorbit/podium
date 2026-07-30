import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { computePriorities } from './session-priority'

const C = (attached: string[], viewVisible: string[], focused: string | null) => ({
  attached: new Set(attached.map(asSessionId)),
  viewVisible: new Set(viewVisible.map(asSessionId)),
  focused: focused === null ? null : asSessionId(focused),
})

describe('computePriorities', () => {
  it('focused=0, visible=1, attached=2, unwatched=3', () => {
    const p = computePriorities([C(['a', 'b', 'c'], ['a', 'b'], 'a')], ['a', 'b', 'c', 'd'].map(asSessionId))
    expect(p.get(asSessionId('a'))).toBe(0) // focused
    expect(p.get(asSessionId('b'))).toBe(1) // visible, not focused
    expect(p.get(asSessionId('c'))).toBe(2) // attached, not visible
    expect(p.get(asSessionId('d'))).toBe(3) // nobody
  })
  it('unions across clients: mobile focuses A, desktop focuses B → both P0', () => {
    const p = computePriorities([C(['a'], ['a'], 'a'), C(['b'], ['b'], 'b')], ['a', 'b'].map(asSessionId))
    expect(p.get(asSessionId('a'))).toBe(0)
    expect(p.get(asSessionId('b'))).toBe(0)
  })
  it('a hidden client (visible=[]) drops its sessions to attached', () => {
    const p = computePriorities([C(['a'], [], null)], ['a'].map(asSessionId))
    expect(p.get(asSessionId('a'))).toBe(2)
  })
})
