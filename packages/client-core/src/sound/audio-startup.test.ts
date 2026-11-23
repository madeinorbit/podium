import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiState } from '../replica/contract'

let stop: (() => void) | undefined

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function harness(idleSupported = true) {
  let idle: IdleRequestCallback | undefined
  let frame: FrameRequestCallback | undefined
  const context = {
    state: 'suspended',
    resume: vi.fn(() => Promise.resolve()),
  }
  const construct = vi.fn(() => context)
  const host = Object.assign(new EventTarget(), {
    AudioContext: class {
      get state() {
        return context.state
      }
      resume = context.resume
      constructor() {
        construct()
      }
    },
    requestIdleCallback: idleSupported
      ? vi.fn((callback: IdleRequestCallback) => {
          idle = callback
          return 11
        })
      : undefined,
    cancelIdleCallback: vi.fn(),
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frame = callback
      return 12
    }),
    cancelAnimationFrame: vi.fn(),
  })
  vi.stubGlobal('window', host)
  const settings = new Map<string, string>()
  const { createNotificationSounds, SOUNDS_ENABLED_KEY } = await import('./notification-sounds')
  const sounder = createNotificationSounds({
    phases: () => [],
    ui: { get: (key) => settings.get(key) ?? null } as UiState,
    visibleSessionIds: () => [],
    windowFocused: () => false,
  })
  stop = () => sounder.stop()
  return {
    host,
    context,
    construct,
    settings,
    sounder,
    SOUNDS_ENABLED_KEY,
    runIdle: () => idle?.({ didTimeout: false, timeRemaining: () => 50 }),
    runFrame: () => frame?.(0),
  }
}

describe('notification audio startup', () => {
  it('constructs in idle time and resumes the same context synchronously in a gesture', async () => {
    const h = await harness()
    h.sounder.start()
    expect(h.construct).not.toHaveBeenCalled()
    h.runIdle()
    expect(h.construct).toHaveBeenCalledTimes(1)
    expect(h.context.resume).not.toHaveBeenCalled()

    h.host.dispatchEvent(new Event('pointerdown'))
    expect(h.context.resume).toHaveBeenCalledTimes(1)
    expect(h.construct).toHaveBeenCalledTimes(1)
    h.context.state = 'running'
    h.host.dispatchEvent(new Event('click'))
    h.host.dispatchEvent(new Event('keydown'))
    expect(h.context.resume).toHaveBeenCalledTimes(1)

    // Safari can interrupt audio on a background/device transition.
    h.context.state = 'interrupted'
    h.host.dispatchEvent(new Event('keydown'))
    expect(h.context.resume).toHaveBeenCalledTimes(2)
  })

  it.each([
    'pointerdown',
    'keydown',
    'click',
  ])('retains direct gesture unlock if %s arrives before idle preparation', async (event) => {
    const h = await harness()
    h.sounder.start()
    h.host.dispatchEvent(new Event(event))
    expect(h.construct).toHaveBeenCalledTimes(1)
    expect(h.context.resume).toHaveBeenCalledTimes(1)
    h.runIdle()
    expect(h.construct).toHaveBeenCalledTimes(1)
  })

  it('prepares after a paint opportunity when idle callbacks are unavailable', async () => {
    const h = await harness(false)
    h.sounder.start()
    expect(h.construct).not.toHaveBeenCalled()
    h.runFrame()
    expect(h.construct).not.toHaveBeenCalled()
    await vi.runOnlyPendingTimersAsync()
    expect(h.construct).toHaveBeenCalledTimes(1)
    expect(h.context.resume).not.toHaveBeenCalled()
    h.host.dispatchEvent(new Event('click'))
    expect(h.context.resume).toHaveBeenCalledTimes(1)
  })

  it('cancels idle preparation and gesture listeners on stop, then restarts once', async () => {
    const h = await harness()
    h.sounder.start()
    h.sounder.start()
    expect(h.host.requestIdleCallback).toHaveBeenCalledTimes(1)
    h.sounder.stop()
    expect(h.host.cancelIdleCallback).toHaveBeenCalledWith(11)
    for (const event of ['pointerdown', 'keydown', 'click']) h.host.dispatchEvent(new Event(event))
    expect(h.construct).not.toHaveBeenCalled()
    h.sounder.start()
    expect(h.host.requestIdleCallback).toHaveBeenCalledTimes(2)
    h.runIdle()
    expect(h.construct).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('cancels fallback preparation (frame ran: %s)', async (frameRan) => {
    const h = await harness(false)
    h.sounder.start()
    if (frameRan) h.runFrame()
    h.sounder.stop()
    expect(h.host.cancelAnimationFrame).toHaveBeenCalledWith(12)
    await vi.runOnlyPendingTimersAsync()
    expect(h.construct).not.toHaveBeenCalled()
  })

  it('leaves muted audio uninitialized and unlocks when enabled again', async () => {
    const h = await harness()
    h.settings.set(h.SOUNDS_ENABLED_KEY, 'false')
    h.sounder.start()
    h.runIdle()
    h.host.dispatchEvent(new Event('pointerdown'))
    h.host.dispatchEvent(new Event('click'))
    h.host.dispatchEvent(new Event('keydown'))
    expect(h.construct).not.toHaveBeenCalled()
    h.settings.delete(h.SOUNDS_ENABLED_KEY)
    h.host.dispatchEvent(new Event('keydown'))
    expect(h.context.resume).toHaveBeenCalledTimes(1)
  })

  it('retries a failed preparation in the next gesture', async () => {
    const h = await harness()
    h.construct.mockImplementationOnce(() => {
      throw new Error('Audio device unavailable')
    })
    h.sounder.start()
    expect(h.runIdle).not.toThrow()
    h.host.dispatchEvent(new Event('pointerdown'))
    expect(h.construct).toHaveBeenCalledTimes(2)
    expect(h.context.resume).toHaveBeenCalledTimes(1)
  })

  it('allows later gesture retries after synchronous or asynchronous resume failures', async () => {
    const h = await harness()
    const { prewarmAudio } = await import('./cuelume')
    h.context.resume.mockImplementationOnce(() => {
      throw new Error('Blocked')
    })
    expect(prewarmAudio).not.toThrow()
    h.context.resume.mockRejectedValueOnce(new Error('Blocked'))
    prewarmAudio()
    await Promise.resolve()
    prewarmAudio()
    expect(h.context.resume).toHaveBeenCalledTimes(3)
    expect(h.construct).toHaveBeenCalledTimes(1)
  })

  it('supports the prefixed WebKit constructor', async () => {
    const h = await harness()
    Object.assign(h.host, { AudioContext: undefined, webkitAudioContext: h.host.AudioContext })
    h.sounder.start()
    h.runIdle()
    h.host.dispatchEvent(new Event('click'))
    expect(h.construct).toHaveBeenCalledTimes(1)
    expect(h.context.resume).toHaveBeenCalledTimes(1)
  })

  it('does not schedule DOM audio for SSR or a React Native window', async () => {
    const h = await harness()
    for (const window of [undefined, {}]) {
      vi.stubGlobal('window', window)
      h.sounder.start()
      h.sounder.stop()
    }
    expect(h.host.requestIdleCallback).not.toHaveBeenCalled()
    expect(h.construct).not.toHaveBeenCalled()
  })
})
