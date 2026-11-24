import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge, NativeDesktopPlatform } from '@/lib/nativeDesktop'
import { WorkingMark } from './WorkingMark'

const listeners = new Set<() => void>()
const preference = {
  matches: false,
  addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
  removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
}

function setPlatform(platform: NativeDesktopPlatform | undefined): void {
  const bridge: NativeDesktopBridge | undefined = platform
    ? {
        platform,
        minimize: vi.fn(async () => {}),
        toggleMaximize: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }
    : undefined
  vi.stubGlobal('__PODIUM_DESKTOP__', bridge)
}

function mountMark(): HTMLImageElement {
  const { container } = render(<WorkingMark />)
  const image = container.querySelector('.pod-mark img')
  expect(image).toBeInstanceOf(HTMLImageElement)
  return image as HTMLImageElement
}

beforeEach(() => {
  preference.matches = false
  vi.stubGlobal('matchMedia', (query: string) =>
    query === '(prefers-reduced-motion: reduce)'
      ? preference
      : { matches: false, addEventListener() {}, removeEventListener() {} },
  )
  setPlatform(undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const platforms = [undefined, 'linux', 'macos', 'windows'] as const

describe('WorkingMark', () => {
  it('uses a static PNG on Linux desktop while keeping the working mark visible', () => {
    setPlatform('linux')
    const { container } = render(<WorkingMark size={12} className="working-row" />)
    const mark = container.querySelector('.pod-mark') as HTMLElement
    expect(mark.classList.contains('working-row')).toBe(true)
    expect(mark.style.width).toBe('12px')
    expect(mark.style.height).toBe('12px')
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.querySelector('img')?.src).toMatch(/^data:image\/png;base64,/)
  })

  it.each([
    undefined,
    'macos',
    'windows',
  ] as const)('keeps animated PNGs with platform %s', (platform) => {
    setPlatform(platform)
    expect(mountMark().src).toMatch(/^blob:/)
  })

  it.each(platforms)('respects reduced motion with platform %s', (platform) => {
    setPlatform(platform)
    preference.matches = true
    expect(mountMark().src).toMatch(/^data:image\/png;base64,/)
  })

  it.each(platforms)('tracks motion preference changes with platform %s', async (platform) => {
    setPlatform(platform)
    const { container } = render(<WorkingMark />)
    const imageSource = (): string | undefined => container.querySelector('img')?.src
    const initial = imageSource()

    await act(async () => {
      preference.matches = true
      for (const listener of listeners) listener()
      await new Promise(requestAnimationFrame)
    })
    expect(imageSource()).toMatch(/^data:image\/png;base64,/)

    await act(async () => {
      preference.matches = false
      for (const listener of listeners) listener()
      await new Promise(requestAnimationFrame)
    })
    expect(imageSource()).toBe(initial)
  })
})
