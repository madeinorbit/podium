import type { RoutedUiState } from '@podium/client-core/ui-state'
import { FLIGHT_DECK_FOLDS_KEY } from '@podium/client-core/ui-state'
import { writeFlightDeckFolds } from '@podium/client-core/values'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MissionScreen } from './mission-screen'
import { MobxPool } from './pool'
import { attachPreferenceSource } from './preference-source'

const stamp = '2026-10-07T12:00:00Z'

function fixture() {
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const ui: RoutedUiState = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
      for (const listener of listeners) listener(new Set([key]))
    },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  attachPreferenceSource(pool, ui)
  const issue = (id: string, seq: number, parentId: string | null) => ({
    kind: 'issue' as const, id, value: { id, seq, title: `Task ${id}`, stage: 'in_progress', audience: 'human', parentId,
      deps: [], repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, readAt: stamp },
  })
  const session = (sessionId: string, issueId: string, archived = false) => ({
    kind: 'session' as const, id: sessionId, value: { sessionId, issueId, cwd: '/synthetic', title: `Agent ${sessionId}`,
      name: `Agent ${sessionId}`, agentKind: 'codex', status: archived ? 'exited' : 'running', archived,
      createdAt: stamp, lastActiveAt: stamp, readAt: stamp, unread: false },
  })
  pool.apply({ type: 'replace', rows: [
    issue('root', 1, null), issue('shown', 2, 'root'), issue('branch', 3, 'root'),
    issue('hidden-a', 4, 'branch'), issue('hidden-b', 5, 'branch'),
    session('s-root', 'root'), session('s-shown', 'shown'), session('s-branch', 'branch'),
    session('s-hidden-a', 'hidden-a'), session('s-hidden-b', 'hidden-b'),
    session('s-archived-1', 'root', true), session('s-archived-2', 'shown', true),
  ] })
  return { pool, ui }
}

const flush = async () => { for (let turn = 0; turn < 5; turn++) await new Promise<void>(resolve => setTimeout(resolve, 0)) }

it('folded branches and archived crew get no display fields prepared before they are drawn', async () => {
  const { pool, ui } = fixture()
  ui.set(FLIGHT_DECK_FOLDS_KEY, writeFlightDeckFolds(new Map([['branch', 'closed']])))
  const screen = new MissionScreen(pool, 'root', { setPreference: (key, raw) => ui.set(key, raw) })
  screen.open()
  const presentation = vi.spyOn(screen.reader, 'presentation')
  const title = vi.spyOn(screen.reader, 'title')
  const archive = vi.spyOn(screen.reader, 'archive')
  const roster = vi.spyOn(screen.reader, 'roster')
  const attached = vi.spyOn(screen.reader, 'attached')
  let drawn: string[] = []
  // What the deck draws: the header, each visible strip's own fields and the
  // crew of every unfolded strip; the archive only as its count.
  const stop = autorun(() => {
    if (!screen.ready) return
    void screen.rootTitle; void screen.progress; void screen.liveCount; void screen.archivedCount
    void screen.allFolded; void screen.crewIds
    drawn = screen.visibleRows.map(row => {
      void row.title; void row.displayRef; void row.status; void row.presentation
      void row.unread(row.folded(screen.folds))
      if (!row.folded(screen.folds)) for (const id of row.sessionIds(screen.mode)) void pool.sessionObject(id).name
      return row.id
    })
  })
  try {
    await flush()
    expect(drawn).toEqual(['shown', 'branch'])
    const hidden = new Set(['hidden-a', 'hidden-b'])
    expect(presentation.mock.calls.filter(([issue]) => hidden.has(issue.id)).map(([issue]) => issue.id)).toEqual([])
    expect(title.mock.calls.filter(([issue]) => hidden.has(issue.id)).map(([issue]) => issue.id)).toEqual([])
    // Archived senders are counted from their roster flag: no archived list,
    // archived roster or whole attachment list is built before the archive opens.
    expect(archive).not.toHaveBeenCalled()
    expect(roster.mock.calls.filter(([, archived]) => archived === true)).toEqual([])
    expect(attached).not.toHaveBeenCalled()
    expect(screen.archivedCount).toBe(2)
    // Unfolding draws them: the guard sees reads when they happen.
    screen.fold('branch', false)
    await flush()
    expect(drawn).toEqual(['shown', 'branch', 'hidden-a', 'hidden-b'])
    expect(presentation.mock.calls.filter(([issue]) => hidden.has(issue.id)).map(([issue]) => issue.id).length).toBeGreaterThan(0)
  } finally { stop(); screen.close(); pool.dispose() }
})
