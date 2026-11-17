import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const metrics = vi.hoisted(() => ({ scale: 1 }))
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      OS: 'ios',
      select: (options: Record<string, unknown>) => options.ios ?? options.default,
    },
    useWindowDimensions: () => ({ width: 320, height: 568, fontScale: metrics.scale, scale: 2 }),
  }
})
vi.mock('../RefChip', () => ({ RefChip: () => null }))
vi.mock('../../lib/podium-link', () => ({ followPodiumLink: vi.fn() }))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))

import { RichMarkdown } from '../RichMarkdown'

afterEach(() => {
  cleanup()
  metrics.scale = 1
})

it('remeasures paragraph and list blocks through AX5 and back without retaining fixed native line metrics', () => {
  const text =
    'The sheet passes when **every section** reads at AX5 and the [desktop inspector](https://example.com) matches.\n\n- Whole words at AX5\n- No clipped text'
  const view = render(<RichMarkdown text={text} />)
  const initialParagraph = screen.getByText('every section').closest('[dir="auto"]')!
  const root = view.container.firstElementChild!
  // A paragraph and a list are adjacent blocks. Neither creates a spacer.
  expect(root.childElementCount).toBe(2)
  const paragraphBlock = root.firstElementChild as HTMLElement
  expect(parseFloat(getComputedStyle(paragraphBlock).marginBottom)).toBeLessThanOrEqual(4)
  expect((paragraphBlock.firstElementChild as HTMLElement).style.lineHeight).toBe('')
  metrics.scale = 3.12
  view.rerender(<RichMarkdown text={text} />)
  expect(view.container.firstElementChild).not.toBe(root)
  expect(screen.getByText('every section').closest('[dir="auto"]')).not.toBe(initialParagraph)
  expect(view.container.textContent).toContain('Whole words at AX5')
  expect((screen.getAllByText('•')[0] as HTMLElement).style.width).toBe('74.88px')
  const axRoot = view.container.firstElementChild!
  metrics.scale = 1
  view.rerender(<RichMarkdown text={text} />)
  expect(view.container.firstElementChild).not.toBe(axRoot)
  expect(view.container.firstElementChild?.childElementCount).toBe(2)
  expect(screen.getByText('No clipped text')).toBeTruthy()
})

it('keeps AX5 numbered-list markers on one line with a scaled, non-shrinking gutter', () => {
  metrics.scale = 3.12
  render(<RichMarkdown text={'1. A numbered item\n2. Another item'} />)
  const marker = screen.getByText('1.')
  expect(['pre', 'nowrap']).toContain(getComputedStyle(marker).whiteSpace)
  expect((marker as HTMLElement).style.width).toBe('74.88px')
  expect(getComputedStyle(marker).flexShrink).toBe('0')
})
