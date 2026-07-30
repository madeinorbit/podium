import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASCII_ANIMATION_FRAME_INTERVAL_MS,
  setTextIfChanged,
  startAsciiAnimation,
} from './ascii-animation'

describe('ASCII animation scheduler', () => {
  let visibilityState: DocumentVisibilityState

  beforeEach(() => {
    vi.useFakeTimers()
    visibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    })
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 1000 / 60),
      ),
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => window.clearTimeout(id)),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('generates no more than 15 animated frames per visible second', () => {
    const renderFrame = vi.fn((elapsed: number) => `animated ${elapsed}`)
    const commit = vi.fn()
    const stop = startAsciiAnimation({
      renderStatic: () => 'static',
      renderFrame,
      commit,
      reducedMotion: false,
    })

    vi.advanceTimersByTime(1000)

    expect(renderFrame.mock.calls.length).toBeGreaterThanOrEqual(10)
    expect(renderFrame.mock.calls.length).toBeLessThanOrEqual(15)
    expect(commit).toHaveBeenCalledTimes(renderFrame.mock.calls.length + 1)
    stop()
  })

  it('cancels animation while hidden and resumes when visible', () => {
    const renderFrame = vi.fn(() => 'animated')
    const stop = startAsciiAnimation({
      renderStatic: () => 'static',
      renderFrame,
      commit: vi.fn(),
      reducedMotion: false,
    })
    vi.advanceTimersByTime(20)
    expect(renderFrame).toHaveBeenCalledTimes(1)

    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(ASCII_ANIMATION_FRAME_INTERVAL_MS * 2)
    expect(renderFrame).toHaveBeenCalledTimes(1)

    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(20)
    expect(renderFrame).toHaveBeenCalledTimes(2)
    stop()
  })

  it('removes visibility handling and RAF callbacks on cleanup', () => {
    const renderFrame = vi.fn(() => 'animated')
    const stop = startAsciiAnimation({
      renderStatic: () => 'static',
      renderFrame,
      commit: vi.fn(),
      reducedMotion: false,
    })

    stop()
    expect(vi.getTimerCount()).toBe(0)
    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    expect(renderFrame).not.toHaveBeenCalled()
  })

  it('commits one static frame and schedules no RAF for reduced motion', () => {
    const renderStatic = vi.fn(() => 'static')
    const renderFrame = vi.fn(() => 'animated')
    const commit = vi.fn()

    startAsciiAnimation({ renderStatic, renderFrame, commit, reducedMotion: true })

    expect(renderStatic).toHaveBeenCalledTimes(1)
    expect(renderFrame).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledWith('static')
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
})

describe('setTextIfChanged', () => {
  it('skips redundant textContent assignments', () => {
    const node = document.createElement('pre')
    node.textContent = 'same'
    const setter = vi.fn()
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      get: () => 'same',
      set: setter,
    })

    setTextIfChanged(node, 'same')

    expect(setter).not.toHaveBeenCalled()
  })
})
