import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobxPool } from '@podium/client-graph'
import { MessageLedger } from '@podium/client-graph/message-ledger'
import { PanelVisible } from '@/app/panel-visible'
import { useLedgerVisibility } from './ledger-visibility'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

function fixture() {
  const pool = new MobxPool({ selectedIssueId: null })
  const ledgerRequest = vi.fn(async () => [])
  return { pool, ledgerRequest, ledger: new MessageLedger(pool, { ledger: ledgerRequest }) }
}

it('keeps a mounted hidden panel quiet and polls only between showing and hiding it', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { pool, ledger, ledgerRequest } = fixture()
  let visible = false
  const wrapper = ({ children }: { children: ReactNode }) => <PanelVisible visible={visible}>{children}</PanelVisible>
  const view = renderHook(() => useLedgerVisibility(ledger), { wrapper })
  try {
    expect(ledgerRequest).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    visible = true
    view.rerender()
    await act(async () => {})
    expect(ledgerRequest).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(ledgerRequest).toHaveBeenCalledTimes(2)
    visible = false
    view.rerender()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(ledgerRequest).toHaveBeenCalledTimes(2)
  } finally { view.unmount(); ledger.dispose(); pool.dispose() }
  expect(vi.getTimerCount()).toBe(0)
})

it('suspends a visible panel for document hiding and refreshes immediately on return', async () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { pool, ledger, ledgerRequest } = fixture()
  const view = renderHook(() => useLedgerVisibility(ledger))
  try {
    await act(async () => {})
    expect(ledgerRequest).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(ledgerRequest).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(ledgerRequest).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally { view.unmount(); ledger.dispose(); pool.dispose() }
})
