import { MissionScreen } from '@podium/client-graph/mission-screen'
import { MobxPool } from '@podium/client-graph/pool'
import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
import { autorun } from 'mobx'
import { WaterfallView } from './waterfall-view'

export const NOW = Date.parse('2026-10-07T12:00:00Z')
export async function waterfallFixture(count = 12) {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: NOW })
  attachMissionTestPreferences(pool)
  const rows = []
  for (let i = 0; i < count; i++) {
    const id = i === 0 ? 'root' : `row-${i}`
    rows.push({ kind: 'issue' as const, id, value: {
      id, seq: i + 1, title: `Task ${id}`, stage: 'in_progress', audience: 'human',
      parentId: i === 0 ? null : 'root', sortKey: String(i).padStart(5, '0'),
      deps: [], repoPath: '/synthetic', createdAt: new Date(NOW - 3600000).toISOString(),
      updatedAt: new Date(NOW).toISOString(), coordinatorSessionId: `s-${i}-0`,
    } })
    for (let seat = 0; seat < 7; seat++) rows.push({ kind: 'session' as const, id: `s-${i}-${seat}`, value: {
      sessionId: `s-${i}-${seat}`, issueId: id, cwd: '/synthetic', agentKind: 'codex',
      title: `Agent ${seat}`, status: seat < 2 ? 'running' : 'exited', archived: false,
      createdAt: new Date(NOW - (60 + seat) * 60000).toISOString(),
      lastActiveAt: new Date(NOW - (seat < 2 ? 0 : 10) * 60000).toISOString(),
      stoppedAt: seat < 2 ? null : new Date(NOW - 10 * 60000).toISOString(),
      agentState: { phase: seat < 2 ? 'working' : 'ended', since: new Date(NOW - 60000).toISOString() },
    } })
  }
  pool.apply({ type: 'replace', rows })
  const screen = new MissionScreen(pool, 'root', { development: true })
  screen.open()
  const view = new WaterfallView(screen)
  view.open(NOW)
  const stop = autorun(() => void screen.ready)
  for (let turn = 0; turn < 6; turn++) await new Promise<void>(resolve => setTimeout(resolve, 0))
  return { pool, screen, view, close: () => { stop(); view.close(); screen.close(); pool.dispose() } }
}

