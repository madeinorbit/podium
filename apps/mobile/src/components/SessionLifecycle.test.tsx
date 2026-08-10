import type { SessionMeta } from '@podium/model'
import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
}))
vi.mock('lucide-react-native', () => ({
  Moon: () => null,
  RotateCcw: () => null,
}))

const { SessionLifecycle } = await import('./SessionLifecycle')

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
      <SessionLifecycle
        session={session({ status: 'hibernated' })}
        hasTranscript
        onResume={onResume}
        onRemove={vi.fn(async () => {})}
      />,
    )

    expect(screen.getByText('Hibernated — transcript is read-only until you resume.')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume' })))
    expect(onResume).toHaveBeenCalledWith('session-1')
  })

  it('keeps a failed resume visible and retryable', async () => {
    const onResume = vi.fn(async () => ({ ok: false as const, reason: 'process still running' }))
    render(
      <SessionLifecycle
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
      <SessionLifecycle
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
