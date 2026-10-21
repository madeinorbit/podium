import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { type UseQuotesResult, useQuotes } from './QuoteStrip'

// Chips are staged per session for the page's life (POD-2057): a composer that
// unmounts (native view, closed dock) finds them again when it comes back.

function mountHook(key: { current: string }): {
  get: () => UseQuotesResult
  rerender: () => void
  unmount: () => void
} {
  let latest: UseQuotesResult | null = null
  function Probe(): null {
    latest = useQuotes(key.current)
    return null
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<Probe />))
  return {
    get: () => latest as UseQuotesResult,
    rerender: () => act(() => root.render(<Probe />)),
    unmount: () => act(() => root.unmount()),
  }
}

describe('useQuotes', () => {
  it('keeps a session’s chips across an unmount', () => {
    const key = { current: 'session-a' }
    const first = mountHook(key)
    act(() => first.get().add({ text: 'keep me', source: '/r/a.md:3' }))
    first.unmount()
    const again = mountHook(key)
    expect(again.get().quotes.map((q) => q.text)).toEqual(['keep me'])
    act(() => again.get().clear())
    again.unmount()
    expect(mountHook(key).get().quotes).toEqual([])
  })

  it('shows the other session’s chips when the composer is reused', () => {
    const key = { current: 'session-b' }
    const hook = mountHook(key)
    act(() => hook.get().add({ text: 'b only', source: 'your reply' }))
    key.current = 'session-c'
    hook.rerender()
    expect(hook.get().quotes).toEqual([])
    key.current = 'session-b'
    hook.rerender()
    expect(hook.get().quotes.map((q) => q.text)).toEqual(['b only'])
    act(() => hook.get().clear())
  })
})
