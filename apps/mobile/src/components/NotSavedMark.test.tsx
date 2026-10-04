import type { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import * as Clipboard from 'expo-clipboard'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler, useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { refusalFixture } from '../../../../packages/worklist-proto/harness/src/refusal-fixture'
import { measureWork } from '../../../../packages/worklist-proto/harness/src/work-meter'
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
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('  phone words\nverbatim  '))
  expect(f.outbox.pending()).toHaveLength(0)
  expect(f.outbox.deadLetters()).toHaveLength(1)
  f.setOnline(false)
  fireEvent.click(screen.getByTestId('outbox-retry'))
  await waitFor(() => expect(screen.queryByTestId('not-saved')).toBeNull())
  expect(f.outbox.deadLetters()).toHaveLength(0)
  expect(screen.getByText('phone words verbatim')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
})

it('phone Copy keeps pool work and React commits flat at 1x and 4x', async () => {
  const samples: { scale: number; issues: number; commits: number; copy: Awaited<ReturnType<typeof measureWork>>['work'] }[] = []
  for (const scale of [1, 4] as const) {
    const f = state.current = await refusalFixture(scale)
    let commits = 0
    try {
      render(<Profiler id="phone recovery" onRender={() => { commits++ }}>
        <PoolWorkRowSlot item={{ kind: 'issue', id: f.id, listKey: f.id }} navPending={false}
          onOpenIssue={() => {}} onOpenSession={() => {}} onLongPress={() => {}} onTuck={() => {}} />
        <OutboxRecoveryPanel />
      </Profiler>)
      const authored = '  copy meter words\nverbatim  '
      await act(async () => { f.pool.mutate('issueUpdate', { id: f.id, patch: { title: authored } }) })
      await act(async () => { f.setOnline(true) })
      await waitFor(() => expect(screen.getByTestId('not-saved')).toBeTruthy())
      const copy = screen.getByRole('button', { name: 'Copy' })
      vi.mocked(Clipboard.setStringAsync).mockClear()
      commits = 0
      const measured = await measureWork(async () => {
        await act(async () => { fireEvent.click(copy) })
      }, { pool: f.pool })
      expect(Clipboard.setStringAsync).toHaveBeenCalledExactlyOnceWith(authored)
      expect(f.outbox.deadLetters()).toHaveLength(1)
      expect(f.pool.notSaved('issue', f.id)).toBe(true)
      expect(commits).toBe(0)
      expect(measured.work).toMatchObject({ derivations: 0, rows: 0, elements: 0, visits: 0 })
      samples.push({ scale, issues: f.ctx.corpus.issues.length, commits, copy: measured.work })
    } finally { cleanup(); f.dispose(); state.current = null }
  }
  console.info('[phone copy work]', JSON.stringify(samples))
})
