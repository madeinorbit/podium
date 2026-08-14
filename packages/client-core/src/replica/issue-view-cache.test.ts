/**
 * POD-1053 — a one-row change costs one row.
 *
 * The optimistic fold (`engine/overlay.ts`) hands the store a NEW `issues` array
 * whose rows are all the previous objects except the patched one. The cache used
 * to key on that array identity alone, so tucking one issue rebuilt every issue
 * view model in the project and then deep-compared its way back to row identity
 * — ~9ms at the cardinalities POD-1052 measured, paid on the optimistic paint
 * and again on the server echo.
 *
 * The counter these tests read is the point: `rowBuilds` is models actually
 * constructed. A one-row patch that moves it by more than one has put the
 * O(project) fan-out back.
 *
 * POD-1055 extends the same claim to the SERVER ECHO. Reuse used to require the
 * replica-derived snapshot to stand still, which no replica write does; now
 * `deriveIssueViews` retains the `IssueView` of an issue whose derived value did
 * not move, so a write costs the rows it actually touched.
 */
import type { IssueProjection, IssueWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { allIssueViewModels, issueViewModelProjectionStats } from './issue-view-cache'
import { createReplica, memoryStorage, type Replica } from './replica'

const COUNT = 40

function projectionAt(index: number): IssueProjection {
  return {
    id: `iss_${index}`,
    seq: index + 1,
    title: `Issue ${index}`,
    description: { value: '' },
    stage: 'in_progress',
    updatedAt: '2026-08-14T10:00:00.000Z',
    createdAt: '2026-08-14T09:00:00.000Z',
    archived: false,
    priority: 2,
    type: 'task',
    intentOrigin: 'human',
    audience: 'human',
    isDraftVessel: false,
  } as unknown as IssueProjection
}

function legacyAt(index: number, over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: `iss_${index}`,
    repoPath: '/repo',
    seq: index + 1,
    title: `Issue ${index}`,
    description: '',
    stage: 'in_progress',
    worktreePath: '/repo',
    branch: `issue/${index}`,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedByNotes: [],
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T10:00:00.000Z',
    archived: false,
    needsHuman: false,
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: 2,
    type: 'task',
    pinned: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    readAt: null,
    tuckedAt: null,
    ...over,
  } as unknown as IssueWire
}

function sessionAt(index: number, issueId: string): Record<string, unknown> {
  return {
    sessionId: `ses_${index}`,
    issueId,
    agentKind: 'claude-code',
    cwd: '/repo',
    title: `Session ${index}`,
    status: 'live',
    createdAt: '2026-08-14T09:00:00.000Z',
    lastActiveAt: '2026-08-14T10:00:00.000Z',
    archived: false,
    readAt: null,
    agentState: { phase: 'working', since: '2026-08-14T09:00:00.000Z' },
  }
}

/**
 * The rows are read back OUT of the replica rather than kept as written: that is
 * what the store does (`base()` is the replica's own arrays, folded), and the
 * replica does not promise the insertion order. Ordering matters here because
 * model-index identity is order-sensitive.
 */
function world(): {
  replica: Replica
  projections: readonly IssueProjection[]
  legacy: readonly IssueWire[]
} {
  const replica = createReplica({ storage: memoryStorage() })
  replica.applySnapshot(
    'issueProjections',
    Array.from({ length: COUNT }, (_, index) => projectionAt(index)),
  )
  replica.applySnapshot(
    'issues',
    Array.from({ length: COUNT }, (_, index) => legacyAt(index)),
  )
  replica.applySnapshot('repos', [{ id: 'repo', path: '/repo', prefix: 'POD' } as never])
  // Two issues carry a session, so the rollup inputs a retained view does NOT
  // stand for (`phase`, `lastActiveAt`) are actually exercised.
  replica.applySnapshot('sessions', [
    sessionAt(0, 'iss_0'),
    sessionAt(1, 'iss_1'),
  ] as unknown as never[])
  return {
    replica,
    projections: replica.rows('issueProjections'),
    legacy: replica.rows('issues'),
  }
}

/** What the optimistic fold produces: one new row object, every other identity kept. */
function foldedLike(
  rows: readonly IssueWire[],
  index: number,
  patch: Partial<IssueWire>,
): IssueWire[] {
  return rows.map((row, at) => (at === index ? ({ ...row, ...patch } as IssueWire) : row))
}

describe('shared issue view-model cache — incremental rebuild', () => {
  it('rebuilds ONE model for a one-row optimistic patch', () => {
    const { replica, projections, legacy } = world()
    allIssueViewModels(replica, projections, legacy)
    const before = issueViewModelProjectionStats(replica)
    expect(before.rowBuilds).toBe(COUNT)

    const tucked = foldedLike(legacy, 7, {
      tuckedAt: '2026-08-14T11:00:00.000Z',
    } as Partial<IssueWire>)
    allIssueViewModels(replica, projections, tucked)

    const after = issueViewModelProjectionStats(replica)
    expect(after.rowBuilds - before.rowBuilds).toBe(1)
  })

  it('keeps every untouched model object, and only the patched one moves', () => {
    const { replica, projections, legacy } = world()
    const first = [...allIssueViewModels(replica, projections, legacy)]

    const tucked = foldedLike(legacy, 7, {
      tuckedAt: '2026-08-14T11:00:00.000Z',
    } as Partial<IssueWire>)
    const second = allIssueViewModels(replica, projections, tucked)

    expect(second).toHaveLength(first.length)
    for (const [index, model] of second.entries()) {
      if (index === 7) expect(model).not.toBe(first[index])
      else expect(model).toBe(first[index])
    }
    expect(second[7]?.tuckedAt).toBe('2026-08-14T11:00:00.000Z')
  })

  it('rebuilds one row when the replica itself moved, not the project', () => {
    // A replica write invalidates the snapshot, and before POD-1055 that alone
    // meant every `IssueView` was a new object and every model had to be rebuilt
    // and then deep-compared back to itself. Now the derivation hands unchanged
    // issues their previous view, so the write costs the row it touched.
    const { replica, projections, legacy } = world()
    allIssueViewModels(replica, projections, legacy)
    const before = issueViewModelProjectionStats(replica)

    replica.applySnapshot('issues', foldedLike(legacy, 3, { title: 'Renamed by the server' }))
    const rows = replica.rows('issues')
    allIssueViewModels(replica, replica.rows('issueProjections'), rows)

    expect(issueViewModelProjectionStats(replica).rowBuilds - before.rowBuilds).toBe(1)
    expect(rows.find((row) => row.id === legacy[3]?.id)?.title).toBe('Renamed by the server')
  })

  it('rebuilds the models of an issue whose member session changed, and no others', () => {
    // The one model input a retained view does not stand for: `unread` and
    // `sessionSummary` read the session ROW, and a stable member id list says
    // nothing about what is behind those ids.
    const { replica, projections, legacy } = world()
    allIssueViewModels(replica, projections, legacy)
    const before = issueViewModelProjectionStats(replica)

    const sessions = replica.rows('sessions').map((session) => ({ ...session }))
    const moved = sessions[0]
    if (!moved) throw new Error('fixture has no sessions')
    replica.applySnapshot('sessions', [
      { ...moved, lastActiveAt: '2026-08-14T12:00:00.000Z' },
      ...sessions.slice(1),
    ])
    allIssueViewModels(replica, replica.rows('issueProjections'), replica.rows('issues'))

    expect(issueViewModelProjectionStats(replica).rowBuilds - before.rowBuilds).toBe(1)
  })

  it('drops an issue the replica stopped sending, however stable its view was', () => {
    // The evict/rescope bar. The retained snapshot holds a view object for every
    // issue of the previous pass; the pass iterates the CURRENT projections, so a
    // row that left the slice is never looked up and cannot come back.
    const { replica, projections, legacy } = world()
    allIssueViewModels(replica, projections, legacy)

    const evicted = projections[3]
    if (!evicted) throw new Error('fixture has no fourth issue')
    replica.applyChanges('issueProjections', [], [evicted.id])
    replica.applyChanges('issues', [], [evicted.id])
    const after = allIssueViewModels(replica, replica.rows('issueProjections'), replica.rows('issues'))

    expect(after).toHaveLength(COUNT - 1)
    expect(after.some((model) => model.id === evicted.id)).toBe(false)
  })

  it('holds the array identity when the server echoes back what optimism painted', () => {
    // The second half of the press: truth lands carrying the same visible values
    // the overlay already painted. Every model must come back identical BY
    // IDENTITY, or the published worklist re-derives over the whole project for
    // a change nobody can see.
    const { replica, projections, legacy } = world()
    const painted = foldedLike(legacy, 7, {
      tuckedAt: '2026-08-14T11:00:00.000Z',
    } as Partial<IssueWire>)
    const optimistic = allIssueViewModels(replica, projections, painted)

    replica.applySnapshot('issues', painted)
    const echoed = allIssueViewModels(
      replica,
      replica.rows('issueProjections'),
      replica.rows('issues'),
    )

    expect(echoed).toBe(optimistic)
  })

  it('drops an evicted row rather than remembering it', () => {
    // The bar `viewmodels/slices/publish.ts` sets: a row can leave the
    // principal's slice without being deleted, and no cache may keep painting it.
    const { replica, projections, legacy } = world()
    allIssueViewModels(replica, projections, legacy)

    const scoped = [...projections].filter((row) => row.id !== 'iss_7')
    const models = allIssueViewModels(replica, scoped, legacy)

    expect(models).toHaveLength(COUNT - 1)
    expect(models.some((model) => model.id === 'iss_7')).toBe(false)
  })

  it('drops an evicted row even when the replica rescoped underneath it', () => {
    const { replica, projections, legacy } = world()
    allIssueViewModels(replica, projections, legacy)

    const keptProjections = [...projections].filter((row) => row.id !== 'iss_7')
    const keptLegacy = [...legacy].filter((row) => row.id !== 'iss_7')
    replica.applySnapshot('issueProjections', keptProjections)
    replica.applySnapshot('issues', keptLegacy)
    const models = allIssueViewModels(
      replica,
      replica.rows('issueProjections'),
      replica.rows('issues'),
    )

    expect(models.some((model) => model.id === 'iss_7')).toBe(false)
  })
})
