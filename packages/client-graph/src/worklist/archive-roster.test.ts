/**
 * POD-2129: archiving a task made its sessions flash as a `repo · branch`
 * worktree band. The issue row leaves the pool before the server parks and
 * evicts its sessions; a seat that names an issue the client no longer holds
 * must not fall through to the worktree band as an unowned guest.
 */
import { expect, it } from 'vitest'
import { requireHere } from '../lookup'
import { MobxPool } from '../pool'
import { worklistView } from './view-model'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const LANE = '/synthetic/lane'
const issue = {
  id: 'iss-1',
  seq: 1,
  title: 'Task',
  repoPath: LANE,
  stage: 'in_progress',
  audience: 'human',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-10-03T11:00:00Z',
  deps: [],
  worktreePath: LANE,
  branch: 'worktree-POD-1',
}
const session = {
  sessionId: 's-1',
  cwd: LANE,
  issueId: 'iss-1',
  agentKind: 'codex',
  status: 'live',
  archived: false,
  title: 'S',
  createdAt: '2026-01-01T00:00:00Z',
  lastActiveAt: '2026-10-03T11:59:00Z',
}

function setup() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'worktree',
        id: LANE,
        value: { path: LANE, repoPath: '/synthetic', repoName: 'Repo' } as never,
      },
      { kind: 'issue', id: issue.id, value: issue as never },
      { kind: 'session', id: session.sessionId, value: session as never },
    ],
  })
  const tree = () => worklistView(pool).tree(requireHere(pool.model('worktree', LANE)))
  return { pool, tree }
}

it('a live issue owns its seat', () => {
  const { tree } = setup()
  expect(tree().rosterIds).toEqual([])
})

it('an archived issue that is still resident keeps its seat out of the band', () => {
  const { pool, tree } = setup()
  pool.apply({
    type: 'update',
    rows: [{ kind: 'issue', id: issue.id, value: { ...issue, archived: true } as never }],
  })
  expect(tree().rosterIds).toEqual([])
})

it('an evicted issue keeps its live seat out of the band', () => {
  const { pool, tree } = setup()
  pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issue.id, value: undefined }] })
  expect(tree().rosterIds).toEqual([])
})

it('an evicted issue keeps its parked seat out of the band', () => {
  const { pool, tree } = setup()
  pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issue.id, value: undefined }] })
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'session',
        id: session.sessionId,
        value: { ...session, status: 'exited', stoppedAt: '2026-10-03T12:00:00Z' } as never,
      },
    ],
  })
  expect(tree().rosterIds).toEqual([])
})
