import type { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import * as Clipboard from 'expo-clipboard'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { refusalFixture } from '../../../../../packages/worklist-proto/harness/src/refusal-fixture'
import { PoolWorkRowSlot } from '../screens/WorkListRow'
import { OutboxRecoveryPanel } from './OutboxRecoveryPanel'

const state = vi.hoisted(() => ({ current: null as Awaited<ReturnType<typeof refusalFixture>> | null }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }))
vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => ({ getSnapshot: () => ({ recoverOutbox: {
    retry: state.current!.outbox.retry.bind(state.current!.outbox),
    edit: state.current!.outbox.edit.bind(state.current!.outbox),
    discard: state.current!.outbox.discard.bind(state.current!.outbox),
  } }) }),
}))
vi.mock('../client/mobile-pool', () => ({
  useMobilePoolProjection: (read: (pool: MobxPool) => unknown) => {
    const view = useMemo(() => createPoolProjection(state.current!.pool, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot)
  },
}))

afterEach(() => { cleanup(); state.current?.dispose(); state.current = null; vi.clearAllMocks() })

it('keeps refused words copyable on the phone, rolls back and marks the work row, then clears the mark on retry', async () => {
  const f = state.current = await refusalFixture()
  render(<><PoolWorkRowSlot item={{ kind: 'issue', id: f.id, listKey: f.id }} navPending={false}
    onOpenIssue={() => {}} onOpenSession={() => {}} onLongPress={() => {}} onTuck={() => {}} />
    <OutboxRecoveryPanel /></>)
  expect(screen.getByText(f.original)).toBeTruthy()
  await act(async () => { f.pool.mutate('issueUpdate', { id: f.id, patch: { title: '  phone words\nverbatim  ' } }) })
  expect(screen.getByText('phone words verbatim')).toBeTruthy()
  await act(async () => { f.setOnline(true) })
  await waitFor(() => expect(screen.getByTestId('not-saved').textContent).toBe('not saved'))
  expect(screen.getByText(f.original)).toBeTruthy()
  expect(screen.getByText('phone words verbatim')).toBeTruthy()
  const words = screen.getByText('phone words verbatim')
  expect(getComputedStyle(words).userSelect).toBe('text')
  fireEvent.click(screen.getByRole('button', { name: 'Copy', exact: true }))
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('  phone words\nverbatim  '))
  expect(f.outbox.pending()).toHaveLength(0)
  expect(f.outbox.deadLetters()).toHaveLength(1)
  f.setOnline(false)
  fireEvent.click(screen.getByTestId('outbox-retry'))
  await waitFor(() => expect(screen.queryByTestId('not-saved')).toBeNull())
  expect(f.outbox.deadLetters()).toHaveLength(0)
  expect(screen.getByText('phone words verbatim')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Copy', exact: true })).toBeNull()
})
