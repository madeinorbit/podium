import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { View as RNView } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const animation = vi.hoisted(() => ({
  cancelAnimation: vi.fn(),
  makeMutable: vi.fn(),
  useAnimatedProps: vi.fn(),
  withRepeat: vi.fn(),
  withTiming: vi.fn(),
}))
vi.mock('react-native-reanimated', () => ({
  ...animation,
  default: { createAnimatedComponent: (component: unknown) => component },
}))

// This lane cannot parse react-native-svg's Flow entry. Record the drawing
// contract while leaving the native mark's geometry and lifecycle intact.
const drawn: Record<string, unknown>[] = []
const cells: Record<string, unknown>[] = []
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children, ...props }: ComponentProps<typeof RNView>) => {
    cells.push(props as Record<string, unknown>)
    return <View>{children}</View>
  }
  const Circle = (props: Record<string, unknown>) => {
    drawn.push(props)
    return null
  }
  return { default: Svg, Svg, Circle }
})

const { WorkingMark } = await import('./WorkingMark.native')

describe('WorkingMark', () => {
  beforeEach(() => {
    drawn.length = 0
    cells.length = 0
    vi.clearAllMocks()
  })
  afterEach(cleanup)

  it('draws a fully lit braille cell: two columns of four', () => {
    render(<WorkingMark size={12} />)
    expect(drawn.map((dot) => [dot.cx, dot.cy])).toEqual([
      [17, 18],
      [49, 18],
      [17, 39],
      [49, 39],
      [17, 61],
      [49, 61],
      [17, 82],
      [49, 82],
    ])
    for (const dot of drawn) {
      expect(dot.opacity).toBeUndefined()
      expect(dot.animatedProps).toBeUndefined()
    }
  })

  it.each([
    [24, 9.5],
    [18, 9.5],
    [15, 10.5],
    [14, 10.5],
    [12, 11],
    [7, 11],
  ])('fattens the dots as the cell shrinks (%spx tall → r %s)', (size, radius) => {
    render(<WorkingMark size={size} />)
    for (const dot of drawn) expect(dot.r).toBe(radius)
  })

  it.each([
    [24, 16],
    [12, 8],
    [11, 7],
    [7, 5],
  ])('keeps the 66:100 cell at every size (%spx tall → %spx wide)', (size, width) => {
    render(<WorkingMark size={size} />)
    expect(cells).toHaveLength(1)
    expect(cells[0].viewBox).toBe('0 0 66 100')
    expect(cells[0].width).toBe(width)
    expect(cells[0].height).toBe(size)
  })

  it('announces itself unless adjacent text already owns the label', () => {
    const { rerender } = render(<WorkingMark label="Verifying" />)
    expect(cells.at(-1)?.accessibilityRole).toBe('progressbar')
    expect(cells.at(-1)?.accessibilityLabel).toBe('Verifying')
    rerender(<WorkingMark label={null} />)
    expect(cells.at(-1)?.accessibilityRole).toBe('none')
    expect(cells.at(-1)?.accessibilityLabel).toBeUndefined()
  })

  it('paints the reserved working blue and retints on request', () => {
    const { rerender } = render(<WorkingMark />)
    expect(new Set(drawn.map((dot) => dot.fill))).toEqual(new Set(['#6f9dff']))
    drawn.length = 0
    rerender(<WorkingMark tint="#ffffff" />)
    expect(new Set(drawn.map((dot) => dot.fill))).toEqual(new Set(['#ffffff']))
  })

  it('mounting and unmounting multiple marks schedules no UI-runtime animation', () => {
    const { unmount } = render(
      <>
        <WorkingMark />
        <WorkingMark size={18} />
      </>,
    )
    unmount()
    for (const callback of Object.values(animation)) expect(callback).not.toHaveBeenCalled()
  })
})
