// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/protocol'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMarkReadOnView } from './use-mark-read-on-view'

// #138: simply VIEWING a session should clear its unread nag. The explicit
// switch handlers miss the session that's already the open pane (the coordinator
// session the user keeps returning to), so this hook marks the focused+visible
// session read on a trailing debounce keyed on its activity.

function sess(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's1',
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-06T12:00:00.000Z',
    lastActiveAt: '2026-07-06T12:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  } as SessionMeta
}

function Harness(props: {
  session: SessionMeta | undefined
  mark: (id: string) => void
  visible?: () => boolean
}) {
  useMarkReadOnView({
    session: props.session,
    markSessionRead: props.mark,
    delayMs: 1000,
    isVisible: props.visible,
  })
  return null
}

describe('useMarkReadOnView', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('marks a focused UNREAD session read after the debounce', () => {
    const mark = vi.fn()
    render(<Harness session={sess({ unread: true })} mark={mark} />)
    expect(mark).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(mark).toHaveBeenCalledWith('s1')
  })

  it('does nothing for a session that is already read', () => {
    const mark = vi.fn()
    render(<Harness session={sess({ unread: false })} mark={mark} />)
    vi.advanceTimersByTime(5000)
    expect(mark).not.toHaveBeenCalled()
  })

  it('does nothing when there is no focused session', () => {
    const mark = vi.fn()
    render(<Harness session={undefined} mark={mark} />)
    vi.advanceTimersByTime(5000)
    expect(mark).not.toHaveBeenCalled()
  })

  it('defers while the session keeps producing output, then fires once it settles', () => {
    const mark = vi.fn()
    const { rerender } = render(<Harness session={sess({ unread: true })} mark={mark} />)
    vi.advanceTimersByTime(600) // not settled yet
    // New output arrives (lastActiveAt advances) → the debounce restarts.
    rerender(
      <Harness session={sess({ unread: true, lastActiveAt: '2026-07-06T12:00:01.000Z' })} mark={mark} />,
    )
    vi.advanceTimersByTime(600) // 600ms since the restart — still not settled
    expect(mark).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400) // now 1000ms since last activity → fires once
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('does not mark read when the tab is not visible at fire time', () => {
    const mark = vi.fn()
    render(<Harness session={sess({ unread: true })} mark={mark} visible={() => false} />)
    vi.advanceTimersByTime(2000)
    expect(mark).not.toHaveBeenCalled()
  })

  it('cancels the pending mark when focus leaves before it fires', () => {
    const mark = vi.fn()
    const { rerender } = render(<Harness session={sess({ unread: true })} mark={mark} />)
    vi.advanceTimersByTime(500)
    rerender(<Harness session={undefined} mark={mark} />) // switched away
    vi.advanceTimersByTime(2000)
    expect(mark).not.toHaveBeenCalled()
  })

  it('does not undo a manual mark-unread on the focused session (no fresh activity)', () => {
    const mark = vi.fn()
    // Start focused + already read; the initial debounce fires but no-ops (read).
    const { rerender } = render(<Harness session={sess({ unread: false })} mark={mark} />)
    vi.advanceTimersByTime(1000)
    expect(mark).not.toHaveBeenCalled()
    // User marks THIS open session unread — same id + same lastActiveAt, only the
    // flag flips. The debounce must NOT restart (else it'd instantly re-read it).
    rerender(<Harness session={sess({ unread: true })} mark={mark} />)
    vi.advanceTimersByTime(5000)
    expect(mark).not.toHaveBeenCalled()
  })
})
