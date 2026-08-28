import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVoiceInput } from './useVoiceInput.web'

interface FakeResult {
  isFinal: boolean
  length: number
  0: { transcript: string }
}

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = []

  lang = ''
  continuous = false
  interimResults = false
  onstart: (() => void) | null = null
  onresult: ((event: { resultIndex: number; results: FakeResult[] }) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  start = vi.fn()
  stop = vi.fn()

  constructor() {
    FakeSpeechRecognition.instances.push(this)
  }
}

function result(transcript: string, isFinal = true): FakeResult {
  return { isFinal, length: 1, 0: { transcript } }
}

function install(Recognition: typeof FakeSpeechRecognition = FakeSpeechRecognition) {
  vi.stubGlobal('SpeechRecognition', Recognition)
}

afterEach(() => {
  FakeSpeechRecognition.instances = []
  vi.unstubAllGlobals()
})

describe('useVoiceInput web adapter', () => {
  it('reports unsupported browsers without constructing recognition', () => {
    vi.stubGlobal('SpeechRecognition', undefined)
    vi.stubGlobal('webkitSpeechRecognition', undefined)
    const { result: hook } = renderHook(() => useVoiceInput())

    expect(hook.current.supported).toBe(false)
    act(() => hook.current.start())
    expect(FakeSpeechRecognition.instances).toHaveLength(0)
  })

  it('reduces two final results by index and ignores a replay from resultIndex zero', () => {
    install()
    const { result: hook } = renderHook(() => useVoiceInput())
    act(() => hook.current.start())
    const recognition = FakeSpeechRecognition.instances[0]

    act(() =>
      recognition.onresult?.({
        resultIndex: 0,
        results: [result('first phrase'), result('second phrase')],
      }),
    )
    expect(hook.current.session).toMatchObject({
      revision: 1,
      finalText: 'first phrase second phrase',
      interimText: '',
    })
    const firstSnapshot = hook.current.session

    act(() =>
      recognition.onresult?.({
        resultIndex: 0,
        results: [result('first phrase'), result('second phrase')],
      }),
    )
    expect(hook.current.session).toBe(firstSnapshot)
  })

  it('separates startup from listening and publishes interim text as a snapshot', () => {
    install()
    const { result: hook } = renderHook(() => useVoiceInput())

    act(() => hook.current.start())
    const recognition = FakeSpeechRecognition.instances[0]
    expect(hook.current.starting).toBe(true)
    expect(hook.current.listening).toBe(false)
    expect(hook.current.statusMessage).toBe('Starting dictation…')
    expect(recognition.start).toHaveBeenCalledOnce()
    expect(recognition.continuous).toBe(true)
    expect(recognition.interimResults).toBe(true)

    act(() => recognition.onstart?.())
    expect(hook.current.starting).toBe(false)
    expect(hook.current.listening).toBe(true)
    expect(hook.current.statusMessage).toBe('Listening…')

    act(() =>
      recognition.onresult?.({ resultIndex: 0, results: [result('still speaking', false)] }),
    )
    expect(hook.current.session?.interimText).toBe('still speaking')
  })

  it('does not create a second recognizer for a double start', () => {
    install()
    const { result: hook } = renderHook(() => useVoiceInput())

    act(() => {
      hook.current.start()
      hook.current.start()
    })

    expect(FakeSpeechRecognition.instances).toHaveLength(1)
    expect(FakeSpeechRecognition.instances[0].start).toHaveBeenCalledOnce()
  })

  it('invalidates stop before onstart and rejects stale end and error callbacks', () => {
    install()
    const { result: hook } = renderHook(() => useVoiceInput())
    act(() => hook.current.start())
    const first = FakeSpeechRecognition.instances[0]
    const staleEnd = first.onend
    const staleError = first.onerror

    act(() => hook.current.stop())
    expect(first.stop).toHaveBeenCalledOnce()
    expect(hook.current.starting).toBe(false)
    expect(hook.current.listening).toBe(false)

    act(() => hook.current.start())
    const secondSession = hook.current.session
    expect(FakeSpeechRecognition.instances).toHaveLength(2)

    act(() => {
      staleError?.({ error: 'not-allowed' })
      staleEnd?.()
    })
    expect(hook.current.session).toBe(secondSession)
    expect(hook.current.starting).toBe(true)
    expect(hook.current.error).toBeNull()
  })

  it('clears synchronously and rejects a captured late result', () => {
    install()
    const { result: hook } = renderHook(() => useVoiceInput())
    act(() => hook.current.start())
    const recognition = FakeSpeechRecognition.instances[0]
    const staleResult = recognition.onresult

    act(() => hook.current.clear())
    expect(hook.current.session).toBeNull()
    expect(recognition.stop).toHaveBeenCalledOnce()

    act(() => staleResult?.({ resultIndex: 0, results: [result('must not return to the draft')] }))
    expect(hook.current.session).toBeNull()
  })

  it('turns browser permission denial into a useful failure state', () => {
    install()
    const { result: hook } = renderHook(() => useVoiceInput())
    act(() => hook.current.start())
    const recognition = FakeSpeechRecognition.instances[0]

    act(() => recognition.onerror?.({ error: 'not-allowed' }))

    expect(hook.current.starting).toBe(false)
    expect(hook.current.listening).toBe(false)
    expect(hook.current.error).toEqual({
      code: 'permission-denied',
      message: 'Microphone access is blocked. Allow it in your browser settings and try again.',
    })
  })

  it('reports microphone capture failures separately from permission denial', () => {
    install()
    const { result: hook } = renderHook(() => useVoiceInput())
    act(() => hook.current.start())
    const recognition = FakeSpeechRecognition.instances[0]

    act(() => recognition.onerror?.({ error: 'audio-capture' }))

    expect(hook.current.error).toEqual({
      code: 'no-microphone',
      message: 'No microphone is available. Check your device and try again.',
    })
  })

  it('catches synchronous permission failures from start', () => {
    class DeniedSpeechRecognition extends FakeSpeechRecognition {
      override start = vi.fn(() => {
        const error = new Error('denied')
        error.name = 'NotAllowedError'
        throw error
      })
    }
    install(DeniedSpeechRecognition)
    const { result: hook } = renderHook(() => useVoiceInput())

    act(() => hook.current.start())

    expect(hook.current.starting).toBe(false)
    expect(hook.current.error?.code).toBe('permission-denied')
  })

  it('stops on unmount and rejects a captured late result', () => {
    install()
    const { result: hook, unmount } = renderHook(() => useVoiceInput())
    act(() => hook.current.start())
    const recognition = FakeSpeechRecognition.instances[0]
    const staleResult = recognition.onresult
    unmount()

    expect(recognition.stop).toHaveBeenCalledOnce()
    expect(recognition.onresult).toBeNull()
    expect(() =>
      staleResult?.({ resultIndex: 0, results: [result('late after unmount')] }),
    ).not.toThrow()
  })
})
