import { eraseAccountData } from '@podium/client-core/accounts'
import { principalKeyPrefix } from '@podium/client-core/replica'
import { fixtureUi } from '@podium/client-core/test-support/ui'
import { openLegacyDeviceKeys, UiPersistence } from '@podium/client-core/ui'
import { createRoutedUiState, type RoutedUiState } from '@podium/client-core/ui-state'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadQuotes, QUOTES_KEY, saveQuotes, sweepQuotes } from '@/lib/quote/quote-store'
import { quoteLabel } from '@/lib/quote/quote-tokens'
import { createSideCache } from '../../../../../packages/client-core/src/replica/kernel/side-cache'
import { type UseQuotesResult, useQuotes } from './QuoteTokens'

let currentOwner: RoutedUiState
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useDeviceState: () => currentOwner,
}))
type QuoteOwner = {
  principal: string
  basePrefix: string
  keyPrefix: string
  ui: ReturnType<typeof fixtureUi>
  persistence: UiPersistence
  state: RoutedUiState
  side: ReturnType<typeof createSideCache>
}
const owners: QuoteOwner[] = []
const mounted = new Set<ReturnType<typeof createRoot>>()
function openOwner(member = 'alice', workspace = 'workspace-a'): QuoteOwner {
  const principal = JSON.stringify([workspace, member])
  const basePrefix = 'podium.quote-tests'
  const keyPrefix = principalKeyPrefix(basePrefix, principal)
  const side = createSideCache({
    storage: localStorage,
    keyPrefix,
    enumerateKeys: () => Object.keys(localStorage),
  })
  const ui = fixtureUi()
  const persistence = new UiPersistence(
    ui,
    side.deviceStorage(),
    openLegacyDeviceKeys(side.deviceStorage()),
    {
      isVisible: () => true,
      subscribe: () => () => {},
    },
  )
  persistence.start()
  const state = createRoutedUiState({
    local: {
      get: (key) => ui.getDevicePref(key),
      set: (key, value) => ui.setDevicePref(key, value),
      subscribe: () => () => {},
    },
    replicated: {
      get: () => undefined,
      set: () => {
        throw new Error('quotes must stay on the device')
      },
      clear: () => {},
      subscribe: () => () => {},
    },
  })
  const opened = { principal, basePrefix, keyPrefix, ui, persistence, state, side }
  owners.push(opened)
  return opened
}
let active: ReturnType<typeof openOwner>
beforeEach(() => {
  localStorage.clear()
  active = openOwner()
  currentOwner = active.state
})
afterEach(async () => {
  act(() => {
    for (const root of mounted) root.unmount()
  })
  mounted.clear()
  for (const owned of owners.splice(0)) {
    owned.persistence.stopSaving()
    owned.ui.dispose()
    owned.side.dispose()
  }
  localStorage.clear()
  vi.useRealTimers()
})

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
  mounted.add(root)
  act(() => root.render(<Probe />))
  return {
    get: () => latest as UseQuotesResult,
    rerender: () => act(() => root.render(<Probe />)),
    unmount: () =>
      act(() => {
        root.unmount()
        mounted.delete(root)
      }),
  }
}

describe('useQuotes', () => {
  it('keeps a session’s passages across an unmount and principal-owned reload', async () => {
    const key = { current: 'session-a' }
    const first = mountHook(key)
    act(() => {
      first.get().add({ text: 'keep me', source: '/r/a.md:3' }, '')
    })
    first.unmount()
    await active.persistence.flush()
    active = openOwner()
    currentOwner = active.state
    expect(
      mountHook(key)
        .get()
        .quotes.map((q) => q.text),
    ).toEqual(['keep me'])
    expect(localStorage.getItem(`${active.keyPrefix}.ui.v1`)).toContain('keep me')
    expect(localStorage.getItem('podium.quotes.session-a')).toBeNull()
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

  it('forgets them on clear and on account erase', async () => {
    const hook = mountHook({ current: 'session-f' })
    act(() => {
      hook.get().add({ text: 'x', source: 's' }, '')
    })
    act(() => hook.get().clear())
    expect(loadQuotes(currentOwner, 'session-f')).toEqual([])
    act(() => {
      hook.get().add({ text: 'y', source: 's' }, '')
    })
    hook.unmount()
    await active.persistence.flush()
    active.side.seal()
    active.persistence.erase()
    await eraseAccountData({
      principal: active.principal,
      basePrefix: active.basePrefix,
      storage: localStorage,
      enumerateKeys: () => Object.keys(localStorage),
      eraseEntities: async () => {},
    })
    active = openOwner()
    currentOwner = active.state
    expect(loadQuotes(currentOwner, 'session-f')).toEqual([])
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
  expect(loadQuotes(currentOwner, 'normal').map((q) => q.text)).toEqual(['normal quote'])
  expect(loadQuotes(currentOwner, 'mail:ask')).toEqual([])
  expect(mail.get().quotes.map((q) => q.text)).toEqual(['mail quote'])
  act(() => mail.get().clear())
  expect(prompt.get().quotes.map((q) => q.text)).toEqual(['normal quote'])
  mail.unmount()
  prompt.unmount()
})

it('isolates a reused composer by member and workspace, and erases only its owner', async () => {
  const alice = active
  const hook = mountHook({ current: 'same-session' })
  act(() => hook.get().add({ text: 'alice private passage', source: 'a' }, ''))
  await alice.persistence.flush()
  const bob = openOwner('bob')
  currentOwner = bob.state
  hook.rerender()
  expect(hook.get().quotes).toEqual([])
  act(() => hook.get().add({ text: 'bob private passage', source: 'b' }, ''))
  await bob.persistence.flush()
  const elsewhere = openOwner('alice', 'workspace-b')
  currentOwner = elsewhere.state
  hook.rerender()
  expect(hook.get().quotes).toEqual([])
  currentOwner = alice.state
  hook.rerender()
  expect(hook.get().quotes.map((quote) => quote.text)).toEqual(['alice private passage'])
  hook.unmount()
  alice.side.seal()
  alice.persistence.erase()
  await eraseAccountData({
    principal: alice.principal,
    basePrefix: alice.basePrefix,
    storage: localStorage,
    enumerateKeys: () => Object.keys(localStorage),
    eraseEntities: async () => {},
  })
  expect(loadQuotes(openOwner('alice').state, 'same-session')).toEqual([])
  expect(loadQuotes(openOwner('bob').state, 'same-session').map((quote) => quote.text)).toEqual([
    'bob private passage',
  ])
})

it('expires old passages and never adopts unattributable raw quote bytes', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
  saveQuotes(currentOwner, 'old', [{ id: 'q1', label: 'one', text: 'expired', source: 'a' }])
  localStorage.setItem(
    'podium.quotes.foreign',
    JSON.stringify({
      savedAt: Date.now(),
      quotes: [{ id: 'q2', label: 'two', text: 'unattributed', source: 'b' }],
    }),
  )
  vi.setSystemTime(new Date('2026-11-16T00:00:00Z'))
  expect(loadQuotes(currentOwner, 'old')).toEqual([])
  expect(loadQuotes(currentOwner, 'foreign')).toEqual([])
  sweepQuotes(currentOwner)
  expect(currentOwner.get(QUOTES_KEY)).toBeNull()
})
