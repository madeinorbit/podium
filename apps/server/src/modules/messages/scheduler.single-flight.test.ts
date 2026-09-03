import { asIssueId, asThreadId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../store/types'
import { DeliveryScheduler } from './scheduler'

/**
 * THE HOLE THIS PINS (POD-3258). The retry backstop used to fence on
 * `retryBackstopTimer`, which is set only in the GAP between one page and the
 * next — `runRetryBackstopPage` nulls it on entry. So for the whole of every
 * page body the fence was open, and the pass was protected only by the page
 * running to completion in one synchronous turn. Re-entering from inside
 * `attemptOne` is that open window, and it is where an awaited store call will
 * park once the store is async.
 *
 * `listQueuedPage` is the count that matters: it is the first thing a pass does.
 */
describe('DeliveryScheduler.sweep single-flight (POD-3258)', () => {
  const row = (id: string): MessageRow => ({
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: asIssueId('iss_1'),
    toKind: 'issue',
    toId: 'iss_1',
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: 'hello',
    expiresAt: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    status: 'queued',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
  })

  function harness() {
    let listQueuedPageCalls = 0
    let onAttempt: () => void = () => {}
    const scheduler = new DeliveryScheduler({
      messages: {
        countPending: () => 0,
        countQueued: () => 1,
        listQueuedPage: () => {
          listQueuedPageCalls += 1
          return [row('msg_1')]
        },
        pendingForPage: () => [],
      },
      now: () => '2026-07-13T00:00:00.000Z',
      runner: {
        targetOf: () => null,
        drainPreferred: () => [],
        attemptOne: () => onAttempt(),
        nowMs: () => 1_000_000,
      },
    })
    return {
      scheduler,
      calls: () => listQueuedPageCalls,
      setOnAttempt: (fn: () => void) => {
        onAttempt = fn
      },
    }
  }

  it('skips a sweep that lands mid-page on a pass already running', () => {
    const h = harness()
    let reentered = false
    h.setOnAttempt(() => {
      if (reentered) return
      reentered = true
      h.scheduler.sweep()
    })

    h.scheduler.sweep()

    expect(reentered).toBe(true)
    expect(h.calls()).toBe(1)
    h.scheduler.dispose()
  })

  it('a later, non-overlapping sweep runs normally', () => {
    const h = harness()
    h.scheduler.sweep()
    h.scheduler.sweep()
    expect(h.calls()).toBe(2)
    h.scheduler.dispose()
  })

  it('a failed page query releases the fence rather than wedging the backstop', () => {
    let calls = 0
    const scheduler = new DeliveryScheduler({
      messages: {
        countPending: () => 0,
        countQueued: () => 1,
        listQueuedPage: () => {
          calls += 1
          throw new Error('store is gone')
        },
        pendingForPage: () => [],
      },
      now: () => '2026-07-13T00:00:00.000Z',
      runner: {
        targetOf: () => null,
        drainPreferred: () => [],
        attemptOne: () => {},
        nowMs: () => 1_000_000,
      },
    })

    scheduler.sweep()
    scheduler.sweep()

    expect(calls).toBe(2)
    scheduler.dispose()
  })
})
