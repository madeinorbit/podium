// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useReducedMotion } from './use-reduced-motion'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function PreferenceProbe(): JSX.Element {
  const reduced = useReducedMotion()
  return <output>{reduced ? 'reduced' : 'full'}</output>
}

describe('useReducedMotion', () => {
  it('tracks changes to the reduced-motion media preference', () => {
    let listener: (() => void) | undefined
    const preference = {
      matches: false,
      addEventListener: vi.fn((_event: string, next: () => void) => {
        listener = next
      }),
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => preference),
    )

    render(<PreferenceProbe />)
    expect(screen.getByText('full')).toBeTruthy()

    act(() => {
      preference.matches = true
      listener?.()
    })
    expect(screen.getByText('reduced')).toBeTruthy()
  })

  it('uses the legacy MediaQueryList listener API when event listeners are unavailable', () => {
    let listener: (() => void) | undefined
    const preference = {
      matches: false,
      addListener: vi.fn((next: () => void) => {
        listener = next
      }),
      removeListener: vi.fn(),
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => preference),
    )

    const view = render(<PreferenceProbe />)
    act(() => {
      preference.matches = true
      listener?.()
    })
    expect(screen.getByText('reduced')).toBeTruthy()

    view.unmount()
    expect(preference.removeListener).toHaveBeenCalledWith(listener)
  })
})
