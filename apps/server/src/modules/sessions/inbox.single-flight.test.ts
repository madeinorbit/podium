import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  harnessComposerReadiness,
  harnessDisplayName,
  harnessInterrupt,
  harnessNeedsSubmitVerification,
  harnessUsesRawFirstTurn,
} from '../../harness-manifest'
import { SessionInbox } from './inbox'

/**
 * THE OUTER FENCE, OVER THE PER-SESSION ONE (POD-3258). `drain` is already
 * single-flight per session through `activeDrains`, so an overlapping sweep
 * could never double-deliver a row even without this guard. What is unfenced is
 * the ENUMERATION: `sessionsWithPending` is a store read, and once it awaits a
 * second tick walks the same durable queue again to reach a fan-out that will
 * refuse every entry.
 *
 * So the probe re-enters from inside `sessionsWithPending` — the sweep's own
 * store read — and the count that matters is how many times it is asked.
 */
describe('SessionInbox.sweepQueuedInputs single-flight (POD-3258)', () => {
  function harness() {
    let sessionsWithPendingCalls = 0
    let onEnumerate: () => Promise<void> = async () => {}
    const inbox = new SessionInbox({
      // No live sessions: `drain` returns at its own door, so this test is about
      // the enumeration and nothing downstream of it.
      getSession: () => undefined,
      queue: {
        enqueue: async () => true,
        list: async () => [],
        bumpAttempts: async () => {},
        resetAttempts: async () => {},
        delete: async () => {},
        sessionsWithPending: async () => {
          sessionsWithPendingCalls += 1
          await onEnumerate()
          return [asSessionId('session-a'), asSessionId('session-b')]
        },
      },
      daemon: { sendInput: () => {} },
      authorization: {
        authorizeAtDrain: async () => ({ ok: true }) as const,
        applied: vi.fn(async () => {}),
        injected: vi.fn(async () => {}),
        interrupted: vi.fn(async () => {}),
        interruptedPending: vi.fn(async () => {}),
        rejected: vi.fn(async () => {}),
      },
      attention: {
        stateChanged: vi.fn(),
        answered: vi.fn(),
        promptFailed: vi.fn(),
      },
      now: () => Date.now(),
      persist: vi.fn(async () => {}),
      // The draft seam [POD-3330]: a real `write` applies the mutation to a
      // draft and installs it on the session when the commit returns, so the
      // in-memory effect a fixture has to reproduce is the mutation landing.
      write: async (session, mutate) => mutate(session as never),
      draft: (session) => ({ ...session }) as never,
      persistDraft: vi.fn(async () => {}),
      broadcast: vi.fn(),
      needsSubmitVerification: harnessNeedsSubmitVerification,
      usesRawFirstTurn: harnessUsesRawFirstTurn,
      composerReadiness: harnessComposerReadiness,
      harnessInterrupt,
      harnessName: harnessDisplayName,
      prepareSend: vi.fn(),
      ownerOf: async () => null,
      resurrect: vi.fn(),
    })
    return {
      inbox,
      calls: () => sessionsWithPendingCalls,
      setOnEnumerate: (fn: () => Promise<void>) => {
        onEnumerate = fn
      },
    }
  }

  it('skips a sweep that lands on a sweep already running', async () => {
    const h = harness()
    let reentered = false
    h.setOnEnumerate(async () => {
      if (reentered) return
      reentered = true
      await h.inbox.sweepQueuedInputs()
    })

    await h.inbox.sweepQueuedInputs()

    expect(reentered).toBe(true)
    expect(h.calls()).toBe(1)
  })

  it('a later, non-overlapping sweep runs normally', async () => {
    const h = harness()
    await h.inbox.sweepQueuedInputs()
    await h.inbox.sweepQueuedInputs()
    expect(h.calls()).toBe(2)
  })
})
