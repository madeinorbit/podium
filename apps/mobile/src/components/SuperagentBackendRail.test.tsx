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

// The rail offers only what a machine reported (POD-3911); these tests hand it
// a live Claude list rather than relying on the bundled one.
const LIVE = { 'claude-code': [{ value: 'opus', label: 'Opus', efforts: ['low', 'high'] }] }

describe('SuperagentBackendRail', () => {
  it('is quiet Auto with an inert effort pill before a connector is pinned', () => {
    render(
      <SuperagentBackendRail
        backend={{ agentKind: undefined, model: 'auto', effort: 'auto' }}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />,
    )
    expect(screen.getByTestId('composer-backend')).toBeTruthy()
    expect(screen.getByLabelText('Model').textContent).toContain('Auto')
    expect(screen.getByLabelText('Effort').textContent).toContain('Auto')
    expect(screen.getByLabelText('Effort').getAttribute('aria-disabled')).toBe('true')
  })

  it('shows the stored model and effort once a harness is pinned', () => {
    render(
      <SuperagentBackendRail
        backend={{ agentKind: 'claude-code', model: 'opus', effort: 'high' }}
        modelCatalog={LIVE}
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
        modelCatalog={LIVE}
        onModelChange={onModelChange}
        onEffortChange={() => {}}
      />,
    )
    fireEvent.click(screen.getByLabelText('Model'))
    fireEvent.click(screen.getByLabelText('Claude Code Opus'))
    expect(onModelChange).toHaveBeenCalledWith('opus', 'claude-code')
  })

  it('renders the live machine catalog instead of the fallback list', () => {
    render(
      <SuperagentBackendRail
        backend={{ agentKind: undefined, model: 'auto', effort: 'auto' }}
        modelCatalog={{
          codex: [{ value: 'gpt-next', label: 'GPT Next', efforts: ['high'] }],
        }}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />,
    )
    fireEvent.click(screen.getByLabelText('Model'))
    expect(screen.getByLabelText('Codex GPT Next')).toBeTruthy()
    expect(screen.queryByLabelText('Codex GPT-5.6-Sol')).toBeNull()
  })
})


it('shows stored effort inert when the concrete model has no reported levels', () => {
  render(<SuperagentBackendRail backend={{ agentKind: 'claude-code', model: 'unlisted', effort: 'high' }}
    modelCatalog={LIVE} onModelChange={vi.fn()} onEffortChange={vi.fn()} />)
  expect(screen.getByLabelText('Effort').textContent).toContain('High')
  expect(screen.getByLabelText('Effort').getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(screen.getByLabelText('Effort'))
  expect(screen.queryByLabelText('High')).toBeNull()
})

it('offers only live rows and no Use option', () => {
  render(<SuperagentBackendRail backend={{ agentKind: 'claude-code', model: 'auto', effort: 'auto' }}
    modelCatalog={LIVE} onModelChange={vi.fn()} onEffortChange={vi.fn()} />)
  fireEvent.click(screen.getByLabelText('Model'))
  expect(screen.getByLabelText('Auto')).toBeTruthy()
  expect(screen.getByLabelText('Claude Code Opus')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByLabelText(/Use /)).toBeNull()
})
