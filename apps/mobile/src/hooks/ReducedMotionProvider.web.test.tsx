import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReducedMotionProvider } from './ReducedMotionProvider.web'
import { useReduceMotion } from './useReduceMotion'

const reanimated = vi.hoisted(() => ({ modes: [] as string[], cleanups: vi.fn() }))

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
  }
})

describe('ReducedMotionProvider on web', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    reanimated.modes.length = 0
  })

  it('shares live preferences, synchronizes Reanimated, and cleans up both listener APIs', () => {
    let matches = true
    let listener: (() => void) | undefined
    const addEventListener = vi.fn((_event: string, next: () => void) => {
      listener = next
    })
    const removeEventListener = vi.fn()
    const addListener = vi.fn((next: () => void) => {
      listener = next
    })
    const removeListener = vi.fn()
    const matchMedia = vi.fn(() => ({
      get matches() {
        return matches
      },
      addEventListener,
      removeEventListener,
      addListener,
      removeListener,
    }))
    vi.stubGlobal('matchMedia', matchMedia)

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
    expect(matchMedia).toHaveBeenCalledOnce()
    expect(addEventListener).toHaveBeenCalledOnce()
    expect(addListener).not.toHaveBeenCalled()
    expect(reanimated.modes).toEqual(['always'])

    matches = false
    act(() => listener?.())

    expect(values).toEqual([[true, false], [true, false]])
    expect(reanimated.modes).toEqual(['always', 'never'])
    expect(reanimated.cleanups).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(removeEventListener).toHaveBeenCalledOnce()
    expect(reanimated.cleanups).toHaveBeenCalledTimes(2)

    Object.assign(matchMedia.mock.results[0]?.value ?? {}, {
      addEventListener: undefined,
      removeEventListener: undefined,
    })
    matches = true
    const legacyView = render(
      <ReducedMotionProvider>
        <Probe index={0} />
      </ReducedMotionProvider>,
    )
    expect(addListener).toHaveBeenCalledOnce()
    expect(addEventListener).toHaveBeenCalledOnce()
    expect(reanimated.modes.at(-1)).toBe('always')
    legacyView.unmount()
    expect(removeListener).toHaveBeenCalledOnce()
  })
})
