import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import type { View } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
// The composer's surface IS the BlurView, the way the tab bar's capsule is —
// a null stub would erase the component under test rather than its blur.
vi.mock('expo-blur', async () => {
  const { View } = await import('react-native')
  return { BlurView: (props: ComponentProps<typeof View>) => <View {...props} /> }
})
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: () => null,
  ClipboardPaste: () => null,
  Paperclip: () => null,
}))

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

  it('renders a below slot outside the well', () => {
    const { container } = render(
      <Composer
        placeholder="Message the agent…"
        onSend={vi.fn()}
        below={<div data-testid="composer-below">rail</div>}
      />,
    )
    const bar = container.querySelector('[data-testid="composer-bar"]')
    const below = container.querySelector('[data-testid="composer-below"]')
    expect(bar).not.toBeNull()
    expect(below).not.toBeNull()
    expect(bar?.contains(below)).toBe(false)
    expect(dockOf(container)?.contains(below)).toBe(true)
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

describe('Composer return key', () => {
  const typeInto = (container: HTMLElement, value: string) => {
    const input = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value } })
    return input
  }

  /**
   * The composer asks `(hover: hover) and (pointer: fine)` once, on mount, to
   * tell a desktop browser from a phone. happy-dom answers every media query
   * `true`, which is the DESKTOP reading — so the touch case has to be stated
   * rather than assumed, and both are pinned here.
   */
  const pointer = (fine: boolean) => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: fine,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('makes a newline on a plain Enter — a soft keyboard has no Shift to reach for', () => {
    pointer(false)
    const onSend = vi.fn()
    const { container } = render(<Composer placeholder="Message…" onSend={onSend} />)
    const input = typeInto(container, 'half a thought')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('still submits on a plain Enter where a real pointer says a real keyboard', () => {
    pointer(true)
    const onSend = vi.fn()
    const { container } = render(<Composer placeholder="Message…" onSend={onSend} />)
    const input = typeInto(container, 'ship it')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('ship it', undefined)
  })

  it('sends on the Cmd chord even on touch, which is the paired-keyboard escape hatch', () => {
    pointer(false)
    const onSend = vi.fn()
    const { container } = render(<Composer placeholder="Message…" onSend={onSend} />)
    const input = typeInto(container, 'ship it')
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenCalledWith('ship it', undefined)
  })

  it('refuses an empty send rather than posting whitespace', () => {
    pointer(true)
    const onSend = vi.fn()
    const { container } = render(<Composer placeholder="Message…" onSend={onSend} />)
    const input = typeInto(container, '   ')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })
})
