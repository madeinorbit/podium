import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ReducedMotionProvider } from './ReducedMotionProvider.native'
import { useReduceMotion } from './useReduceMotion'

const accessibility = vi.hoisted(() => ({ addEventListener: vi.fn() }))
const reanimated = vi.hoisted(() => ({ modes: [] as string[], cleanups: vi.fn() }))

vi.mock('react-native', () => ({ AccessibilityInfo: accessibility }))
vi.mock('react-native-reanimated', async () => {
  const React = await import('react')
  return {
    ReduceMotion: { Always: 'always', Never: 'never' },
    ReducedMotionConfig: ({ mode }: { mode: string }) => {
      React.useEffect(() => {
        reanimated.modes.push(mode)
        return reanimated.cleanups
      }, [mode])
      return null
    },
    useReducedMotion: () => true,
  }
})

describe('ReducedMotionProvider on native', () => {
  it('seeds synchronously and propagates system changes from one subscription', () => {
    let listener: ((reduceMotion: boolean) => void) | undefined
    const remove = vi.fn()
    accessibility.addEventListener.mockImplementation((_event, next) => {
      listener = next
      return { remove }
    })

    const values: boolean[][] = [[], []]
    function Probe({ index }: { index: number }) {
      const reduceMotion = useReduceMotion()
      useEffect(() => {
        values[index]?.push(reduceMotion)
      }, [index, reduceMotion])
      return null
    }

    const view = render(
      <ReducedMotionProvider>
        <Probe index={0} />
        <Probe index={1} />
      </ReducedMotionProvider>,
    )

    expect(values).toEqual([[true], [true]])
    expect(accessibility.addEventListener).toHaveBeenCalledOnce()
    expect(reanimated.modes).toEqual(['always'])

    act(() => listener?.(false))

    expect(values).toEqual([[true, false], [true, false]])
    expect(reanimated.modes).toEqual(['always', 'never'])
    expect(reanimated.cleanups).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(remove).toHaveBeenCalledOnce()
    expect(reanimated.cleanups).toHaveBeenCalledTimes(2)
  })
})
