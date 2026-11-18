import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import { MissionDeckIssueModel, MissionDeckModel, missionView } from './mission-view'
import { MobxPool } from './pool'

/** The task is absent at mount; its two resident seats already name it.
 * Since POD-7094 a row reaches the device only through a feed publication
 * (the pool reads no row through a loader), so the task arrives when the test
 * calls `arrive()`, which publishes it as the feed would. */
export function coldMissionRowFixture() {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const at = new Date(now).toISOString()
  const issue = {
    id: 'cold-task',
    seq: 2,
    title: 'Loaded cold task',
    stage: 'in_progress',
    audience: 'human',
    parentId: 'root',
    deps: [],
    repoPath: '/synthetic',
    needsHuman: true,
    createdAt: at,
    updatedAt: at,
    coordinatorSessionId: 'cold-agent-0',
  }
  const seats = [0, 1].map((index) => ({
    sessionId: `cold-agent-${index}`,
    issueId: issue.id,
    cwd: '/synthetic',
    title: `Loaded cold agent ${index}`,
    agentKind: 'codex',
    status: 'exited',
    archived: false,
    createdAt: at,
    lastActiveAt: at,
    stoppedAt: at,
    agentState: { phase: 'needs_user', since: at },
  }))
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: now }, undefined, {
    schedule: () => () => {},
  })
  attachMissionTestPreferences(pool)
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'root',
        value: { ...issue, id: 'root', seq: 1, parentId: null, coordinatorSessionId: null },
      },
      ...seats.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
    ],
  })
  const deck = new MissionDeckModel(pool.issueObject('root'), missionView(pool), 'full')
  const row = new MissionDeckIssueModel(pool.issueObject(issue.id), deck, ['root', issue.id])
  const arrive = () =>
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issue.id, value: issue }] })
  return { pool, row, now, arrive, close: () => pool.dispose() }
}
