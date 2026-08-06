import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-blur', () => ({ BlurView: () => null }))
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
}))
vi.mock('lucide-react-native', () => ({ ArrowUp: () => null }))

const { Composer } = await import('./Composer')

describe('Composer activity caption', () => {
  it('shares the composer bar and disappears without reserving a row', () => {
    const { rerender } = render(
      <Composer placeholder="Message the agent…" onSend={vi.fn()} caption="working" />,
    )

    const bar = screen.getByTestId('composer-bar')
    expect(screen.getByTestId('composer-caption').parentElement).toBe(bar)
    expect(screen.getByTestId('composer-caption').textContent).toBe('working')

    rerender(<Composer placeholder="Message the agent…" onSend={vi.fn()} caption={null} />)
    expect(screen.queryByTestId('composer-caption')).toBeNull()
  })
})
