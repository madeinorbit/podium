import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  PodiumSpeechAvailability,
  PodiumSpeechModuleEvents,
  PodiumSpeechResultEvent,
} from '../../modules/podium-speech'

const native = vi.hoisted(() => {
  type EventName = keyof PodiumSpeechModuleEvents
  const listeners = new Map<EventName, Set<(event: never) => void>>()
  return {
    listeners,
    getAvailability: vi.fn<() => Promise<PodiumSpeechAvailability>>(),
    start:
      vi.fn<
        (localeIdentifier: string | undefined, clientGeneration: number) =>
          Promise<PodiumSpeechAvailability>
      >(),
    stop: vi.fn<(clientGeneration: number) => Promise<void>>(),
    cancel: vi.fn<(clientGeneration: number) => Promise<void>>(),
    addListener: vi.fn((name: EventName, listener: (event: never) => void) => {
      const eventListeners = listeners.get(name) ?? new Set()
      eventListeners.add(listener)
      listeners.set(name, eventListeners)
      return { remove: () => eventListeners.delete(listener) }
    }),
    emit(name: EventName, event: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(event as never)
    },
  }
})

vi.mock('../../modules/podium-speech', () => ({ default: native }))

const { useVoiceInput } = await import('./useVoiceInput.ios')

const READY: PodiumSpeechAvailability = {
  status: 'ready',
  supported: true,
  requestedLocaleIdentifier: 'en-US',
  localeIdentifier: 'en-US',
  modelStatus: 'installed',
  microphonePermission: 'granted',
  progress: 1,
  message: 'Private on-device dictation is ready.',
}

function speechResult(
  generation: number,
  text: string,
  startTime: number,
  endTime: number,
  isFinal: boolean,
): PodiumSpeechResultEvent {
  return { generation, text, startTime, endTime, isFinal, finalizationTime: isFinal ? endTime : 0 }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

beforeEach(() => {
  native.listeners.clear()
  native.addListener.mockClear()
  native.getAvailability.mockReset().mockResolvedValue(READY)
  native.start.mockReset().mockImplementation(() => new Promise(() => {}))
  native.stop.mockReset().mockResolvedValue(undefined)
  native.cancel.mockReset().mockResolvedValue(undefined)
})

describe('iOS private voice input', () => {
  it('starts only once while a session is active', async () => {
    const { result } = renderHook(() => useVoiceInput())
    await act(async () => Promise.resolve())

    act(() => {
      result.current.start()
      result.current.start()
    })

    expect(native.start).toHaveBeenCalledOnce()
  })

  it('publishes session snapshots and synchronously drops interim text on stop', async () => {
    const { result } = renderHook(() => useVoiceInput())
    await act(async () => Promise.resolve())

    act(() => result.current.start())
    const generation = native.start.mock.calls[0]?.[1] as number
    expect(result.current.session).toMatchObject({
      id: 1,
      revision: 0,
      finalText: '',
      interimText: '',
    })

    act(() => {
      native.emit('onPhaseChanged', { generation, phase: 'listening', progress: null })
      native.emit('onResult', speechResult(generation, 'final words', 0, 1, true))
      native.emit('onResult', speechResult(generation, 'changing words', 1, 2, false))
    })
    expect(result.current).toMatchObject({ starting: false, listening: true })
    expect(result.current.session).toMatchObject({
      finalText: 'final words',
      interimText: 'changing words',
    })

    act(() => result.current.stop())
    expect(result.current.listening).toBe(false)
    expect(result.current.session).toMatchObject({ finalText: 'final words', interimText: '' })
    expect(native.stop).toHaveBeenCalledOnce()
  })

  it('filters queued native events by generation after restart', async () => {
    const { result } = renderHook(() => useVoiceInput())
    await act(async () => Promise.resolve())

    act(() => result.current.start())
    const firstGeneration = native.start.mock.calls[0]?.[1] as number
    act(() => result.current.stop())
    await act(async () => {
      await native.stop.mock.results[0]?.value
    })
    act(() => result.current.start())
    const secondGeneration = native.start.mock.calls[1]?.[1] as number

    act(() => {
      native.emit('onResult', speechResult(firstGeneration, 'stale text', 0, 1, true))
      native.emit('onPhaseChanged', {
        generation: firstGeneration,
        phase: 'idle',
        progress: null,
      })
      native.emit('onError', {
        generation: firstGeneration,
        code: 'stale_error',
        message: 'Old failure',
        recoverable: true,
      })
      native.emit('onPhaseChanged', {
        generation: secondGeneration,
        phase: 'listening',
        progress: null,
      })
      native.emit('onResult', speechResult(secondGeneration, 'current text', 0, 1, false))
    })

    expect(result.current.listening).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.session).toMatchObject({ finalText: '', interimText: 'current text' })
  })

  it('keeps start rejection stable and allows a retry', async () => {
    native.start.mockRejectedValueOnce({
      code: 'unsupported_locale',
      message: 'This language is unavailable.',
    })
    const { result } = renderHook(() => useVoiceInput())
    await act(async () => Promise.resolve())

    await act(async () => {
      result.current.start()
      await Promise.resolve()
    })
    expect(result.current).toMatchObject({
      starting: false,
      listening: false,
      error: { code: 'unsupported_locale', message: 'This language is unavailable.' },
    })

    act(() => result.current.start())
    expect(native.start).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
  })

  it('surfaces a graceful-stop worker failure after synchronous invalidation', async () => {
    native.stop.mockRejectedValueOnce({
      code: 'recognition_failed',
      message: 'On-device dictation stopped unexpectedly.',
    })
    const { result } = renderHook(() => useVoiceInput())
    await act(async () => Promise.resolve())
    act(() => result.current.start())

    await act(async () => {
      result.current.stop()
      await Promise.resolve()
    })

    expect(result.current).toMatchObject({
      starting: false,
      listening: false,
      error: {
        code: 'recognition_failed',
        message: 'On-device dictation stopped unexpectedly.',
      },
    })
  })

  it('waits for generation-bound stop and cancel before allowing restart', async () => {
    const stopping = deferred()
    const canceling = deferred()
    native.stop.mockReturnValueOnce(stopping.promise)
    native.cancel.mockReturnValueOnce(canceling.promise)
    const { result } = renderHook(() => useVoiceInput())
    await act(async () => Promise.resolve())

    act(() => result.current.start())
    const firstGeneration = native.start.mock.calls[0]?.[1] as number
    act(() => {
      result.current.stop()
      result.current.start()
    })
    expect(native.stop).toHaveBeenCalledWith(firstGeneration)
    expect(native.start).toHaveBeenCalledOnce()

    await act(async () => {
      native.emit('onResult', speechResult(firstGeneration, 'stale text', 0, 1, true))
      stopping.resolve()
      await stopping.promise
    })
    act(() => result.current.start())
    const secondGeneration = native.start.mock.calls[1]?.[1] as number
    expect(secondGeneration).not.toBe(firstGeneration)

    act(() => result.current.clear())
    act(() => result.current.start())
    expect(native.start).toHaveBeenCalledTimes(2)
    expect(native.cancel).toHaveBeenCalledWith(secondGeneration)

    await act(async () => {
      canceling.resolve()
      await canceling.promise
    })
    act(() => {
      result.current.start()
    })
    const thirdGeneration = native.start.mock.calls[2]?.[1] as number
    expect(thirdGeneration).not.toBe(secondGeneration)

    act(() => {
      native.emit('onPhaseChanged', {
        generation: thirdGeneration,
        phase: 'listening',
        progress: null,
      })
    })
    expect(result.current.listening).toBe(true)
  })

  it('clears immediately and keeps model preparation detail', async () => {
    const { result } = renderHook(() => useVoiceInput())
    await act(async () => Promise.resolve())

    act(() => result.current.start())
    const generation = native.start.mock.calls[0]?.[1] as number
    act(() => {
      native.emit('onPhaseChanged', { generation, phase: 'downloading', progress: 0.4 })
    })
    expect(result.current).toMatchObject({
      starting: true,
      statusMessage: 'Downloading Apple’s private dictation model…',
      progress: 0.4,
    })

    act(() => result.current.clear())
    act(() => native.emit('onResult', speechResult(generation, 'too late', 0, 1, true)))
    expect(result.current.session).toBeNull()
    expect(result.current.listening).toBe(false)
    expect(native.cancel).toHaveBeenCalled()
  })

  it('removes native listeners and cancels the owned generation on unmount', async () => {
    const { result, unmount } = renderHook(() => useVoiceInput())
    await act(async () => Promise.resolve())
    act(() => result.current.start())
    const generation = native.start.mock.calls[0]?.[1] as number

    unmount()

    expect(native.cancel).toHaveBeenCalledWith(generation)
    expect([...native.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
  })
})
