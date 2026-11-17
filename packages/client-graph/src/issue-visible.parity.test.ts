/**
 * POD-7047 (redo of POD-5899) — IssueModel.visible decides archive/deletion
 * from the declared cold fields. Parity with the old answer (the full
 * addressed row read) on cold, archived, deleted, resident, unknown and
 * LOADING fixtures; the new answer may settle sooner, never differently.
 * A deliberately wrong rule (dropping either field) must fail the parity.
 */
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import type { IssueNavigationModel } from '@podium/client-core/values'
import { isGone, omitGone } from './lookup'
import { settled } from './mission-view'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const stamp = '2026-10-01T12:00:00Z', old = '2026-09-20T12:00:00Z', now = Date.parse(stamp)
const issue = (id: string, patch: Record<string, unknown> = {}) => ({ id, seq: 1, stage: 'in_progress', title: 'Task',
  description: '', deps: [], parentId: null, repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, readAt: stamp,
  ...patch }) as unknown as IssueNavigationModel
const closed = { stage: 'done', closedAt: old, updatedAt: old }
const pools: MobxPool[] = []
afterEach(() => { for (const pool of pools.splice(0)) pool.dispose(); vi.restoreAllMocks() })

type Summaries = { issue: readonly string[]; session: readonly string[] }
const OTHER_FIELDS: Summaries = { issue: ['id', 'title', 'stage'], session: MISSION_VIEW_SUMMARIES.session }

function poolOf(rows: IssueNavigationModel[], summaries: Summaries) {
  const input = new Map<string, IssueNavigationModel>(rows.map(row => [row.id, row]))
  const load = vi.fn((entity: string, id: string) => entity === 'issue' ? input.get(id) : undefined)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, { load, summaries, schedule: () => () => {} })
  pools.push(pool)
  pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'issue' as const, id: value.id, value })) })
  return { pool, load }
}
function tracked<T>(read: () => T): T { let value!: T; const stop = autorun(() => { value = read() }); stop(); return value }
/** The answer before the fix: the full addressed row, loaded when cold. */
function oldVisible(pool: MobxPool, id: string): boolean {
  const row = omitGone(pool.row('issue', id))
  if (row === LOADING) throw LOADING
  return Boolean(row && !(row as { archived?: boolean }).archived && !(row as { deletedAt?: string }).deletedAt)
}
/** Observe until the answer settles, hydrating each requested batch. */
function settle(pool: MobxPool, read: () => boolean): boolean | typeof LOADING {
  let value: boolean | typeof LOADING = LOADING
  const stop = autorun(() => { value = settled(read) })
  try { for (let round = 0; value === LOADING && round < 4; round++) pool.hydrate() }
  finally { stop() }
  return value
}

const FIXTURES: readonly { name: string; rows: IssueNavigationModel[]; id: string; summaries: Summaries
  first: boolean | typeof LOADING; resident?: boolean }[] = [
  { name: 'resident open', rows: [issue('a')], id: 'a', summaries: MISSION_VIEW_SUMMARIES, first: true, resident: true },
  { name: 'resident deleted', rows: [issue('a', { deletedAt: stamp })], id: 'a', summaries: MISSION_VIEW_SUMMARIES, first: false },
  { name: 'cold closed', rows: [issue('a', closed)], id: 'a', summaries: MISSION_VIEW_SUMMARIES, first: true },
  { name: 'cold archived', rows: [issue('a', { ...closed, archived: true })], id: 'a', summaries: MISSION_VIEW_SUMMARIES,
    first: false, resident: false },
  { name: 'cold deleted', rows: [issue('a', { ...closed, deletedAt: old })], id: 'a', summaries: MISSION_VIEW_SUMMARIES,
    first: false, resident: false },
  // The cold rule's canShow fields (archived, deletedAt) join every pool's
  // declared issue summary, so a screen naming other fields still decides.
  { name: 'cold archived, screen declares other fields', rows: [issue('a', { ...closed, archived: true })], id: 'a',
    summaries: OTHER_FIELDS, first: false, resident: false },
  { name: 'cold closed, screen declares other fields', rows: [issue('a', closed)], id: 'a', summaries: OTHER_FIELDS,
    first: true },
  { name: 'unknown id', rows: [issue('a')], id: 'missing', summaries: MISSION_VIEW_SUMMARIES, first: LOADING },
]

it.each(FIXTURES)('visible matches the full-row answer: $name', ({ rows, id, summaries, first, resident }) => {
  const before = poolOf(rows, summaries)
  const expected = settle(before.pool, () => oldVisible(before.pool, id))
  expect(expected).not.toBe(LOADING)

  const after = poolOf(rows, summaries)
  if (resident !== undefined) expect(after.pool.tables.issue.has(id)).toBe(resident)
  expect(tracked(() => settled(() => after.pool.issueObject(id).visible))).toBe(first)
  expect(settle(after.pool, () => after.pool.issueObject(id).visible)).toBe(expected)
  // Decided without a load exactly when the first answer was not LOADING.
  expect(after.load.mock.calls.length).toBe(first === LOADING ? 1 : 0)
})

it('a missing cold summary (LOADING) answers LOADING, loads once and settles as the full row', () => {
  const { pool, load } = poolOf([issue('a', { ...closed, archived: true })], MISSION_VIEW_SUMMARIES)
  vi.spyOn(pool.residency!, 'summary').mockReturnValue(undefined)
  expect(tracked(() => settled(() => pool.issueObject('a').visible))).toBe(LOADING)
  expect(pool.hydrate()).toBe(1)
  expect(load).toHaveBeenCalledTimes(1)
  expect(tracked(() => pool.issueObject('a').visible)).toBe(false)
})

it('follows an archive and a restore of a cold summary without loading the row', () => {
  const { pool, load } = poolOf([issue('a', closed)], MISSION_VIEW_SUMMARIES)
  const seen: (boolean | typeof LOADING)[] = []
  const stop = autorun(() => { seen.push(settled(() => pool.issueObject('a').visible)) })
  try {
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'a', value: issue('a', { ...closed, archived: true }) }] })
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'a', value: issue('a', closed) }] })
    expect(seen).toEqual([true, false, true])
    expect(load).not.toHaveBeenCalled()
  } finally { stop() }
})

// Wrong-answer control: a rule that reads the same declared summary but drops
// one field disagrees with the full-row answer on some fixture, so the parity
// above has the power to catch a broken rule.
it.each([
  ['ignores deletedAt', (facts: Record<string, unknown>) => !facts.archived],
  ['ignores archived', (facts: Record<string, unknown>) => !facts.deletedAt],
  ['reports every member visible', () => true],
])('a deliberately wrong summary rule fails the parity: %s', (_, wrong) => {
  const mismatches = FIXTURES.filter(({ first }) => first !== LOADING).filter(({ rows, id, summaries }) => {
    const before = poolOf(rows, summaries)
    const expected = settle(before.pool, () => oldVisible(before.pool, id))
    const after = poolOf(rows, summaries)
    const facts = tracked(() => after.pool.row('issue', id, 'summary-fields'))
    if (facts === LOADING || isGone(facts)) throw new Error(`Undecided summary for ${id}`)
    return wrong(facts as Record<string, unknown>) !== expected
  })
  expect(mismatches.length).toBeGreaterThan(0)
})
