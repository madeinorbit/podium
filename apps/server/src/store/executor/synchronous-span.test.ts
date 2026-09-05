/**
 * The synchronous span bridge [POD-3260].
 *
 * WHAT EACH TEST HAS TO AVOID, and it is the trap spec §6 rule 14 names: every
 * one of these could be written so that it passes with the bridge doing nothing.
 * A body that registers an effect and then returns will run that effect at some
 * point in any implementation, so "the effect ran" proves nothing. What proves
 * the mechanism is WHEN it ran RELATIVE to something else, so every test here
 * asserts an ORDER — against the commit, against a sibling batch, against the
 * body's own throw — and the one that cannot (the seam test) drives the
 * production entry point rather than a locally wrapped copy of it.
 */

import { describe, expect, it } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { postCommit } from './executor'
import { afterCommit } from './synchronous-span'

describe('afterCommit outside a span', () => {
  it('runs the step now, and unguarded', () => {
    const ran: string[] = []
    afterCommit(() => void ran.push('now'), 'x')
    expect(ran).toEqual(['now'])
    // Deliberately NOT isolated: there is no commit to protect out here, and
    // catching would hide a wiring fault behind a pane that never updates.
    expect(() =>
      afterCommit(() => {
        throw new Error('listener not wired')
      }, 'y'),
    ).toThrow('listener not wired')
    expect(reported).toEqual([])
  })
})

describe('the store seam', () => {
  it('opens a post-commit scope for every SessionStore.transact body', async () => {
    // THE SEAM TEST, and the reason it drives `store.transact` rather than
    // wrapping `transaction` itself: every other test in this file would pass
    // with the production store never wired to the bridge at all. This one is
    // the only thing that says the scope reaches a real span body.
    const store = await openTestStore(':memory:')
    try {
      const order: string[] = []
      await store.transact(() => {
        postCommit().effect(() => void order.push('effect'), 'e')
        order.push('body')
      })
      expect(order).toEqual(['body', 'effect'])
    } finally {
      store.close()
    }
  })

  it('drops the registered work when the transact body throws', async () => {
    const store = await openTestStore(':memory:')
    try {
      const ran: string[] = []
      expect(() =>
        store.transact(() => {
          postCommit().effect(() => void ran.push('effect'), 'e')
          throw new Error('rolled back')
        }),
      ).toThrow('rolled back')
      expect(ran).toEqual([])
    } finally {
      store.close()
    }
  })
})
