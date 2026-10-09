// @vitest-environment happy-dom
import { LOADING } from '@podium/client-graph/loading'
import { settled } from '@podium/client-graph/mission-view'
import { coldMissionRowFixture } from '@podium/client-graph/mission-row-loading.test.fixture'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HungRows, TaskRow, BAND_HEIGHT } from './FlightDeckRows'
import { type DeckWindow, deckTaskKey } from './flight-deck-window'

const state = vi.hoisted(() => ({ coarseNow: Date.parse('2026-10-09T12:00:00Z'), renameSession: vi.fn() }))
vi.mock('./store', () => ({ useRuntimeSelector: (read: (store: typeof state) => unknown) => read(state) }))
afterEach(() => cleanup())
const rail = { className: 'bg-hairline-soft', width: 1 }
const common = {
  mode: 'full' as const, rootId: 'root', inMission: new Set(['root', 'cold-task']),
  nameOf: () => undefined, activeSessionId: null, arrivals: new Set<string>(),
  settle: () => {}, onSelectSession: () => {}, onSelectNative: () => {},
}

it('cold HungRows shows loading then its real crew', async () => {
  const f = coldMissionRowFixture()
  try {
    expect(settled(() => f.row.sessionIds('needs-you'))).toBe(LOADING)
    const ui = render(<HungRows {...common} mode="needs-you" model={f.row} inset={24} rail={rail} tail={false} />)
    expect(ui.getByRole('status', { name: 'Loading agents' })).toBeDefined()
    expect(ui.container.querySelector('[data-flight-session]')).toBeNull()
    await act(async () => { f.pool.hydrate() })
    await waitFor(() => expect(ui.container.querySelectorAll('[data-flight-session]')).toHaveLength(2))
    expect(ui.container.textContent).toContain('Loaded cold agent 0')
    expect(ui.queryByRole('status')).toBeNull()
  } finally {
    cleanup()
    f.close()
  }
})

it('a cold offscreen TaskRow gains real searchable data without reading hidden payload', async () => {
  const f = coldMissionRowFixture()
  const payload = vi.spyOn(f.row, 'hasPayload', 'get').mockImplementation(() => { throw LOADING })
  const window: DeckWindow = {
    enabled: true, contains: () => false, size: () => BAND_HEIGHT,
    text: () => f.row.title, measure: () => () => {}, reveal: vi.fn(), beginFind: vi.fn(),
  }
  try {
    const ui = render(<TaskRow {...common} row={f.row} renameSeed={null} carries={[]}
      selected={false} collapsed folds={new Map()} rails={[]} agentRail={rail}
      childFollows={false} window={window} onToggle={() => {}} onSelectIssue={() => {}}
      onMenu={() => {}} onStatusPick={() => {}} onRenameIssue={() => {}} onRenameDone={() => {}} />)
    expect(ui.container.querySelector('[data-deck-placeholder]')).not.toBeNull()
    expect(ui.queryByRole('button')).toBeNull()
    await act(async () => { f.pool.hydrate() })
    await waitFor(() => expect(ui.getByRole('button', { name: 'Loaded cold task' })).toBeDefined())
    expect(ui.queryByRole('status')).toBeNull()
    expect(ui.container.querySelector(`[data-deck-placeholder="${deckTaskKey(f.row.key)}"]`)).not.toBeNull()
    expect(ui.container.querySelector('.deck-strip')).toBeNull()
    expect(payload).not.toHaveBeenCalled()
  } finally {
    cleanup()
    payload.mockRestore()
    f.close()
  }
})
