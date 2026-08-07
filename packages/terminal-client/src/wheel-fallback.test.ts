// packages/terminal-client/src/wheel-fallback.test.ts
import { describe, expect, it } from 'vitest'
import { type WheelFallbackTerminal, wheelFallbackKeys } from './wheel-fallback'

function stub(
  opts: {
    mouse?: boolean
    canLocal?: boolean | ((deltaY: number) => boolean)
    row?: number
  } = {},
): { term: WheelFallbackTerminal; keys: string[] } {
  const keys: string[] = []
  return {
    keys,
    term: {
      appOwnsMouse: () => opts.mouse ?? false,
      canLocalScroll: (deltaY) =>
        typeof opts.canLocal === 'function'
          ? opts.canLocal(deltaY)
          : (opts.canLocal ?? false),
      rowHeight: () => opts.row ?? 20,
      sendKeys: (data) => keys.push(data),
    },
  }
}

describe('wheelFallbackKeys', () => {
  it('stays out of the way when the application owns the mouse (Claude)', () => {
    const { term } = stub({ mouse: true })
    expect(wheelFallbackKeys(term, -240)).toBeNull()
    expect(wheelFallbackKeys(term, 120)).toBeNull()
  })

  it('stays out of the way when the local viewport can still scroll', () => {
    const { term } = stub({ canLocal: true })
    expect(wheelFallbackKeys(term, -240)).toBeNull()
  })

  it('emits PageUp for a large upward wheel when nothing else can scroll (Grok)', () => {
    const { term } = stub()
    expect(wheelFallbackKeys(term, -240)).toBe('\x1b[5~')
  })

  it('emits PageDown for a large downward wheel', () => {
    const { term } = stub()
    expect(wheelFallbackKeys(term, 200)).toBe('\x1b[6~')
  })

  it('emits one arrow per row of travel for small deltas', () => {
    const { term } = stub({ row: 20 })
    // 40px up → two cursor-up keys
    expect(wheelFallbackKeys(term, -40)).toBe('\x1b[A\x1b[A')
    expect(wheelFallbackKeys(term, 20)).toBe('\x1b[B')
  })

  it('caps arrows so a trackpad fling cannot flood the PTY', () => {
    const { term } = stub({ row: 10 })
    // 200px would be 20 arrows but PAGE_DELTA_PX (80) routes this to PageUp
    expect(wheelFallbackKeys(term, -200)).toBe('\x1b[5~')
    // just under the page threshold, row=10 → 7 lines → capped at 6
    expect(wheelFallbackKeys(term, -70)).toBe('\x1b[A'.repeat(6))
  })

  it('ignores a zero delta', () => {
    const { term } = stub()
    expect(wheelFallbackKeys(term, 0)).toBeNull()
  })

  it('still emits a single arrow when row height is unmeasurable', () => {
    const { term } = stub({ row: 0 })
    expect(wheelFallbackKeys(term, -10)).toBe('\x1b[A')
  })
})
