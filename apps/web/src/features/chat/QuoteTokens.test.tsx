import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { eraseAllQuotes, loadQuotes } from '@/lib/quote/quote-store'
import { quoteLabel } from '@/lib/quote/quote-tokens'
import { type UseQuotesResult, useQuotes } from './QuoteTokens'

// Staged passages (POD-2207): kept per session across an unmount and a reload,
// pruned to the tokens still in the draft, gone on clear and on account erase.

function mountHook(
  key: { current: string },
  persist = true,
): {
  get: () => UseQuotesResult
  rerender: () => void
  unmount: () => void
} {
  let latest: UseQuotesResult | null = null
  function Probe(): null {
    latest = useQuotes(key.current, persist)
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

afterEach(() => eraseAllQuotes())

describe('useQuotes', () => {
  it('keeps a session’s passages across an unmount, and in storage', () => {
    const key = { current: 'session-a' }
    const first = mountHook(key)
    act(() => {
      first.get().add({ text: 'keep me', source: '/r/a.md:3' }, '')
    })
    first.unmount()
    expect(
      mountHook(key)
        .get()
        .quotes.map((q) => q.text),
    ).toEqual(['keep me'])
    expect(localStorage.getItem('podium.quotes.session-a')).toContain('keep me')
  })

  it('shows the other session’s passages when the composer is reused', () => {
    const key = { current: 'session-b' }
    const hook = mountHook(key)
    act(() => {
      hook.get().add({ text: 'b only', source: 'your reply' }, '')
    })
    key.current = 'session-c'
    hook.rerender()
    expect(hook.get().quotes).toEqual([])
    key.current = 'session-b'
    hook.rerender()
    expect(hook.get().quotes.map((q) => q.text)).toEqual(['b only'])
  })

  it('drops passages whose tokens left the draft, and keeps the rest', () => {
    const hook = mountHook({ current: 'session-d' })
    let kept = ''
    act(() => {
      kept = hook.get().add({ text: 'kept', source: 's' }, '').label
      hook.get().add({ text: 'deleted', source: 's' }, kept)
    })
    act(() => {
      hook.get().add({ text: 'new', source: 's' }, `${kept} words`)
    })
    expect(hook.get().quotes.map((q) => q.text)).toEqual(['kept', 'new'])
  })

  it('does not hand out an orphan’s label', () => {
    const hook = mountHook({ current: 'session-e' })
    const orphan = quoteLabel('foo bar')
    let label = ''
    act(() => {
      label = hook.get().add({ text: 'foo bar', source: 's' }, `${orphan} hi`).label
    })
    expect(label).not.toBe(orphan)
  })

  it('forgets them on clear and on account erase', () => {
    const hook = mountHook({ current: 'session-f' })
    act(() => {
      hook.get().add({ text: 'x', source: 's' }, '')
    })
    act(() => hook.get().clear())
    expect(localStorage.getItem('podium.quotes.session-f')).toBeNull()
    act(() => {
      hook.get().add({ text: 'y', source: 's' }, '')
    })
    eraseAllQuotes()
    expect(loadQuotes('session-f')).toEqual([])
  })
})

it('keeps mail quotes local and separate from the normal prompt bank', () => {
  const prompt = mountHook({ current: 'normal' })
  const mailKey = { current: 'mail:ask' }
  const mail = mountHook(mailKey, false)
  act(() => {
    prompt.get().add({ text: 'normal quote', source: 's' }, '')
    mail.get().add({ text: 'mail quote', source: 's' }, '')
  })
  expect(loadQuotes('normal').map((q) => q.text)).toEqual(['normal quote'])
  expect(loadQuotes('mail:ask')).toEqual([])
  expect(mail.get().quotes.map((q) => q.text)).toEqual(['mail quote'])
  act(() => mail.get().clear())
  expect(prompt.get().quotes.map((q) => q.text)).toEqual(['normal quote'])
  mail.unmount()
  prompt.unmount()
})
