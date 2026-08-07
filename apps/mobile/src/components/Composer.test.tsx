import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
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

  it('appends a keyed transcript quote without replacing the current draft', () => {
    const { container, rerender } = render(
      <Composer placeholder="Message the agent…" onSend={vi.fn()} draftInsertion={null} />,
    )
    const input = container.querySelector('textarea')
    expect(input).not.toBeNull()
    if (!input) return
    fireEvent.change(input, { target: { value: 'My note' } })

    rerender(
      <Composer
        placeholder="Message the agent…"
        onSend={vi.fn()}
        draftInsertion={{ id: 1, text: '> quoted\n\n' }}
      />,
    )

    expect(input.value).toBe('My note\n> quoted\n\n')
  })
})

describe('Composer floating dock', () => {
  const dockOf = (container: HTMLElement) =>
    (container.querySelector('[data-testid="composer-bar"]')?.parentElement ??
      null) as HTMLElement | null

  it('pays the bottom safe area when nothing else is below it', () => {
    const { container } = render(<Composer placeholder="Message the agent…" onSend={vi.fn()} />)
    // 34 of home indicator plus the 8 the surface floats above it.
    expect(dockOf(container)?.style.paddingBottom).toBe('42px')
  })

  it('lets chrome below it replace that inset rather than stacking on it', () => {
    // The tab bar's measured inset already contains the safe area [POD-420];
    // adding the composer's own would float it a home-indicator too high.
    const { container } = render(
      <Composer placeholder="Message the agent…" onSend={vi.fn()} bottomInset={72} />,
    )
    expect(dockOf(container)?.style.paddingBottom).toBe('80px')
  })

  it('drops no glyph in front of the text field', () => {
    const { container } = render(<Composer placeholder="Message the agent…" onSend={vi.fn()} />)
    expect(container.textContent).not.toContain('>')
  })
})
