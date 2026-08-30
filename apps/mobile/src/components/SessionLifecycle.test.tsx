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
  it('shows the parked banner and invokes Resume', async () => {
    const onResume = vi.fn(async () => ({ ok: true as const }))
    render(
      <MobileSessionLifecycle
        session={session({ status: 'hibernated' })}
        hasTranscript
        onResume={onResume}
        onRemove={vi.fn(async () => {})}
      />,
    )

    const banner = screen.getByTestId('lifecycle-banner')
    expect(banner.textContent).toContain('Hibernated — transcript is read-only until you resume.')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume' })))
    expect(onResume).toHaveBeenCalledWith('session-1')
  })

  // THE STATE BAR SPENDS NO SIGNAL (POD-1251, matching web's POD-747): a parked
  // or ended session is reporting a state, not asking for anything, so the bar
  // takes the chrome ground and neither the bisque that means "waiting on you"
  // nor the red that means destruction may appear as a fill.
  it.each([
    ['hibernated', 'parked'],
    ['exited', 'ended'],
  ] as const)('paints the %s bar in chrome, not in a signal fill', (status, _word) => {
    render(
      <MobileSessionLifecycle
        session={session({ status })}
        hasTranscript
        onResume={vi.fn(async () => ({ ok: true as const }))}
        onRemove={vi.fn(async () => {})}
      />,
    )

    const ground = getComputedStyle(screen.getByTestId('lifecycle-banner')).backgroundColor
    expect(ground).toBe('rgba(27, 29, 33, 1.00)') // color.bar
  })

  it('keeps a failed resume visible and retryable', async () => {
    const onResume = vi.fn(async () => ({ ok: false as const, reason: 'process still running' }))
    render(
      <MobileSessionLifecycle
        session={session({ status: 'exited' })}
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
