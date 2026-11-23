import '@podium/client-graph/synced-models'
import { omitGone, requireHere } from './lookup'
import { autorun, runInAction } from 'mobx'
import { lazyKeptCount } from '@podium/mobx-helpers'
import { machinePathKey } from '@podium/model/browser'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { sidebarNested } from './worklist/sidebar'
import { MODEL_CLASSES, type ModelHost } from './models'
import { worklistView } from './worklist/view-model'
import { headerModel } from './header-companion'
import { displayRefOf } from './views'
import { sessionModeReadout } from '@podium/client-core/values'
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
function fixture(worklist: 'held' | 'demand' = 'held') {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, worklist === 'demand'
    ? { worklist, load: () => undefined, schedule: () => () => {} } : undefined)
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: 'root', value: issueRow('root') as never },
    { kind: 'issue', id: 'child', value: issueRow('child', { parentId: 'root' }) as never },
    { kind: 'session', id: 'seat', value: sessionRow() as never },
  ] })
  return pool
}

it('reads live issue visibility from the row and leaves missing visibility unknown', () => {
  const pool = fixture(), issue = pool.issueObject('root')
  const seen: Array<string | undefined> = []
  const stop = autorun(() => { seen.push(issue.visibility) })
  try {
    expect(issue.visibility).toBeUndefined()
    for (const visibility of ['personal', 'secret', undefined] as const) {
      runInAction(() => pool.apply({ type: 'update', rows: [
        { kind: 'issue', id: 'root', value: issueRow('root', { visibility }) as never },
      ] }))
      expect(pool.issueObject('root')).toBe(issue)
      expect(issue.visibility).toBe(visibility)
    }
    expect(seen).toEqual([undefined, 'personal', 'secret', undefined])
  } finally { stop(); pool.dispose() }
})

it('keeps Acceptance readers isolated from title and description edits while following live Acceptance', () => {
  const pool = fixture(), issue = pool.issueObject('root')
  const initial = issueRow('root', { acceptance: 'Original acceptance.', description: 'Human description.' })
  pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'root', value: initial as never }] })
  const seen: Array<string | undefined> = []
  const stop = autorun(() => { seen.push(issue.acceptance) })
  try {
    const renamed = { ...initial, title: 'Renamed mission', description: 'Revised human description.' }
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'root', value: renamed as never },
    ] }))
    expect(seen).toEqual(['Original acceptance.'])
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'root', value: { ...renamed, acceptance: 'Revised acceptance.' } as never },
    ] }))
    expect(pool.issueObject('root')).toBe(issue)
    expect(seen).toEqual(['Original acceptance.', 'Revised acceptance.'])
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'root', value: { ...renamed, acceptance: undefined } as never },
    ] }))
    expect(seen).toEqual(['Original acceptance.', 'Revised acceptance.', undefined])
  } finally { stop(); pool.dispose() }
})

// A present parent is always placed (POD-2167: any audience at the top
// level, POD-2157: only a real parentId nests), so the parent's own nesting
// is what can still move under an unchanged parent.
it('keeps a parent-only reader asleep when its unchanged parent moves under another task', () => {
  const pool = fixture(), child = pool.worklistRow('child')!
  let parentRuns = 0, placementRuns = 0
  let parent: string | null = null, placed = false
  const stopParent = autorun(() => { parentRuns++; parent = child.nestParent })
  const stopPlacement = autorun(() => { placementRuns++; placed = child.placed })
  try {
    expect([parent, placed]).toEqual(['root', true])
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'grand', value: issueRow('grand') as never },
      { kind: 'issue', id: 'root', value: issueRow('root', { parentId: 'grand' }) as never },
    ] }))
    expect(pool.worklistRow('root')!.nestParent).toBe('grand')
    expect([parent, placed]).toEqual(['root', true])
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'root', value: issueRow('root') as never },
    ] }))
    expect([parent, placed]).toEqual(['root', true])
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

// A scalar must not allocate the rest of standing/own through eager rule
// construction. Count the existing lazy slots and guard the shared facts:
// answer equality alone would miss both unnecessary allocations and reads.
// `shared` names the issue's lazy facts a scalar's own rule reads: rescuable
// asks whether the issue is finished, and band asks for my pin (a pin record
// since POD-6692, so a lazy of the issue model).
it.each([
  ['activeHuman', true, []], ['sessionless', 'keep', []],
  ['rescuable', true, ['finished']], ['band', 1, ['pinned']],
  ['repoKey', machinePathKey('/synthetic'), []], ['foldAt', stamp, []],
] as const)('allocates only the demanded %s field and releases it after the last observer', async (field, expected, shared) => {
  const pool = fixture('demand'), root = pool.worklistRow('root')!
  const issue = root.issue, sharedNames: readonly string[] = shared
  const guards = ['excluded', 'awaitingMerge', 'parentRef', 'finishedMs', 'updatedMs',
    'lastActivityAt', 'headlessStaffed', 'finished', 'pinned']
    .filter(name => !sharedNames.includes(name))
    .map(name => vi.spyOn(issue, name as 'finished', 'get').mockImplementation(() => {
      throw new Error(`${field} demanded unrelated ${name}`)
    }))
  const reads = sharedNames.map(name => vi.spyOn(issue, name as 'finished', 'get'))
  let value: unknown, runs = 0, failure: unknown
  expect([lazyKeptCount(root), lazyKeptCount(issue)]).toEqual([0, 0])
  const stop = autorun(() => {
    try { runs++; value = root[field] } catch (error) { failure = error }
  })
  try {
    if (failure) throw failure
    expect(value).toEqual(expected)
    expect([lazyKeptCount(root), lazyKeptCount(issue)]).toEqual([1, sharedNames.length])
    for (const read of reads) expect(read).toHaveBeenCalled()
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'issue', id: 'root', value: issueRow('root', { title: 'Renamed' }) as never },
    ] }))
    if (failure) throw failure
    expect(value).toEqual(expected)
    expect(runs).toBe(1)
    for (const guard of guards) expect(guard).not.toHaveBeenCalled()
  } finally {
    stop()
    for (const spy of [...guards, ...reads]) spy.mockRestore()
    pool.dispose()
  }
  await Promise.resolve()
  expect([lazyKeptCount(root), lazyKeptCount(issue)]).toEqual([0, 0])
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

it('a session model answers what the model and mode chips read, and follows a change (POD-7002)', () => {
  // The chat view hands its chips the shared session model, not the row. A
  // field the model has no getter for reads as undefined, so the live web drew
  // neither chip for a session whose row held all of these.
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  const launchPosture = {
    requestedMode: 'auto',
    unmet: [{ requirement: 'workspace-trust', reason: 'no flag on this version' }],
  }
  pool.apply({ type: 'replace', rows: [
    { kind: 'session', id: 'seat', value: sessionRow({
      agentKind: 'claude-code',
      observedModel: 'claude-opus-5-5', observedEffort: 'high',
      requestedModel: 'claude-sonnet-5-5', requestedEffort: 'low',
      configureFields: ['model', 'effort'],
      observedMode: 'auto', launchPosture,
    }) as never },
  ] })
  const seat = requireHere(pool.model('session', 'seat'))!
  expect({
    observedModel: seat.observedModel, observedEffort: seat.observedEffort,
    requestedModel: seat.requestedModel, requestedEffort: seat.requestedEffort,
    configureFields: seat.configureFields, observedMode: seat.observedMode,
    launchPosture: seat.launchPosture,
  }).toEqual({
    observedModel: 'claude-opus-5-5', observedEffort: 'high',
    requestedModel: 'claude-sonnet-5-5', requestedEffort: 'low',
    configureFields: ['model', 'effort'], observedMode: 'auto', launchPosture,
  })
  const seen: Array<string | undefined> = []
  const stop = autorun(() => { seen.push(sessionModeReadout(seat)?.mode) })
  try {
    runInAction(() => pool.apply({ type: 'update', rows: [
      { kind: 'session', id: 'seat', value: sessionRow({ agentKind: 'claude-code', observedMode: 'default', launchPosture }) as never },
    ] }))
    expect(seen).toEqual(['auto', 'default'])
  } finally { stop(); pool.dispose() }
})
