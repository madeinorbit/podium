import { describe, expect, it } from 'vitest'
import {
  currentReadScope,
  inExplicitReadScope,
  readScopeSlot,
  withReadScope,
} from './read-scope'

/**
 * THE READ SCOPE [POD-3261].
 *
 * The point of this file is the arm the frame caches could never walk. Their
 * suites prove the microtask lifetime — a cache that survives one synchronous
 * turn and dies at the first `await`. That is exactly the property this epic
 * removes, so a test that only checks it would pass while the mechanism that is
 * supposed to replace it does nothing.
 *
 * So every test here that matters ASSERTS ACROSS AN AWAIT: reads separated by a
 * yield, inside one scope, answered once. Under the old mechanism every one of
 * them fails.
 */
describe('read scope', () => {
  const counting = () => {
    let built = 0
    const key = readScopeSlot(() => {
      built += 1
      return new Map<string, number>()
    })
    return { key, built: () => built }
  }

  it('holds a slot for the scope, and a scope is not the turn', async () => {
    const { key, built } = counting()
    await withReadScope(async () => {
      currentReadScope().slot(key).set('a', 1)
      // THE WHOLE POINT. A microtask boundary — the thing that ends a frame —
      // does not end a scope.
      await Promise.resolve()
      await Promise.resolve()
      expect(currentReadScope().slot(key).get('a')).toBe(1)
    })
    expect(built()).toBe(1)
  })

  it('discards the slot when the outermost scope returns', () => {
    const { key, built } = counting()
    withReadScope(() => {
      currentReadScope().slot(key).set('a', 1)
    })
    withReadScope(() => {
      expect(currentReadScope().slot(key).size).toBe(0)
    })
    expect(built()).toBe(2)
  })

  it('joins an open scope rather than nesting a second one', () => {
    const { key, built } = counting()
    withReadScope(() => {
      const outer = currentReadScope()
      currentReadScope().slot(key).set('a', 1)
      withReadScope((inner) => {
        expect(inner.id).toBe(outer.id)
        expect(currentReadScope().slot(key).get('a')).toBe(1)
      })
      // And the inner call's return did not take the outer scope's slot with it.
      expect(currentReadScope().slot(key).get('a')).toBe(1)
    })
    expect(built()).toBe(1)
  })

  it('discards the scope when the body throws', () => {
    const { key } = counting()
    expect(() =>
      withReadScope(() => {
        currentReadScope().slot(key).set('a', 1)
        throw new Error('body failed')
      }),
    ).toThrow('body failed')
    // A scope left installed would be handed to whatever ran next on this
    // context, which is a snapshot from a pass that already ended.
    expect(inExplicitReadScope()).toBe(false)
    withReadScope(() => {
      expect(currentReadScope().slot(key).size).toBe(0)
    })
  })

  it('gives each owner its own slot, so two stores never share one', () => {
    const first = counting()
    const second = counting()
    withReadScope(() => {
      currentReadScope().slot(first.key).set('a', 1)
      expect(currentReadScope().slot(second.key).size).toBe(0)
    })
  })

  it('clear drops one owner and leaves the rest of the scope standing', () => {
    const first = counting()
    const second = counting()
    withReadScope(() => {
      currentReadScope().slot(first.key).set('a', 1)
      currentReadScope().slot(second.key).set('b', 2)
      currentReadScope().clear(first.key)
      expect(currentReadScope().has(first.key)).toBe(false)
      expect(currentReadScope().slot(second.key).get('b')).toBe(2)
      expect(currentReadScope().slot(first.key).size).toBe(0)
    })
  })

  it('a slot may hold a falsy value and is still a hit', () => {
    const key = readScopeSlot<number>(() => 0)
    let built = 0
    const counted = readScopeSlot<number>(() => {
      built += 1
      return 0
    })
    withReadScope(() => {
      expect(currentReadScope().slot(key)).toBe(0)
      currentReadScope().slot(counted)
      currentReadScope().slot(counted)
      expect(built).toBe(1)
    })
  })

  /**
   * THE FALLBACK, and the reason it is still here.
   *
   * Outside an explicit scope the turn owns the lifetime, which is today's
   * behaviour exactly and what the landed frame-cache suites assert. It is the
   * transitional half; the assertion below is what will change when it is
   * deleted at the flip.
   */
  it('falls back to the turn when no scope is open, and the turn ends at an await', async () => {
    const { key, built } = counting()
    expect(inExplicitReadScope()).toBe(false)
    currentReadScope().slot(key).set('a', 1)
    expect(currentReadScope().slot(key).get('a')).toBe(1)
    expect(built()).toBe(1)
    await Promise.resolve()
    expect(currentReadScope().slot(key).size).toBe(0)
    expect(built()).toBe(2)
  })

  it('an explicit scope does not inherit the turn scope it opened inside', () => {
    const { key } = counting()
    currentReadScope().slot(key).set('a', 1)
    withReadScope(() => {
      // A fresh snapshot, not a continuation of whatever the turn happened to
      // be holding: the scope is the lease, and a lease starts where it starts.
      expect(currentReadScope().slot(key).size).toBe(0)
    })
  })
})
