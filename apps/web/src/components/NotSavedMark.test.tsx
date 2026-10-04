// @vitest-environment happy-dom
import type { MobxPool } from '@podium/client-graph/pool'
import { observer } from '@podium/client-graph/react'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { refusalFixture } from '../../../../packages/worklist-proto/harness/src/refusal-fixture'
import { OutboxRecoveryIndicator } from '../features/machines/OutboxRecovery'
import { poolIssueDisplay, poolIssueRow } from '../features/worklist/pool-row-data'
import { UnifiedIssueRow } from '../features/worklist/UnifiedIssueRow'

const state = vi.hoisted(() => ({ current: null as Awaited<ReturnType<typeof refusalFixture>> | null }))
const copied = vi.hoisted(() => vi.fn())
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: copied }))
vi.mock('@/app/store', () => ({ useRuntimeSelector: (read: (state: object) => unknown) => read({ paneA: null }) }))
vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => ({ getSnapshot: () => ({ recoverOutbox: {
    retry: state.current!.outbox.retry.bind(state.current!.outbox),
    edit: state.current!.outbox.edit.bind(state.current!.outbox),
    discard: state.current!.outbox.discard.bind(state.current!.outbox),
  } }) }),
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => state.current!.pool,
  useWorklistPoolProjection: (read: (pool: MobxPool) => unknown) => {
    const view = useMemo(() => createPoolProjection(state.current!.pool, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot)
  },
}))

const Row = observer(function Row() {
  const f = state.current!
  const value = f.pool.sidebar.row(f.id)
  if (!value || typeof value === 'symbol') return null
  return <UnifiedIssueRow row={poolIssueRow(value)} display={poolIssueDisplay(value)} now={f.ctx.corpus.fixedNow}
    onSelectIssue={() => {}} onSelectPanelForIssue={() => {}} onOpenIssue={() => {}} onRenameIssue={() => {}} />
})

afterEach(() => { cleanup(); state.current?.dispose(); state.current = null; copied.mockClear() })

it('refuses a real pool change, rolls back its row, marks it, copies its input, and clears the mark on retry', async () => {
  const f = state.current = await refusalFixture()
  render(<><Row /><OutboxRecoveryIndicator /></>)
  const row = () => document.querySelector(`[data-issue-row="${f.id}"]`)!
  expect(row().textContent).toContain(f.original)
  await act(async () => { f.pool.mutate('issueUpdate', { id: f.id, patch: { title: '  my refused words\nverbatim  ' } }) })
  expect(row().textContent).toContain('my refused words')
  expect(screen.queryByTestId('not-saved')).toBeNull()
  await act(async () => { f.setOnline(true) })
  await waitFor(() => expect(screen.getByTestId('not-saved').textContent).toBe('not saved'))
  expect(row().textContent).toContain(f.original)
  expect(row().textContent).not.toContain('my refused words')
  expect(f.outbox.pending()).toHaveLength(0)
  fireEvent.click(screen.getByTestId('outbox-recovery-chip'))
  await waitFor(() => expect(screen.getByTestId('outbox-copy')).toBeTruthy())
  expect(screen.getByText('my refused words verbatim', { exact: false })).toBeTruthy()
  fireEvent.click(screen.getByTestId('outbox-copy'))
  expect(copied).toHaveBeenCalledWith('  my refused words\nverbatim  ', 'Copied your text')
  f.accept()
  f.setOnline(false)
  fireEvent.click(screen.getByTestId('outbox-retry'))
  await waitFor(() => expect(screen.queryByTestId('not-saved')).toBeNull())
  expect(f.outbox.deadLetters()).toHaveLength(0)
  expect(row().textContent).toContain('my refused words')
})
