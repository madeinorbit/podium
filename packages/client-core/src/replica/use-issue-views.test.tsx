// @vitest-environment happy-dom
/**
 * The binding-level half of the POD-794 event-semantics pin.
 *
 * `issue-views.test.ts` proves the DERIVATION moves when a session changes. That
 * is necessary and not sufficient: the derivation can be perfect while the
 * binding never re-runs it. A child change emits ZERO events on the parent row,
 * so a component subscribed only to the issue collection renders a correct
 * `unread` exactly once and then freezes — no error, no warning, and the bug is
 * invisible until a user asks why the dot never went away.
 *
 * So these tests drive REAL React renders and count them.
 */

import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createReplica, memoryStorage } from './replica'
import { useIssueView, useIssueViews } from './use-issue-views'

const issueRow = (over: Record<string, unknown> = {}) =>
  ({ id: 'i1', seq: 13, prefix: 'POD', stage: 'in_progress', readAt: null, ...over }) as never
const sessionRow = (over: Record<string, unknown> = {}) =>
  ({ sessionId: 's1', issueId: 'i1', phase: 'idle', ...over }) as never

function makeReplica() {
  const replica = createReplica({ storage: memoryStorage() })
  replica.applySnapshot('issues', [issueRow()])
  replica.applySnapshot('sessions', [sessionRow({ lastActiveAt: '2026-07-17T09:00:00.000Z' })])
  return replica
}

describe('useIssueView — a SESSION change must reach an ISSUE view', () => {
  it('re-renders the issue when one of its sessions changes', () => {
    // THE test. Subscribing only to `issues` passes every other assertion in
    // this file and fails this one.
    const replica = makeReplica()
    replica.applySnapshot('issues', [issueRow({ readAt: '2026-07-17T10:00:00.000Z' })])

    function Probe() {
      const { rollups } = useIssueView(replica, 'i1')
      return <span data-testid="unread">{String(rollups.unread)}</span>
    }
    render(<Probe />)
    expect(screen.getByTestId('unread').textContent).toBe('false')

    // The session speaks, after the issue was last read.
    act(() => {
      replica.applyChanges(
        'sessions',
        [sessionRow({ lastActiveAt: '2026-07-17T11:00:00.000Z' })],
        [],
      )
    })
    expect(screen.getByTestId('unread').textContent).toBe('true')
  })

  it('re-renders when a session re-homes to another issue', () => {
    // Membership is derived from `session.issueId`, so a re-home is a SESSION
    // change that must move TWO issues' views. Nothing about the issue rows moved.
    const replica = makeReplica()
    function Probe() {
      const { view } = useIssueView(replica, 'i1')
      return <span data-testid="members">{(view?.memberSessionIds ?? []).join(',')}</span>
    }
    render(<Probe />)
    expect(screen.getByTestId('members').textContent).toBe('s1')

    act(() => {
      replica.applyChanges('sessions', [sessionRow({ issueId: 'i2' })], [])
    })
    expect(screen.getByTestId('members').textContent).toBe('')
  })

  it('re-renders on an ISSUE change too', () => {
    const replica = makeReplica()
    function Probe() {
      const { view } = useIssueView(replica, 'i1')
      return <span data-testid="ref">{view?.displayRef ?? '-'}</span>
    }
    render(<Probe />)
    expect(screen.getByTestId('ref').textContent).toBe('POD-13')

    act(() => {
      replica.applyChanges('issues', [issueRow({ seq: 99 })], [])
    })
    expect(screen.getByTestId('ref').textContent).toBe('POD-99')
  })
})

describe('useIssueViews — snapshot stability', () => {
  it('does not re-render when nothing changed', () => {
    // getSnapshot runs on every render and must return the SAME reference for
    // the same state; an unstable snapshot re-renders forever rather than
    // merely being slow, so this is a correctness test wearing a perf hat.
    const replica = makeReplica()
    let renders = 0
    function Probe() {
      renders++
      const snapshot = useIssueViews(replica)
      return <span data-testid="count">{snapshot.views.size}</span>
    }
    const { rerender } = render(<Probe />)
    const before = renders
    rerender(<Probe />)
    rerender(<Probe />)
    expect(screen.getByTestId('count').textContent).toBe('1')
    // Parent re-renders pass through; what must NOT happen is a self-sustaining
    // loop from an unstable snapshot.
    expect(renders - before).toBe(2)
  })

  it('a whole multi-kind application wakes the binding ONCE, against the final state', () => {
    // subscribeRows coalesces per application; a binding that saw the transient
    // half-applied state is exactly what yanked the engine's worktree selection
    // once (#262).
    const replica = makeReplica()
    let renders = 0
    function Probe() {
      renders++
      const snapshot = useIssueViews(replica)
      return <span data-testid="ids">{[...snapshot.views.keys()].join(',')}</span>
    }
    render(<Probe />)
    const before = renders

    act(() => {
      replica.batch(() => {
        replica.applySnapshot('issues', [issueRow(), issueRow({ id: 'i2', seq: 14 })])
        replica.applySnapshot('sessions', [sessionRow({ issueId: 'i2' })])
      })
    })
    expect(screen.getByTestId('ids').textContent).toBe('i1,i2')
    expect(renders - before).toBe(1)
  })
})
