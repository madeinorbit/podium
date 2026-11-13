import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  listener: undefined as ((event: { data: { closing: boolean } }) => void) | undefined,
  unsubscribe: vi.fn(),
}))
const navigation = {
  addListener: vi.fn((event: string, listener: typeof native.listener) => {
    expect(event).toBe('transitionEnd')
    native.listener = listener
    return native.unsubscribe
  }),
}
vi.mock('expo-router', () => ({ useNavigation: () => navigation }))
const { useComposePresentation } = await import('./useComposePresentation.ios')
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('waits for the opening transition on every new sheet and stays ready across later menu appearances', () => {
  for (let opening = 0; opening < 5; opening++) {
    const { result, unmount } = renderHook(useComposePresentation)
    expect(result.current).toBe(false)
    act(() => native.listener?.({ data: { closing: true } }))
    expect(result.current).toBe(false)
    act(() => native.listener?.({ data: { closing: false } }))
    expect(result.current).toBe(true)
    // A picker or background/resume appearance must never remove the input.
    act(() => native.listener?.({ data: { closing: true } }))
    act(() => native.listener?.({ data: { closing: false } }))
    expect(result.current).toBe(true)
    unmount()
    expect(native.unsubscribe).toHaveBeenCalledTimes(opening + 1)
  }
})
