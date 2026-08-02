/**
 * EVICT IS NOT A DELETION — the guard, and its three failure modes (POD-646).
 *
 * There was no coverage here before, because there was no guard: the page simply
 * stayed mounted on a row that had left. So all three assertions below are about
 * behaviour that has never been protected:
 *
 *  1. it LEAVES when the open issue is unshared while mounted;
 *  2. it does NOT leave for an issue the replica never held — the naive
 *     `if (!found) onBack()` bounces the user off a cold load, which is the
 *     regression this test exists to make impossible;
 *  3. it leaves ONCE, not once per subsequent render — a second navigation is a
 *     bug that only surfaces under a slow route transition.
 *
 * And the negative that matters most: NOTHING about a deletion is rendered. No
 * toast, no tombstone, no "this issue was removed". The rows are gone from the
 * user's view; nobody deleted anything.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IssueViewModel } from '@/app/store'
import { makeIssue } from '@/lib/test-issue'
import { useEvictionGuard } from './use-eviction-guard'

const ISSUE = makeIssue({ id: 'i-open', seq: 3, title: 'Open issue' })

/** The replica rows the mocked store reports, swapped between renders. */
let rows: IssueViewModel[] = []

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => rows,
}))

function Guarded({ onLeave }: { onLeave: () => void }) {
  useEvictionGuard(ISSUE, onLeave)
  return <div data-testid="page">the issue page</div>
}

beforeEach(() => {
  rows = [ISSUE]
})
afterEach(cleanup)

describe('useEvictionGuard', () => {
  it('leaves — silently — when the open issue is unshared while mounted', () => {
    const onLeave = vi.fn()
    const view = render(<Guarded onLeave={onLeave} />)
    expect(onLeave).not.toHaveBeenCalled()

    // The eviction: the row leaves this principal's view. No revision moved.
    act(() => {
      rows = []
      view.rerender(<Guarded onLeave={onLeave} />)
    })

    expect(onLeave).toHaveBeenCalledTimes(1)
    // Nothing announced a deletion, because none happened.
    expect(document.body.textContent).not.toMatch(/delet|removed|no longer exists/i)
  })

  it('does NOT leave for an issue the replica never held', () => {
    // A cold load, a deep link that outran the feed, or a test fixture. Absence
    // is not eviction until presence has been observed.
    rows = []
    const onLeave = vi.fn()
    const view = render(<Guarded onLeave={onLeave} />)
    act(() => {
      view.rerender(<Guarded onLeave={onLeave} />)
    })
    expect(onLeave).not.toHaveBeenCalled()
  })

  it('leaves exactly once, however many renders follow', () => {
    const onLeave = vi.fn()
    const view = render(<Guarded onLeave={onLeave} />)
    act(() => {
      rows = []
      view.rerender(<Guarded onLeave={onLeave} />)
    })
    act(() => {
      view.rerender(<Guarded onLeave={onLeave} />)
      view.rerender(<Guarded onLeave={onLeave} />)
    })
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('does not re-fire when the row comes back and goes again is a NEW arming', () => {
    // A re-grant makes the row present again; a second revoke is a second
    // eviction and the page is already gone by then, so the guard stays fired.
    // Asserted so the ref-based latch is a decision rather than an accident.
    const onLeave = vi.fn()
    const view = render(<Guarded onLeave={onLeave} />)
    act(() => {
      rows = []
      view.rerender(<Guarded onLeave={onLeave} />)
    })
    act(() => {
      rows = [ISSUE]
      view.rerender(<Guarded onLeave={onLeave} />)
      rows = []
      view.rerender(<Guarded onLeave={onLeave} />)
    })
    expect(onLeave).toHaveBeenCalledTimes(1)
  })
})
