import { UI_STATE_KEYS } from '@podium/client-core/ui-state'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { TipContext } from '@/features/tips/tip-context'
import type { TipEngine } from '@/features/tips/tip-engine'
import type { TipMoment } from '@/features/tips/types'
import { FirstSendTip, FLIGHT_DECK_ANCHOR, noteFirstSend } from './first-send-tip'

/** The open task, subscribed like the runtime store's selector. */
const selection = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  let id: string | null = null
  return {
    listeners,
    get id() {
      return id
    },
    set id(next: string | null) {
      id = next
      for (const listener of [...listeners]) listener()
    },
  }
})
vi.mock('@/app/store', async () => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (listener: () => void) => {
    selection.listeners.add(listener)
    return () => selection.listeners.delete(listener)
  }
  return {
    useRuntimeSelector: (pick: (s: { selectedIssueId: string | null }) => unknown) =>
      useSyncExternalStore(subscribe, () => pick({ selectedIssueId: selection.id })),
  }
})

/** The account's UI state: outlives any one page, like the replicated layout row. */
const account = vi.hoisted(() => {
  const values = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    values,
    listeners,
    set(key: string, value: string | null) {
      if (value === null) values.delete(key)
      else values.set(key, value)
      for (const listener of [...listeners]) listener()
    },
  }
})
vi.mock('@/lib/use-persisted-ui-state', async () => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (listener: () => void) => {
    account.listeners.add(listener)
    return () => account.listeners.delete(listener)
  }
  return {
    usePersistedUiState: <T,>(
      key: string,
      parse: (raw: string | null) => T,
      serialize: (value: T) => string | null,
    ): [T, (next: T) => void] => {
      const raw = useSyncExternalStore(subscribe, () => account.values.get(key) ?? null)
      return [parse(raw), (next: T) => account.set(key, serialize(next))]
    },
  }
})

beforeEach(() => {
  account.values.clear()
  selection.id = null
})
afterEach(cleanup)

function mount(log = new MemoryTipLog()) {
  let read: (() => TipMoment) | undefined
  const engine = {
    log,
    register: vi.fn((_id: string, next: () => TipMoment) => {
      read = next
      return () => {}
    }),
    refresh: vi.fn(),
  }
  const ui = () => (
    <TipContext.Provider value={engine as unknown as TipEngine}>
      <FirstSendTip />
    </TipContext.Provider>
  )
  const view = render(ui())
  return { engine, log, unmount: view.unmount, moment: () => read?.() }
}

describe('first-send moment', () => {
  it('stays registered but inactive until the first launch opens its task', () => {
    selection.id = 'iss_other'
    const { engine, moment } = mount()
    expect(engine.register).toHaveBeenCalledWith('first-send', expect.any(Function))
    expect(moment()?.active).toBe(false)
    // Registered for replay against the open task's row.
    expect(moment()?.cards.map((c) => c.anchor)).toEqual(['task-row:iss_other', FLIGHT_DECK_ANCHOR])

    act(() => noteFirstSend(account, 'iss_first'))
    expect(moment()?.active).toBe(false)
    expect(moment()?.cards[0]?.anchor).toBe('task-row:iss_first')

    act(() => {
      selection.id = 'iss_first'
    })
    expect(moment()?.active).toBe(true)
    expect(moment()?.cards[0]?.title).toBe('Your list.')
    expect(moment()?.cards[1]?.title).toBe('The flight deck.')
  })

  it('keeps the launched task in account UI state', () => {
    noteFirstSend(account, 'iss_first')
    expect(account.values.get(UI_STATE_KEYS.tipsFirstSend)).toBe('iss_first')
  })

  it('still delivers the tip after a reload before it showed', () => {
    selection.id = 'iss_first'
    const page = mount()
    act(() => noteFirstSend(account, 'iss_first'))
    expect(page.moment()?.active).toBe(true)
    // Reload while the tip waits behind its quiet beat: the page and its
    // memory go; the account's state stays.
    page.unmount()
    const reloaded = mount()
    expect(reloaded.moment()?.active).toBe(true)
    expect(reloaded.moment()?.cards[0]?.anchor).toBe('task-row:iss_first')
  })

  it('clears the pending task once the moment is seen, and only then', () => {
    selection.id = 'iss_first'
    const page = mount()
    act(() => noteFirstSend(account, 'iss_first'))
    act(() => page.log.record('first-send', 'shown'))
    expect(account.values.get(UI_STATE_KEYS.tipsFirstSend)).toBe('iss_first')
    act(() => page.log.record('first-send', 'finished'))
    expect(account.values.has(UI_STATE_KEYS.tipsFirstSend)).toBe(false)
    expect(page.moment()?.active).toBe(false)
  })
})
