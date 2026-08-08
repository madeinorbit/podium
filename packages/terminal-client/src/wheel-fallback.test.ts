// packages/terminal-client/src/wheel-fallback.test.ts
import { describe, expect, it } from 'vitest'
import { type WheelFallbackTerminal, wheelFallbackKeys } from './wheel-fallback'

function stub(
  opts: {
    mouse?: boolean
    canLocal?: boolean | ((deltaY: number) => boolean)
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

  it('emits PageUp for an upward wheel when nothing else can scroll (Grok)', () => {
    const { term } = stub()
    expect(wheelFallbackKeys(term, -240)).toBe('\x1b[5~')
  })

  it('emits PageDown for a downward wheel', () => {
    const { term } = stub()
    expect(wheelFallbackKeys(term, 200)).toBe('\x1b[6~')
  })

  it('uses PageUp/PageDown for small trackpad deltas too — never arrows (POD-552)', () => {
    // Arrows would browse Grok prompt history while the prompt is focused.
    // PageUp/PageDown scroll conversation content (Grok Build ≥0.2.99).
    const { term } = stub()
    expect(wheelFallbackKeys(term, -40)).toBe('\x1b[5~')
    expect(wheelFallbackKeys(term, 20)).toBe('\x1b[6~')
    expect(wheelFallbackKeys(term, -10)).toBe('\x1b[5~')
    expect(wheelFallbackKeys(term, 1)).toBe('\x1b[6~')
  })

  it('ignores a zero delta', () => {
    const { term } = stub()
    expect(wheelFallbackKeys(term, 0)).toBeNull()
  })
})
