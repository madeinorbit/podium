import { omitGone, requireHere } from './lookup'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { sidebarNested } from './worklist/sidebar'
import { MODEL_CLASSES, type ModelHost } from './models'
import { worklistView } from './worklist/view-model'
import { headerModel } from './header-companion'
import { displayRefOf } from './views'
import { aggregatePartOf, LOADING, ownAttentionPartOf, unitOwnPartOf, unitsBelowPartOf } from './worklist/rollup'

/**
 * POD-5370: Vite, Bun and this runner DEFINE a constructor parameter property
 * (own property over anything on the prototype); Babel's TypeScript transform,
 * which the phone's Metro build uses, ASSIGNS it, so a prototype accessor of
 * the same name intercepts it (a getter-only one throws). Every model must
 * construct the same way under both, which this checks by doing the
 * assignment the phone build's constructor does.
 */
it('every model member assigns as the phone build constructs it, through no prototype accessor', () => {
  for (const [entity, Model] of Object.entries(MODEL_CLASSES)) {
    const defined = new Model('row-1', {} as ModelHost) as unknown as Record<string, unknown>
    const assigned = Object.create(Model.prototype) as Record<string, unknown>
    for (const member of Object.keys(defined)) {
      expect(() => {
        assigned[member] = defined[member]
      }, `${entity}.${member}`).not.toThrow()
      expect(Object.hasOwn(assigned, member), `${entity}.${member} is the instance's own`).toBe(true)
      expect(assigned[member], `${entity}.${member}`).toBe(defined[member])
    }
    expect(assigned.id, `${entity}.id`).toBe('row-1')
  }
})

const stamp = '2026-10-07T12:00:00Z'
const issueRow = (id: string, patch: object = {}) => ({
  id, seq: 1, title: id, stage: 'planning', audience: 'human',
  repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, ...patch,
})
const sessionRow = (patch: object = {}) => ({
  sessionId: 'seat', issueId: 'root', cwd: '/synthetic', agentKind: 'codex',
  status: 'live', lastActiveAt: stamp, archived: false,
  agentState: { phase: 'working', since: stamp }, ...patch,
})
function fixture() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: 'root', value: issueRow('root') as never },
    { kind: 'issue', id: 'child', value: issueRow('child', { parentId: 'root' }) as never },
    { kind: 'session', id: 'seat', value: sessionRow() as never },
  ] })
  return pool
}

it.each([true, false])('a cold reference uses only declared identity (%s) without requesting its payload', declared => {
  const schedule = vi.fn(() => () => {})
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    load: () => undefined, schedule, summaries: { issue: declared ? ['seq', 'repoPath'] : [] },
  })
  pool.apply({ type: 'replace', rows: [
    { kind: 'repo', id: '/synthetic', value: { id: '/synthetic', path: '/synthetic', prefix: 'POD' } as never },
    { kind: 'issue', id: 'cold-ref', value: issueRow('cold-ref', {
      seq: 0, repoId: '/synthetic', stage: 'done', closedAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
    }) as never },
  ] })
  try {
    const stored = omitGone(pool.row('issue', 'cold-ref', 'summary-fields'))
    expect(stored && stored !== LOADING ? Reflect.get(stored, 'seq') : undefined).toBe(declared ? 0 : undefined)
    expect(pool.issueObject('cold-ref').displayRef).toBe(declared ? displayRefOf(0, 'POD') : '')
    expect(pool.tables.issue.has('cold-ref')).toBe(false)
    expect(schedule).not.toHaveBeenCalled()
    expect(pool.issueObject('missing-ref').displayRef).toBe('')
  } finally { pool.dispose() }
})

it('keeps a parent-only reader asleep when its unchanged parent becomes unplaced', () => {
  const pool = fixture(), child = pool.worklistRow('child')!
  let parentRuns = 0, placementRuns = 0
  let parent: string | null = null, placed = false
  const stopParent = autorun(() => { parentRuns++; parent = child.nestParent })
  const stopPlacement = autorun(() => { placementRuns++; placed = child.placed })
  try {
    expect(parent).toBe('root')
    expect(placed).toBe(true)
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'root', value: issueRow('root', { audience: 'agent' }) as never },
    ] }))
    expect(parent).toBe('root')
    expect(placed).toBe(false)
    expect(parentRuns).toBe(1)
    expect(placementRuns).toBe(2)
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'root', value: issueRow('root') as never },
    ] }))
    expect(placed).toBe(true)
    expect(parentRuns).toBe(1)
  } finally { stopParent(); stopPlacement(); pool.dispose() }
})

it('the sidebar uses the shared parent answer without demanding child placement', () => {
  const pool = fixture(), root = pool.worklistRow('root')!, child = pool.worklistRow('child')!
  const placement = vi.spyOn(child, 'placed', 'get').mockImplementation(() => {
    throw new Error('A parent-only reader demanded placement')
  })
  const stop = autorun(() => { expect(sidebarNested(root, pool)).toEqual(['child']) })
  try { expect(placement).not.toHaveBeenCalled() }
  finally { stop(); placement.mockRestore(); pool.dispose() }
})

it('resident, ordering and finished readers ignore a title change', () => {
  const pool = fixture(), root = pool.worklistRow('root')!
  let stateRuns = 0, finishedRuns = 0, rankRuns = 0, titleRuns = 0
  const stops = [
    autorun(() => { stateRuns++; void root.ownFacts.state }),
    autorun(() => { finishedRuns++; void root.standing?.finished }),
    autorun(() => { rankRuns++; void root.rank }),
    autorun(() => { titleRuns++; void root.title }),
  ]
  try {
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'root', value: issueRow('root', { title: 'Renamed' }) as never },
    ] }))
    expect([stateRuns, finishedRuns, rankRuns, titleRuns]).toEqual([1, 1, 1, 2])
    expect(root.title).toBe('Renamed')
  } finally { for (const stop of stops) stop(); pool.dispose() }
})

it('roster IDs do not change when headless own presence changes', () => {
  const pool = fixture(), root = pool.worklistRow('root')!
  let runs = 0, ids: readonly string[] = []
  const stop = autorun(() => { runs++; ids = root.rosterIds })
  const before = ids
  try {
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'session', id: 'headless', value: sessionRow({ sessionId: 'headless', headless: true }) as never },
    ] }))
    expect(ids).toBe(before)
    expect(runs).toBe(1)
  } finally { stop(); pool.dispose() }
})

it('session ownership reads do not demand the independent worktree link', () => {
  const pool = fixture(), seat = requireHere(pool.model('session', 'seat'))!
  const worktree = vi.spyOn(seat, 'worktreeLink', 'get').mockImplementation(() => {
    throw new Error('An issue-only reader demanded the worktree link')
  })
  const stop = autorun(() => { expect(seat.issueLink).toBe('root') })
  try { expect(worktree).not.toHaveBeenCalled() }
  finally { stop(); worktree.mockRestore(); pool.dispose() }
})

it('archive, host-location and seat-motion readers ignore independent cursor and title edits', () => {
  const pool = fixture(), seat = requireHere(pool.model('session', 'seat'))!
  const row = worklistView(pool).session(seat), header = headerModel(pool).session(seat)
  let archiveRuns = 0, hostRuns = 0, workingRuns = 0, titleRuns = 0
  const stops = [
    autorun(() => { archiveRuns++; void row.retention?.archived }),
    autorun(() => { hostRuns++; void header.headerHost?.cwd }),
    autorun(() => { workingRuns++; const verdict = row.verdict; if (verdict && typeof verdict !== 'symbol') void verdict.working }),
    autorun(() => { titleRuns++; void header.headerWorking?.title }),
  ]
  try {
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'session', id: 'seat', value: sessionRow({ title: 'Renamed seat', readAt: stamp }) as never },
    ] }))
    expect([archiveRuns, hostRuns, workingRuns, titleRuns]).toEqual([1, 1, 1, 2])
  } finally { for (const stop of stops) stop(); pool.dispose() }
})


it('an unknown row keeps the previous progress defaults while its formal child remains', () => {
  const pool = fixture(), root = pool.worklistRow('root')!
  runInAction(() => pool.apply({ type: 'update', rows: [
    { kind: 'issue', id: 'child', value: issueRow('child', { parentId: 'root', closedReason: 'done', closedAt: stamp }) as never },
  ] }))
  let progress: readonly number[] = []
  const stop = autorun(() => { progress = [root.progressDone, root.progressTotal] })
  try {
    expect(progress).toEqual([1, 1])
    runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'root', value: undefined }] }))
    expect(root.unitsBelow.units).toBe(1)
    expect(progress).toEqual([0, 0])
  } finally { stop(); pool.dispose() }
})

it('a working reader never demands seat order or sidebar facts', () => {
  const pool = fixture(), root = pool.worklistRow('root')!
  const readSeat = pool.rollupInputs.seat
  const guard = vi.spyOn(pool.rollupInputs, 'seat').mockImplementation(id => {
    const seat = readSeat(id)
    if (seat === LOADING || seat === undefined) return seat
    return new Proxy(seat, {
      get(target, key, receiver) {
        if (key === 'sidebarFacts' || key === 'sidebarOrder' || key === 'id')
          throw new Error(`Working demanded unrelated ${String(key)}`)
        return Reflect.get(target, key, receiver)
      },
    })
  })
  let working = false
  const stop = autorun(() => { working = root.aggregate.working })
  try {
    expect(working).toBe(true)
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'session', id: 'seat', value: sessionRow({ agentState: { phase: 'waiting', since: stamp } }) as never },
    ] }))
    expect(working).toBe(false)
  } finally { stop(); guard.mockRestore(); pool.dispose() }
})

it('progress counts do not acquire staffing or seat presence', () => {
  const pool = fixture(), root = pool.worklistRow('root')!, child = pool.worklistRow('child')!
  const guards = [root, child].map(model => vi.spyOn(model, 'openOwn', 'get').mockImplementation(() => {
    throw new Error('A count demanded staffing')
  }))
  let counts: readonly number[] = []
  const stop = autorun(() => { counts = [root.progressDone, root.progressTotal] })
  try {
    expect(counts).toEqual([0, 1])
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'child', value: issueRow('child', { parentId: 'root', closedReason: 'done', closedAt: stamp }) as never },
    ] }))
    expect(counts).toEqual([1, 1])
    for (const guard of guards) expect(guard).not.toHaveBeenCalled()
  } finally { stop(); for (const guard of guards) guard.mockRestore(); pool.dispose() }
})

it('all demanded attention and progress fields equal the eager parts, including a formal cycle', () => {
  const pool = fixture()
  runInAction(() => pool.apply({ type: 'update', rows: [
    { kind: 'issue', id: 'root', value: issueRow('root', { parentId: 'child', stage: 'review' }) as never },
    { kind: 'issue', id: 'leaf', value: issueRow('leaf', { parentId: 'child', closedAt: stamp, closedReason: 'done' }) as never },
    { kind: 'session', id: 'leaf-seat', value: sessionRow({ sessionId: 'leaf-seat', issueId: 'leaf', agentState: { phase: 'waiting', since: '1969-12-31T23:59:59Z' } }) as never },
  ] }))
  let failure: unknown
  const stop = autorun(() => {
    try {
      for (const id of ['root', 'child', 'leaf']) {
        const model = pool.worklistRow(id)!
        expect(model.ownAttention, `${id} own`).toEqual(ownAttentionPartOf(pool.rollupInputs, model))
        expect(model.aggregate, `${id} aggregate`).toEqual(aggregatePartOf(pool.rollupInputs, id, model))
        expect(model.unitOwn, `${id} unit`).toEqual(unitOwnPartOf(pool.rollupInputs, id, model))
        expect(model.unitsBelow, `${id} closure`).toEqual(unitsBelowPartOf(pool.rollupInputs, id))
      }
    } catch (error) { failure = error }
  })
  try {
    if (failure !== undefined) throw failure
    expect(pool.worklistRow('root')!.unitsBelow.members).toBe(2)
  }
  finally { stop(); pool.dispose() }
})
