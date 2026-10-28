import { UI_STATE_KEYS } from '@podium/client-core/ui-state'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { OFF_SCREEN, ON_SCREEN, stubTipVisibility } from '@/features/tips/test-visibility'
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

let visibility: ReturnType<typeof stubTipVisibility>
beforeEach(() => {
  account.values.clear()
  selection.id = null
  visibility = stubTipVisibility()
})
afterEach(() => {
  cleanup()
  for (const row of document.querySelectorAll('[data-tip-anchor]')) row.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The sidebar draws the task's row; like a scroll or fold, `place` reports its box. */
async function drawRow(issueId: string, rect = ON_SCREEN): Promise<HTMLElement> {
  const row = document.createElement('div')
  row.setAttribute('data-tip-anchor', `task-row:${issueId}`)
  await act(async () => {
    document.body.append(row)
  })
  act(() => visibility.place(row, rect))
  return row
}

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
  it('stays registered but inactive until the first launch opens its task', async () => {
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
    await drawRow('iss_first')
    expect(moment()?.active).toBe(true)
    expect(moment()?.cards[0]?.title).toBe('Your list.')
    expect(moment()?.cards[1]?.title).toBe('The flight deck.')
  })

  it('keeps the launched task in account UI state', () => {
    noteFirstSend(account, 'iss_first')
    expect(account.values.get(UI_STATE_KEYS.tipsFirstSend)).toBe('iss_first')
  })

  it("activates only once the launched task's row is drawn and fully on screen", async () => {
    selection.id = 'iss_first'
    const { moment } = mount()
    act(() => noteFirstSend(account, 'iss_first'))
    // The task opened before the sidebar drew its row: nothing to point at yet.
    expect(moment()?.active).toBe(false)
    const row = await drawRow('iss_first', OFF_SCREEN)
    expect(moment()?.active).toBe(false)
    act(() => visibility.place(row, ON_SCREEN))
    expect(moment()?.active).toBe(true)
  })

  it('still delivers the tip after a reload before it showed', async () => {
    selection.id = 'iss_first'
    const page = mount()
    act(() => noteFirstSend(account, 'iss_first'))
    const row = await drawRow('iss_first')
    expect(page.moment()?.active).toBe(true)
    // Reload while the tip waits behind its quiet beat: the page and its
    // memory go; the account's state stays.
    page.unmount()
    const reloaded = mount()
    await act(async () => {})
    act(() => visibility.place(row, ON_SCREEN))
    expect(reloaded.moment()?.active).toBe(true)
    expect(reloaded.moment()?.cards[0]?.anchor).toBe('task-row:iss_first')
  })

  it('clears the pending task once the moment is seen, and only then', async () => {
    selection.id = 'iss_first'
    const page = mount()
    act(() => noteFirstSend(account, 'iss_first'))
    await drawRow('iss_first')
    expect(page.moment()?.active).toBe(true)
    act(() => page.log.record('first-send', 'shown'))
    expect(account.values.get(UI_STATE_KEYS.tipsFirstSend)).toBe('iss_first')
    act(() => page.log.record('first-send', 'finished'))
    expect(account.values.has(UI_STATE_KEYS.tipsFirstSend)).toBe(false)
    expect(page.moment()?.active).toBe(false)
  })
})
