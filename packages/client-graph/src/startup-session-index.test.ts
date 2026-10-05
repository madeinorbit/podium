import { expect, it, vi } from 'vitest'
import * as answers from './query-result'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import { createSessionQuestions, type SessionQuestions, type TriageSession } from './shared/session-questions'
import type { RowRecord } from './shared/source'

const stamp = '2026-10-03T12:00:00Z'
const now = Date.parse(stamp)
type Row = Readonly<Record<string, unknown>>
const row = (n: number): Row => ({
  sessionId: `startup-${n}`, agentKind: n % 11 === 0 ? 'shell' : 'codex', status: 'live',
  cwd: `/repo/${n % 3}/child`, machineId: `m${n % 2}`, issueId: `i${n % 3}`,
  displayRef: `POD-${n % 3}-A`,
  lastActiveAt: stamp, createdAt: stamp, archived: n % 13 === 0, headless: n % 17 === 0,
  snoozedUntil: n % 7 === 0 ? '2026-10-04T12:00:00Z' : '',
  agentState: { phase: n % 3 === 0 ? 'needs_user' : 'working' },
  offer: n % 5 === 0 ? { message: 'Ready' } : undefined,
})

it.each([128, 512])('seeds %i startup sessions without per-row persistent tree writes', count => {
  let writes = 0
  const original = answers.createKeyedAnswer
  const spy = vi.spyOn(answers, 'createKeyedAnswer').mockImplementation(((...args: Parameters<typeof original>) => {
    const answer = original(...args), set = answer.set
    answer.set = (id, order, value) => { if (id.startsWith('startup-')) writes++; set(id, order, value) }
    return answer
  }) as typeof original)
  try {
    const index = createColdIndex(SCHEMA)
    index.apply({ type: 'replace', rows: Array.from({ length: count }, (_, n) =>
      ({ kind: 'session', id: `startup-${n}`, value: row(n) }) as RowRecord) })
    expect(index.sessionQuestionFact('startup-1')?.machineId).toBe('m1')
    expect(index.latestMachineSession(['m0', 'm1'])).toBeDefined()
    console.info('startup persistent session writes', JSON.stringify({ count, writes }))
    expect(writes).toBe(0)
  } finally { spy.mockRestore() }
})

function view(q: SessionQuestions, ids: string[], time: number) {
  const triage: TriageSession[] = []
  let next = q.next(undefined, time)
  while (next) {
    triage.push(next)
    if (triage.length > ids.length) throw new Error('Successor did not advance')
    next = q.next(next, time)
  }
  const activity = { kind: 'commandRootActivity' as const, roots: ['/repo', '/repo/1'], excluded: new Set(['startup-1']) }
  return {
    facts: ids.map(id => q.fact(id)), triage,
    excludedNext: q.next(undefined, time, new Set(['startup-1', 'startup-2'])),
    recent: q.recent(), excludedRecent: q.recent(new Set(['startup-1'])),
    latest: q.latest(['m0', 'm1']), excludedLatest: q.latest(['m0', 'm1'], new Set(['startup-1'])),
    machines: ids.map(id => q.machineFact(id)),
    activity: q.activity(activity), exact: q.activity({ ...activity, match: 'exact' }),
    revisions: [q.recentRevision(), q.machineRevision(['m0', 'm1']), q.activityRevision(activity)],
    close: ['i0', 'i1', 'i2'].map(id => q.issueCloseCounts(id)),
    references: ['POD-0-A', 'POD-1-A', 'POD-2-A', 'NEW'].map(ref => q.referenceId(ref)),
  }
}

it('matches sequential seeding through replacements, duplicate ids, snooze clocks and forked updates', () => {
  const collapsed = new Set(['startup-3'])
  const order = (id: string) => id.endsWith('1') ? 'a' : 'b'
  const bulk = createSessionQuestions(id => collapsed.has(id), order)
  const incremental = createSessionQuestions(id => collapsed.has(id), order)
  const ids = Array.from({ length: 37 }, (_, n) => `startup-${n}`)
  const input: [string, Row | undefined][] = ids.map((id, n) => [id, row(n)])
  input.push(['startup-1', { ...row(1), cwd: '/repo/2', machineId: 'm0' }], ['startup-2', undefined])
  const check = () => {
    for (const time of [now - 86400000, now, now + 2 * 86400000])
      expect(view(bulk, ids, time)).toEqual(view(incremental, ids, time))
  }
  const replace = (rows: [string, Row | undefined][]) => {
    bulk.replace(rows); incremental.clear()
    for (const [id, value] of rows) incremental.set(id, value)
    check()
  }
  replace(input)
  const fork = bulk.fork(id => collapsed.has(id), order), held = view(fork, ids, now)
  const edits: [string, Row | undefined][] = [
    ['startup-1', { ...row(1), cwd: '/else', machineId: 'm1', lastActiveAt: '2028-01-01T00:00:00Z', issueId: 'i2', displayRef: 'NEW' }],
    ['startup-4', undefined], ['startup-3', { ...row(3), snoozedUntil: '2030-01-01T00:00:00Z' }],
  ]
  for (const [id, value] of edits) { bulk.set(id, value); incremental.set(id, value); check() }
  expect(view(fork, ids, now)).toEqual(held)
  collapsed.delete('startup-3')
  bulk.visibilityChanged('startup-3'); incremental.visibilityChanged('startup-3'); check()
  const revision = bulk.recentRevision()
  replace([])
  expect(bulk.recentRevision()).toBeGreaterThan(revision)
  expect(view(fork, ids, now)).toEqual(held)
  replace(input.toReversed())
})

it('matches a final relation state and subsequent collapse winner flips after bootstrap', () => {
  const bulk = createColdIndex(SCHEMA), sequential = createColdIndex(SCHEMA)
  const sessions = Array.from({ length: 37 }, (_, n) => ({ kind: 'session', id: `startup-${n}`,
    value: { ...row(n), resume: { kind: 'codex-thread', value: `group-${n % 3}` } } }) as RowRecord)
  const input: RowRecord[] = [{ kind: 'worktree', id: '/repo', value: { path: '/repo' } } as RowRecord, ...sessions]
  bulk.apply({ type: 'replace', rows: input })
  sequential.apply({ type: 'update', rows: input })
  const read = (index: typeof bulk) => {
    const q = index.forkSessionQuestions(id => index.relations.collapsed('session', id), id => index.relations.orderKey('session', id))
    return { facts: input.map(r => index.sessionQuestionFact(r.id)),
      triage: Array.from({ length: 37 }, (_, n) => index.triageSession(`startup-${n}`, now)),
      latest: index.latestMachineSession(['m0', 'm1']),
      activity: index.readerActivity({ kind: 'commandRootActivity', roots: ['/repo'] }),
      close: ['i0', 'i1', 'i2'].map(id => q.issueCloseCounts(id)),
      references: ['POD-0-A', 'POD-1-A', 'POD-2-A'].map(ref => q.referenceId(ref)),
    }
  }
  expect(read(bulk)).toEqual(read(sequential))
  const fork = bulk.forkSessionQuestions(() => false), held = fork.fact('startup-1')
  for (const change of [sessions[1]!, { ...sessions[1]!, value: undefined },
    { ...sessions[0]!, value: { ...row(0), createdAt: '2028-01-01T00:00:00Z' } } as RowRecord]) {
    bulk.apply({ type: 'update', rows: [change] }); sequential.apply({ type: 'update', rows: [change] })
    expect(read(bulk)).toEqual(read(sequential))
  }
  expect(fork.fact('startup-1')).toEqual(held)
})
