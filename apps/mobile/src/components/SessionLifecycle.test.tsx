import type { SessionMeta } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// This lane does not run testing-library's auto-cleanup, so an earlier render
// would otherwise still be in the document when the next test queries it.
afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  // Must RESOLVE: PressableScale calls `impactAsync(...).catch(...)`, so a mock
  // returning undefined throws inside the press handler before onPress runs.
  impactAsync: vi.fn(async () => {}),
}))

const { MobileSessionLifecycle } = await import('./SessionLifecycle')

function session(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 'session-1',
    agentKind: 'claude-code',
    title: 'Session',
    cwd: '/work',
    status: 'live',
    exitCode: undefined,
    spawnFailure: undefined,
    resumable: true,
    ...over,
  } as unknown as SessionMeta
}

describe('mobile session lifecycle surface', () => {
  it('shows the hibernated system note and invokes Resume', async () => {
    const onResume = vi.fn(async () => ({ ok: true as const }))
    render(
      <MobileSessionLifecycle
        session={session({ status: 'hibernated' })}
        hasTranscript
        onResume={onResume}
        onRemove={vi.fn(async () => {})}
      />,
    )

    const notice = screen.getByTestId('hibernated-notice')
    expect(notice.textContent).toContain('Hibernated')
    expect(notice.textContent?.replace(/\s+/g, ' ')).toContain(
      'Its process was stopped to free memory. The conversation is intact.',
    )
    expect(screen.queryByTestId('lifecycle-banner')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume' })))
    expect(onResume).toHaveBeenCalledWith('session-1')
  })

  it('shows the exit outcome as a centred note with the same recovery action', () => {
    render(
      <MobileSessionLifecycle
        session={session({ status: 'exited', exitCode: 1 })}
        hasTranscript
        onResume={vi.fn(async () => ({ ok: true as const }))}
        onRemove={vi.fn(async () => {})}
      />,
    )

    const note = screen.getByTestId('exited-notice')
    expect(note.textContent).toContain('The agent process exited with code 1.')
    expect(getComputedStyle(note).alignItems).toBe('center')
    expect(note.contains(screen.getByRole('button', { name: 'Resume' }))).toBe(true)
    expect(screen.queryByTestId('lifecycle-banner')).toBeNull()
  })

  it('keeps Waking through a fast success until lifecycle sync removes the note', async () => {
    let finish: ((result: { ok: true }) => void) | undefined
    const onResume = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve
        }),
    )
    const { rerender } = render(
      <MobileSessionLifecycle
        session={session({ status: 'hibernated' })}
        hasTranscript
        onResume={onResume}
        onRemove={vi.fn(async () => {})}
      />,
    )

    const button = screen.getByRole('button', { name: 'Resume' })
    fireEvent.click(button)
    expect(button.textContent).toBe('Waking…')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(onResume).toHaveBeenCalledTimes(1)
    await act(async () => finish?.({ ok: true }))
    expect(button.textContent).toBe('Waking…')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    rerender(
      <MobileSessionLifecycle
        session={session({ status: 'live' })}
        hasTranscript
        onResume={onResume}
        onRemove={vi.fn(async () => {})}
      />,
    )
    expect(screen.queryByTestId('hibernated-notice')).toBeNull()
    expect(screen.queryByTestId('lifecycle-banner')).toBeNull()
  })

  it('replaces Waking with the exit outcome even before the wake request settles', async () => {
    let finish: ((result: { ok: true }) => void) | undefined
    const onResume = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve
        }),
    )
    const props = { hasTranscript: true, onResume, onRemove: vi.fn(async () => {}) }
    const { rerender } = render(
      <MobileSessionLifecycle {...props} session={session({ status: 'hibernated' })} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(screen.getByText('Waking…')).toBeTruthy()
    rerender(
      <MobileSessionLifecycle {...props} session={session({ status: 'exited', exitCode: 1 })} />,
    )
    expect(screen.queryByText('Waking…')).toBeNull()
    expect(screen.getByTestId('exited-notice').textContent).toContain('exited with code 1')
    expect(screen.getByRole('button', { name: 'Resume' }).getAttribute('aria-disabled')).not.toBe(
      'true',
    )
    await act(async () => finish?.({ ok: true }))
    expect(screen.queryByText('Waking…')).toBeNull()
  })

  it.each([
    [{ agentKind: 'shell', resumable: false }, 'Restart'],
    [{ resumable: false, neverBound: true }, 'Start again'],
    [{ resumable: false }, 'Remove'],
  ] as const)('keeps the existing exited recovery action for %o', (over, label) => {
    render(
      <MobileSessionLifecycle
        session={session({ status: 'exited', ...over })}
        hasTranscript
        onResume={vi.fn(async () => ({ ok: true as const }))}
        onRemove={vi.fn(async () => {})}
      />,
    )
    expect(
      screen.getByTestId('exited-notice').contains(screen.getByRole('button', { name: label })),
    ).toBe(true)
    expect(screen.queryByTestId('lifecycle-banner')).toBeNull()
  })

  it('ends resuming when another exit arrives without an observed starting frame', async () => {
    const props = {
      hasTranscript: true,
      onResume: vi.fn(async () => ({ ok: true as const })),
      onRemove: vi.fn(async () => {}),
    }
    const before = session({ status: 'exited', exitCode: 1, stoppedAt: '2026-11-13T06:00:00Z' })
    const { rerender } = render(<MobileSessionLifecycle {...props} session={before} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume' })))
    expect(screen.getByText('Resuming…')).toBeTruthy()
    rerender(
      <MobileSessionLifecycle
        {...props}
        session={{ ...before, stoppedAt: '2026-11-13T06:00:10Z' }}
      />,
    )
    expect(screen.queryByText('Resuming…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Resume' }).getAttribute('aria-disabled')).not.toBe(
      'true',
    )
  })

  it.each([
    'hibernated',
    'exited',
  ] as const)('keeps a failed %s resume visible and retryable', async (status) => {
    const onResume = vi.fn(async () => ({ ok: false as const, reason: 'process still running' }))
    render(
      <MobileSessionLifecycle
        session={session({ status })}
        hasTranscript
        onResume={onResume}
        onRemove={vi.fn(async () => {})}
      />,
    )

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume' })))
    expect(screen.getByTestId('lifecycle-error').textContent).toContain('process still running')
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
  })

  it('uses the recovery pane for a shell without a transcript', () => {
    render(
      <MobileSessionLifecycle
        session={session({ agentKind: 'shell', status: 'exited', resumable: false })}
        hasTranscript={false}
        onResume={vi.fn(async () => ({ ok: true as const }))}
        onRemove={vi.fn(async () => {})}
      />,
    )

    expect(screen.getByTestId('lifecycle-pane')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart shell' })).toBeTruthy()
  })
})
