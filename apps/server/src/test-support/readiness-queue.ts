import { expect, vi } from 'vitest'

/**
 * DRIVING THE READINESS QUEUE UNDER FAKE TIMERS (POD-2837, extracted POD-2842).
 *
 * A bound, idle claude-code session does not take a chat send synchronously:
 * the row is queued and typed once the composer has proven it is mounted. Every
 * test that wants to reach the typing has to run the clock forward to get
 * there, and these are the two ways of doing it that are safe to reuse.
 *
 * They were written for `relay.test.ts` and now serve `relay.outbox.test.ts` as
 * well. They live here rather than being copied because a second copy is how
 * the two lanes drifted apart in the first place — see the note above
 * `describe('sendText (chat send path)')` in `relay.test.ts` for the contract
 * they drive.
 */

/**
 * Step the clock, don't jump it: `inbox.ts` polls readiness every 200ms and,
 * for a session whose terminal never paints, has nothing to settle against —
 * so it delivers at the `READY_MAX_MS` ceiling.
 *
 * DELIBERATELY NOT A HARDCODED WAIT. Writing that ceiling down would make every
 * caller re-fail the day POD-2836 anchors the same window to the BIND instead
 * of to the send, which moves WHEN the row is typed and changes nothing about
 * WHAT is typed. The step is smaller than `SUBMIT_CR_DELAY_MS`, so no advance
 * can ever fuse the paste and the submitting CR into one assertion.
 */
export const READY_STEP_MS = 50
export const READY_CEILING_MS = 15_000

/**
 * Run fake time forward in `READY_STEP_MS` steps until `done()` holds. Checked
 * before the first step, so a caller whose fixture has ALREADY driven the clock
 * past the window (`settle`) does not advance one step it did not ask for.
 */
export const advanceUntil = (done: () => boolean, what: string): void => {
  if (done()) return
  for (let waited = 0; waited < READY_CEILING_MS; waited += READY_STEP_MS) {
    vi.advanceTimersByTime(READY_STEP_MS)
    if (done()) return
  }
  throw new Error(`the readiness window closed before ${what}`)
}

/**
 * Run fake time forward until the readiness queue types its head row, and STOP
 * THERE — inside the `SUBMIT_CR_DELAY_MS` window, so the caller can still
 * assert that the submitting CR is a separate, later write. That separation is
 * the POD-152 property these tests exist for, and asserting it is the reason
 * this steps rather than jumping.
 */
export const advanceToComposerReady = (typedCount: () => number): void => {
  const before = typedCount()
  advanceUntil(() => typedCount() > before, 'the queued row reached the PTY')
}

/**
 * THE SUBMITTING CR IS A SEPARATE PTY READ, not merely a separate frame — and
 * this is the assertion POD-152 actually needs. A CR fused to the paste-end
 * marker is swallowed by the Claude renderer: the message types in and the turn
 * never starts.
 *
 * IT NEEDED STRENGTHENING TO SURVIVE THE MOVE, and the weakness was there
 * before it. This fake clock does not run a timer scheduled DURING a tick until
 * the next advance, so "the paste is alone at the moment of delivery" is
 * equally true of a CR sent with no delay at all — mutating
 * `SUBMIT_CR_DELAY_MS` to 0 left every one of these tests green, on the old
 * synchronous shape as much as on this one. One millisecond tells them apart: a
 * zero-delay CR has already landed, a deferred one has not.
 */
export const expectSubmitStillDeferred = (read: () => string[], paste: string): void => {
  expect(read()).toEqual([paste])
  vi.advanceTimersByTime(1)
  expect(read()).toEqual([paste])
}
