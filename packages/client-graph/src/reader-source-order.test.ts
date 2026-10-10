// @vitest-environment happy-dom
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA, type ModelSchema } from './shared/schema'
import * as sessionQuestions from './shared/session-questions'
import type { RowRecord, RowSourceEvent } from './shared/source'

const stamp = '2026-10-01T00:00:00Z'
const session = (id: string, group?: string, patch: object = {}): RowRecord => ({
  kind: 'session', id, value: {
    sessionId: id, cwd: '/repo/nested', issueId: 'one', agentKind: 'codex', status: 'hibernated',
    archived: false, headless: false, machineId: 'machine', createdAt: stamp, lastActiveAt: stamp,
    refRepoId: 'repo', refSeq: 1, refLetter: 'A',
    ...(group ? { resume: { kind: 'codex', value: group } } : {}), ...patch,
  },
} as RowRecord)
const seed = () => [
  { kind: 'repo', id: 'repo', value: { id: 'repo', prefix: 'POD', repoPath: '/repo' } } as RowRecord,
  session('a', 'primary', { status: 'exited' }), session('z', 'primary'), session('b'),
  session('0', 'other', { status: 'exited', refSeq: 2, refLetter: 'B', machineId: 'elsewhere' }),
  session('y', 'other', { refSeq: 2, refLetter: 'B', machineId: 'elsewhere' }),
]
const difference = (after: Readonly<Record<string, number>>, before: Readonly<Record<string, number>>) =>
  Object.fromEntries(Object.entries(after).map(([key, count]) => [key, count - before[key]!]))

it.each([false, true])('counts order-only incidence and family work before equality barriers (external: %s)', external => {
  let coldQuestions: sessionQuestions.SessionQuestions | undefined
  const create = sessionQuestions.createSessionQuestions
  const spy = vi.spyOn(sessionQuestions, 'createSessionQuestions').mockImplementation((...args) => {
    coldQuestions = create(...args)
    return coldQuestions
  })
  const source = external ? createColdIndex(SCHEMA) : undefined
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    ...(source ? { cold: () => source } : {}), load: () => undefined, schedule: () => () => {},
  })
  const apply = (event: RowSourceEvent) => { source?.apply(event); pool.apply(event) }
  const incidence = { publications: 0, heartbeatPublications: 0, orderOnlyPublications: 0,
    orderOnlyAddresses: 0, visibilityFlips: 0 }
  try {
    apply({ type: 'replace', rows: seed() })
    const index = source ?? pool.coldIndex()
    expect(coldQuestions).toBeDefined()
    for (let turn = 0; turn < 4; turn++) {
      for (let heartbeat = 0; heartbeat < 32; heartbeat++) {
        const event: RowSourceEvent = { type: 'update', rows: [session('z', 'primary', {
          lastActiveAt: new Date(Date.parse(stamp) + (turn * 32 + heartbeat + 1) * 1000).toISOString(),
        })] }
        apply(event)
        const delta = index.changes(event)
        incidence.publications++; incidence.heartbeatPublications++
        expect(delta.orders).toEqual([]); expect(delta.flips).toEqual([])
      }
      // Moving a loser between two collapsed groups preserves every visibility
      // verdict but changes z's canonical order between a and z.
      const beforeCold = { ...coldQuestions!.updates }, beforeResident = pool.queries.residentUpdates
      const event: RowSourceEvent = { type: 'update', rows: [session('a', turn % 2 ? 'primary' : 'other', { status: 'exited' })] }
      apply(event)
      const delta = index.changes(event)
      incidence.publications++
      incidence.visibilityFlips += delta.flips.length
      expect(delta.flips).toEqual([])
      expect(delta.orders).toEqual([['session', 'z']])
      incidence.orderOnlyPublications++; incidence.orderOnlyAddresses += delta.orders.length
      const cold = difference(coldQuestions!.updates, beforeCold)
      const resident = difference(pool.queries.residentUpdates, beforeResident)
      console.info('[source order family work]', JSON.stringify({ external, turn, cold, resident }))
      const expected = { close: 0, setupCount: 0, setupAgent: 0, reference: 1,
        triage: 0, recent: 0, machine: 1, activity: 0 }
      expect(cold).toEqual(expected)
      expect(resident).toEqual({ sessionFacets: 0, ...expected })
    }
    console.info('[source order incidence: deterministic replay]', JSON.stringify({ external, ...incidence }))
    expect(incidence).toEqual({ publications: 132, heartbeatPublications: 128,
      orderOnlyPublications: 4, orderOnlyAddresses: 4, visibilityFlips: 0 })
  } finally { pool.dispose(); spy.mockRestore() }
})

const ids = ['0', 'a', 'b', 'y', 'z', 'late']
const activityQuestions = ['/repo', '/repo/nested', '/other'].flatMap(root =>
  (['within', 'exact'] as const).flatMap(match => [false, true].map(agentsOnly => ({
    kind: 'commandRootActivity' as const, roots: [root], match, agentsOnly,
  }))))
function answers(q: sessionQuestions.SessionQuestions, now: number) {
  const triage = []
  let next = q.next(undefined, now)
  while (next) {
    triage.push(next)
    if (triage.length > ids.length) throw new Error('Triage successor did not advance')
    next = q.next(next, now)
  }
  const excluded = new Set(['z', 'y'])
  return {
    facts: ids.map(id => q.fact(id)), triage, excludedNext: q.next(undefined, now, excluded),
    recent: q.recent(), excludedRecent: q.recent(excluded),
    machine: q.latest(['machine', 'elsewhere']), excludedMachine: q.latest(['machine'], excluded),
    machines: ids.map(id => q.machineFact(id)), closes: ['one', 'two'].map(id => q.issueCloseCounts(id)),
    references: ['["repo",1,"A"]', '["repo",2,"B"]'].map(ref => q.referenceId(ref)),
    setup: [q.setupAgent(), q.setupCount(), ...ids.map(id => q.present(id))],
    activity: activityQuestions.map(question => [q.activity(question), q.activity({ ...question, excluded })]),
    paths: ['/repo', '/repo/nested', '/other'].map(root => q.hasWithin(root)),
  }
}

it.each(['own', 'resident', 'cold'] as const)('matches complete rebuilds and observed answers through source transitions (%s)', mode => {
  const schema: ModelSchema = mode === 'cold' ? { ...SCHEMA, session: { ...SCHEMA.session, cold: {
    kind: 'unlessShown', when: 'fixture holds all sessions cold', dependsOn: [], predicate: () => true,
    shownUntil: () => -Infinity, finishOf: () => null, keptBy: [], why: 'Exercise source-only questions.',
  } } } : SCHEMA
  const source = mode === 'own' ? undefined : createColdIndex(schema)
  const now = Date.parse(stamp)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, schema, source ? {
    cold: () => source, load: () => undefined, schedule: () => () => {},
  } : undefined)
  const rows = new Map<string, RowRecord>(), positions = new Map<string, number>()
  let sequence = 0, observed: unknown, stop: (() => void) | undefined
  const publicAnswers = () => ({
    ref: pool.queries.sessionReferenceId('POD-1-A'), linked: pool.queries.linkedSessionId('POD-1-A'),
    machine: pool.queries.latestMachineSession(['machine', 'elsewhere']),
    setup: [pool.queries.setupDefaultAgent(), pool.queries.setupSessionCount(), ...ids.map(id => pool.queries.setupSessionPresent(id))],
    recent: pool.queries.ids({ kind: 'headerRecentSession' }),
    closes: ['one', 'two'].map(id => pool.queries.issueCloseCounts(id)),
    activity: activityQuestions.map(question => pool.queries.activity(question)),
  })
  const apply = (event: RowSourceEvent) => {
    if (event.type === 'replace') { rows.clear(); positions.clear(); sequence = 0 }
    for (const record of event.rows) {
      if (record.value) rows.set(`${record.kind}:${record.id}`, record)
      else rows.delete(`${record.kind}:${record.id}`)
      if (record.kind !== 'session') continue
      if (!record.value) positions.delete(record.id)
      else if (!positions.has(record.id)) positions.set(record.id, ++sequence)
    }
    source?.apply(event); pool.apply(event)
    const index = source ?? pool.coldIndex()
    const rebuilt = createColdIndex(schema)
    rebuilt.apply({ type: 'replace', rows: [...rows.values()] })
    const full = sessionQuestions.createSessionQuestions(id => rebuilt.sessionCollapsed(id),
      id => rebuilt.sessionOrderKey(id), undefined, id => positions.get(id) ?? 0)
    full.replace([...rows.values()].filter(record => record.kind === 'session')
      .map(record => [record.id, record.value as Readonly<Record<string, unknown>>] as const))
    const actual = index.forkSessionQuestions(id => index.sessionCollapsed(id), id => index.sessionOrderKey(id))
    for (const time of [now, Date.parse('2026-12-01')]) expect(answers(actual, time)).toEqual(answers(full, time))
    const machine = full.latest(['machine', 'elsewhere'])
    const expected = {
      ref: full.referenceId('["repo",1,"A"]'), linked: full.referenceId('["repo",1,"A"]'),
      machine: machine && { machineId: machine.machineId, createdAt: machine.createdAt },
      setup: [full.setupAgent(), full.setupCount(), ...ids.map(id => full.present(id))],
      recent: full.recent() ? [full.recent()!.id] : [],
      closes: ['one', 'two'].map(id => full.issueCloseCounts(id)),
      activity: activityQuestions.map(question => full.activity(question)),
    }
    expect(publicAnswers()).toEqual(expected)
    expect(ids.map(id => pool.queries.nextTriageSession(id))).toEqual(ids.map(id => {
      const next = full.next(full.triageFact(id, now), now) ?? full.next(undefined, now)
      return next?.id === id ? undefined : next?.id
    }))
    if (stop) expect(observed).toEqual(expected)
    else stop = autorun(() => { observed = publicAnswers() })
    if (mode === 'cold') expect(pool.tables.session.size).toBe(0)
    return index.changes(event)
  }
  const update = (...changes: RowRecord[]) => apply({ type: 'update', rows: changes })
  try {
    apply({ type: 'replace', rows: seed() })
    const delta = update(session('a', 'other', { status: 'exited' }))
    expect(delta.flips).toEqual([]); expect(delta.orders).toEqual([['session', 'z']])
    expect(pool.queries.sessionReferenceId('POD-1-A')).toBe('b')
    update(session('a', 'primary', { status: 'exited' }))
    expect(pool.queries.sessionReferenceId('POD-1-A')).toBe('z')
    // z loses both visibility and its borrowed order key in the same delta.
    const combined = update(session('a', 'primary', { lastActiveAt: '2026-10-02' }))
    expect(combined.flips).toContainEqual(['session', 'z'])
    expect(combined.orders).toContainEqual(['session', 'z'])
    update(session('a', 'primary', { status: 'live' }))
    update(session('a', 'primary', { status: 'exited' }))
    update(session('z', 'primary', { snoozedUntil: '2026-11-01', offer: { message: 'Ready' } }))
    update(session('z', 'primary', { cwd: '/other', machineId: 'elsewhere', issueId: 'two', agentKind: 'shell' }))
    update({ kind: 'session', id: 'a', value: undefined })
    update(session('a', 'primary', { status: 'exited' }))
    update(session('late', 'primary', { lastActiveAt: '2026-10-03', agentKind: 'claude-code' }))
    apply({ type: 'replace', rows: [...rows.values()].reverse() })
    apply({ type: 'replace', rows: [] })
    apply({ type: 'replace', rows: seed() })
  } finally { stop?.(); pool.dispose() }
})

it('records bounded order-only CPU and family counts against the former broad route', () => {
  const runs = 512
  const run = (broad: boolean) => {
    let key = 'a'
    const q = sessionQuestions.createSessionQuestions(() => false, id => id === 'a' ? key : id)
    q.replace([session('a'), session('b')].map(record =>
      [record.id, record.value as Readonly<Record<string, unknown>>] as const))
    const before = { ...q.updates }, start = process.cpuUsage()
    for (let turn = 0; turn < runs; turn++) {
      key = turn % 2 ? 'a' : 'z'
      if (broad) q.visibilityChanged('a')
      else q.orderChanged('a')
    }
    const cpu = process.cpuUsage(start)
    return { q, cpuMicros: cpu.user + cpu.system, updates: difference(q.updates, before) }
  }
  const before = run(true), after = run(false)
  expect(answers(after.q, Date.parse(stamp))).toEqual(answers(before.q, Date.parse(stamp)))
  expect(before.updates).toEqual({ close: runs, setupCount: runs, setupAgent: runs, reference: runs,
    triage: runs, recent: 0, machine: runs, activity: runs })
  expect(after.updates).toEqual({ close: 0, setupCount: 0, setupAgent: 0, reference: runs,
    triage: 0, recent: 0, machine: runs, activity: 0 })
  // CPU is an observation, not a timing gate; deterministic family counts
  // carry the regression assertion even on a busy focused-test host.
  console.info('[source order CPU control]', JSON.stringify({ runs,
    broadCpuMicros: before.cpuMicros, narrowCpuMicros: after.cpuMicros,
    broadUpdates: before.updates, narrowUpdates: after.updates }))
})

it('refreshes only changed order inputs, preserves forks, and ignores absent or unchanged orders', () => {
  const rows = [session('a'), session('b', undefined, { agentKind: 'claude-code' })]
  const order = new Map([['a', 'a'], ['b', 'b']]), setupOrder = new Map([['a', 1], ['b', 2]])
  const create = () => sessionQuestions.createSessionQuestions(() => false,
    id => order.get(id) ?? id, undefined, id => setupOrder.get(id) ?? 0)
  const q = create()
  q.replace(rows.map(record => [record.id, record.value as Readonly<Record<string, unknown>>] as const))
  const fork = q.fork(() => false, id => order.get(id) ?? id), held = answers(fork, Date.parse(stamp))
  const before = { ...q.updates }, paths = q.activityPathsBuilt
  order.set('a', 'z'); setupOrder.set('a', 3)
  q.orderChanged('a')
  expect(difference(q.updates, before)).toEqual({ close: 0, setupCount: 0, setupAgent: 1,
    reference: 1, triage: 0, recent: 0, machine: 1, activity: 0 })
  expect(q.referenceId('["repo",1,"A"]')).toBe('b')
  expect(q.latest(['machine'])?.id).toBe('b')
  expect(q.setupAgent()).toBe('claude-code')
  const rebuilt = create()
  rebuilt.replace(rows.map(record => [record.id, record.value as Readonly<Record<string, unknown>>] as const))
  expect(answers(q, Date.parse(stamp))).toEqual(answers(rebuilt, Date.parse(stamp)))
  expect(answers(fork, Date.parse(stamp))).toEqual(held)
  const beforeSetup = { ...q.updates }
  setupOrder.set('a', 0); q.orderChanged('a')
  expect(difference(q.updates, beforeSetup)).toEqual({ close: 0, setupCount: 0, setupAgent: 1,
    reference: 0, triage: 0, recent: 0, machine: 0, activity: 0 })
  expect(q.setupAgent()).toBe('codex')
  const after = { ...q.updates }, fact = q.fact('a')
  q.orderChanged('a'); q.orderChanged('missing')
  expect(q.updates).toEqual(after); expect(q.fact('a')).toBe(fact)
  expect(q.activityPathsBuilt).toBe(paths)
  q.set('a', undefined); q.orderChanged('a')
  expect(q.fact('a')).toBeUndefined()
})

it('files a simultaneous visibility and order change once in each index', () => {
  const tracked: { visibility: ReturnType<typeof vi.spyOn>; order: ReturnType<typeof vi.spyOn> }[] = []
  const restores: (() => void)[] = []
  const track = (q: sessionQuestions.SessionQuestions): sessionQuestions.SessionQuestions => {
    const visibility = vi.spyOn(q, 'visibilityChanged'), order = vi.spyOn(q, 'orderChanged')
    const fork = q.fork, forkSpy = vi.spyOn(q, 'fork').mockImplementation((...args) => track(fork(...args)))
    tracked.push({ visibility, order })
    restores.push(() => { visibility.mockRestore(); order.mockRestore(); forkSpy.mockRestore() })
    return q
  }
  const create = sessionQuestions.createSessionQuestions
  const spy = vi.spyOn(sessionQuestions, 'createSessionQuestions').mockImplementation((...args) => track(create(...args)))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  try {
    pool.apply({ type: 'replace', rows: seed() })
    for (const { visibility, order } of tracked) { visibility.mockClear(); order.mockClear() }
    const event: RowSourceEvent = { type: 'update', rows: [session('a', 'primary', { lastActiveAt: '2026-10-02' })] }
    pool.apply(event)
    const delta = pool.coldIndex().changes(event)
    expect(delta.flips).toContainEqual(['session', 'z'])
    expect(delta.orders).toContainEqual(['session', 'z'])
    const calls = (kind: 'visibility' | 'order') => tracked.flatMap(spies => spies[kind].mock.calls)
      .filter(([id]) => id === 'z').length
    expect(calls('visibility')).toBe(2) // cold source and effective resident fork
    expect(calls('order')).toBe(0)
  } finally { pool.dispose(); restores.forEach(restore => restore()); spy.mockRestore() }
})
