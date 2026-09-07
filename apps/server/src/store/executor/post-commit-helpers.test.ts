import { describe, expect, it } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { afterCommit, followUpAfterCommit, postCommit } from './executor'

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
  })
})

describe('the store seam', () => {
  it('opens a post-commit scope for every SessionStore.transact body', async () => {
    // THE SEAM TEST, and the reason it drives `store.transact` rather than
    // calling the executor directly: every other test in this file would pass
    // with the production store never wired to the executor at all. This one is
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
      await store.close()
    }
  })

  it('drops the registered work when the transact body throws', async () => {
    const store = await openTestStore(':memory:')
    try {
      const ran: string[] = []
      await expect(
        store.transact(() => {
          postCommit().effect(() => void ran.push('effect'), 'e')
          throw new Error('rolled back')
        }),
      ).rejects.toThrow('rolled back')
      expect(ran).toEqual([])
    } finally {
      await store.close()
    }
  })
})

/**
 * THE DURABLE FOLLOW-UP (mechanism 2), pinned because merge-steps section 2
 * asked for exactly this and nothing supplied it.
 *
 * Section 2 left one decision open: a mechanism-2 step is async by design
 * (POD-3467), and the question was whether `followUpAfterCommit` must AWAIT it
 * inline or only REGISTER it. The answer differs by path, so both are pinned
 * here, and section 2's own acceptance test is the first one — it fails when
 * the await is removed. Both assert an ORDER for the reason this file's header
 * gives: "the step ran" is true in every implementation, including the ones
 * that are wrong.
 */
describe('followUpAfterCommit', () => {
  it('awaits the step when there is no span, so the caller resumes after it finished', async () => {
    // The caller here is already on the far side of its commit, so the step
    // runs now — and "now" has to mean RUN TO COMPLETION. Without the await the
    // caller's next line wins the race and it has been told a durable follow-up
    // landed while it is still in flight. This is the test section 2 asked to
    // pin the decision with: change `await step()` to `void step()` and the
    // recorded order inverts.
    // The step crosses a MACROTASK, and that is load-bearing rather than
    // incidental. `followUpAfterCommit` is an async function either way, so an
    // unawaited step still gets every microtask the caller's own resumption
    // yields — a step that only awaited a resolved promise finished first even
    // when nobody awaited it, and this test passed against its own mutation.
    // A timer cannot be jumped by microtask slack, so the order inverts.
    const order: string[] = []
    await followUpAfterCommit(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      order.push('follow-up')
    }, 'ready-fanout')
    order.push('caller resumed')
    expect(order).toEqual(['follow-up', 'caller resumed'])
  })

  it('reports a no-span failure to the caller as a committed follow-up failure', async () => {
    // The guarantee the wrapper carries: the original write COMMITTED and must
    // not be retried, but its follow-up did not land and the caller has to hear
    // so. Unawaited this rejects nobody and surfaces as an unhandled rejection
    // instead, which is why this is a second, independent pin on the await.
    await expect(
      followUpAfterCommit(async () => {
        throw new Error('fanout failed')
      }, 'ready-fanout'),
    ).rejects.toThrow('durable follow-up "ready-fanout" failed after the transaction committed')
  })

  it('only registers inside a span, so the step runs after the commit', async () => {
    // The other half of the decision. Inside a span the step must NOT run
    // inline: a rollback has to discard it, and a commit drains it afterwards.
    // Asserted as an order against the body, so a version that ran the step
    // eagerly fails here rather than passing for the wrong reason.
    const store = await openTestStore(':memory:')
    try {
      const order: string[] = []
      await store.transact(async () => {
        await followUpAfterCommit(async () => void order.push('follow-up'), 'ready-fanout')
        order.push('body')
      })
      expect(order).toEqual(['body', 'follow-up'])
    } finally {
      await store.close()
    }
  })
})
