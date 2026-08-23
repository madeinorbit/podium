import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useVoiceInput } from './useVoiceInput.fallback'

describe('useVoiceInput native fallback', () => {
  it('stays unsupported and inert without importing a platform binding', () => {
    const { result } = renderHook(() => useVoiceInput())

    expect(result.current).toMatchObject({
      supported: false,
      starting: false,
      listening: false,
      error: null,
      session: null,
      statusMessage: undefined,
      progress: undefined,
    })
    expect(() => {
      result.current.start()
      result.current.stop()
      result.current.clear()
    }).not.toThrow()
  })
})
