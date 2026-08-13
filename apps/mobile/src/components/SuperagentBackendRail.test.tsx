import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: () => null,
  Cpu: () => null,
  Gauge: () => null,
}))
vi.mock('./BottomSheet', () => ({
  BottomSheet: ({
    visible,
    children,
    head,
  }: {
    visible: boolean
    children: ReactNode
    head?: ReactNode
  }) =>
    visible ? (
      <div>
        {head}
        {children}
      </div>
    ) : null,
}))

const { SuperagentBackendRail } = await import('./SuperagentBackendRail')

describe('SuperagentBackendRail', () => {
  it('is quiet Auto and hides effort until a connector is pinned', () => {
    render(
      <SuperagentBackendRail
        backend={{ agentKind: undefined, model: 'auto', effort: 'auto' }}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />,
    )
    expect(screen.getByTestId('composer-backend')).toBeTruthy()
    expect(screen.getByLabelText('Model').textContent).toContain('Auto')
    expect(screen.queryByLabelText('Effort')).toBeNull()
  })

  it('shows the stored model and effort once a harness is pinned', () => {
    render(
      <SuperagentBackendRail
        backend={{ agentKind: 'claude-code', model: 'opus', effort: 'high' }}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />,
    )
    expect(screen.getByLabelText('Model').textContent).toContain('Opus')
    expect(screen.getByLabelText('Effort').textContent).toContain('High')
  })

  it('picks a model from another connector in one tap', () => {
    const onModelChange = vi.fn()
    render(
      <SuperagentBackendRail
        backend={{ agentKind: undefined, model: 'auto', effort: 'auto' }}
        onModelChange={onModelChange}
        onEffortChange={() => {}}
      />,
    )
    fireEvent.click(screen.getByLabelText('Model'))
    fireEvent.click(screen.getByLabelText('Claude Code Opus'))
    expect(onModelChange).toHaveBeenCalledWith('opus', 'claude-code')
  })
})
