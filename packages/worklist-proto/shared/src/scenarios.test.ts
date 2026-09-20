// @vitest-environment happy-dom
/**
 * POD-4444 — scenario tests: all thirteen methodology scenarios replay at the
 * functional scale with exact event counts and the oracle (snapshot) delta,
 * plus the heartbeat cost at 1×/2×/4× live-shaped corpora.
 *
 * The growth measurement records COUNTS only (rows visited, rebuilds) — no
 * walls under box load, per methodology §5.7 and the epic's timing rules. The
 * console.info COST TABLE line is the recorded evidence the coordinator mail
 * carries.
 */
import { describe, expect, it } from 'vitest'
import {
  archiveIssue,
  burst50,
  clockTick,
  coldBootstrap,
  evictWithoutRevision,
  GROWTH_CORPORA,
  measureHeartbeat,
  newIssue,
  optimisticEchoAndRejection,
  parentReassignment,
  principalSwitch,
  rescopeGrowth,
  SCENARIOS,
  selectionClick,
  SMALL_CORPUS,
  stageMoveAcrossGroups,
  unrelatedHeartbeat,
  visibleSessionPhaseChange,
  visibleTitleRename,
  type ScenarioResult,
} from './scenarios'

function summarize(result: ScenarioResult): string {
  return `${result.scenario}: ${result.events.length} events, rows [${
    result.events.map((e) => `${e.type}:${e.rows.length}`).join(', ')
  }]`
}

describe('scenario registry', () => {
  it('covers all thirteen methodology scenarios', () => {
    expect(SCENARIOS.map((s) => s.methodology)).toEqual([
      '#1',
      '#2',
      '#3',
      '#4',
      '#5',
      '#6a',
      '#6b',
      '#6c',
      '#7',
      '#8',
      '#9',
      '#10',
      '#11',
      '#12',
      '#13',
    ])
  })
})

describe('scenarios at functional scale', () => {
  it('#1 unrelatedHeartbeat: one update, one row; session delta only', async () => {
    const result = await unrelatedHeartbeat(SMALL_CORPUS)
    expect(summarize(result)).toBe('#1 unrelatedHeartbeat: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]?.kind).toBe('session')
    const before = result.before.sessions.find(
      (s) => s.sessionId === result.events[0]?.rows[0]?.id,
    )
    const after = result.after.sessions.find(
      (s) => s.sessionId === result.events[0]?.rows[0]?.id,
    )
    expect(after?.lastActiveAt).not.toBe(before?.lastActiveAt)
    expect(result.after.issues).toEqual(result.before.issues)
  }, 30_000)

  it('#2 visibleSessionPhaseChange: one update, one session row', async () => {
    const result = await visibleSessionPhaseChange(SMALL_CORPUS)
    expect(summarize(result)).toBe('#2 visibleSessionPhaseChange: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]?.kind).toBe('session')
    const id = result.events[0]?.rows[0]?.id
    expect(result.after.sessions.find((s) => s.sessionId === id)?.phase).toBe('idle')
    expect(result.before.sessions.find((s) => s.sessionId === id)?.phase).toBe('working')
  }, 30_000)

  it('#3 selectionClick: locals only, zero row events', async () => {
    const result = await selectionClick(SMALL_CORPUS)
    expect(result.events).toHaveLength(0)
    expect(result.before.selectedIssueId).not.toBe(result.after.selectedIssueId)
    expect(result.after.selectedIssueId).toBe('i1')
  }, 30_000)

  it('#4 visibleTitleRename: one update, one issue row; title delta', async () => {
    const result = await visibleTitleRename(SMALL_CORPUS)
    expect(summarize(result)).toBe('#4 visibleTitleRename: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]).toMatchObject({ kind: 'issue', id: 'i0' })
    expect(result.after.issues.find((i) => i.id === 'i0')?.title).toBe('Renamed visible row')
    expect(result.before.issues.find((i) => i.id === 'i0')?.title).toBe('Issue 0')
  }, 30_000)

  it('#5 stageMoveAcrossGroups: one update, one row; stage delta', async () => {
    const result = await stageMoveAcrossGroups(SMALL_CORPUS)
    expect(summarize(result)).toBe('#5 stageMoveAcrossGroups: 1 events, rows [update:1]')
    expect(result.after.issues.find((i) => i.id === 'i3')?.stage).toBe('done')
  }, 30_000)

  it('#6a newIssue: one update, issue + session rows', async () => {
    const result = await newIssue(SMALL_CORPUS)
    expect(summarize(result)).toBe('#6a newIssue: 1 events, rows [update:2]')
    expect(result.after.issues.some((i) => i.id === 'i-new')).toBe(true)
    expect(result.before.issues.some((i) => i.id === 'i-new')).toBe(false)
  }, 30_000)

  it('#6b archiveIssue: one update, one row', async () => {
    const result = await archiveIssue(SMALL_CORPUS)
    expect(summarize(result)).toBe('#6b archiveIssue: 1 events, rows [update:1]')
    expect(result.after.issues.find((i) => i.id === 'i4')?.archived).toBe(true)
  }, 30_000)

  it('#6c evictWithoutRevision: one update, row gone with value undefined', async () => {
    const result = await evictWithoutRevision(SMALL_CORPUS)
    expect(summarize(result)).toBe('#6c evictWithoutRevision: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]).toEqual({ kind: 'issue', id: 'i5', value: undefined })
    expect(result.after.issues.some((i) => i.id === 'i5')).toBe(false)
    expect(result.before.issues.some((i) => i.id === 'i5')).toBe(true)
  }, 30_000)

  it('#7 parentReassignment: one update, one row', async () => {
    const result = await parentReassignment(SMALL_CORPUS)
    expect(summarize(result)).toBe('#7 parentReassignment: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]).toMatchObject({ kind: 'issue', id: 'i9' })
  }, 30_000)

  it('#8 clockTick: zero row events; the delta is the coarse local', async () => {
    const result = await clockTick(SMALL_CORPUS)
    expect(result.events).toHaveLength(0)
    expect(result.after.coarseNow - result.before.coarseNow).toBe(60_000)
    expect(result.after.issues).toEqual(result.before.issues)
    expect(result.after.sessions).toEqual(result.before.sessions)
  }, 30_000)

  it('#9 optimisticEchoAndRejection: press, echo, press, rollback with identity chain', async () => {
    const result = await optimisticEchoAndRejection(SMALL_CORPUS)
    expect(result.events).toHaveLength(4)
    const [press, echo, press2, rollback] = result.events
    for (const [index, event] of result.events.entries()) {
      expect(event.type, `event ${index}`).toBe('update')
      expect(event.rows, `event ${index}`).toHaveLength(1)
      expect(event.rows[0]?.id, `event ${index}`).toBe('i6')
    }
    const beforeValue = result.before.issues.find((i) => i.id === 'i6')
    expect(press?.rows[0]?.value).not.toBe(beforeValue)
    expect(echo?.rows[0]?.value).not.toBe(press?.rows[0]?.value)
    expect((echo?.rows[0]?.value as { readAt: unknown }).readAt).toBe(
      '2026-07-09T00:00:00.000Z',
    )
    expect(press2?.rows[0]?.value).not.toBe(echo?.rows[0]?.value)
    // The rejection restores the echo object itself (covered truth).
    expect(rollback?.rows[0]?.value).toBe(echo?.rows[0]?.value)
    expect(result.after.issues.find((i) => i.id === 'i6')?.readAt).toBe(
      '2026-07-09T00:00:00.000Z',
    )
  }, 60_000)

  it('#10 burst50: exactly one update with 50 rows', async () => {
    const result = await burst50(SMALL_CORPUS)
    expect(summarize(result)).toBe('#10 burst50: 1 events, rows [update:50]')
    expect(result.after.sessions.length - result.before.sessions.length).toBe(50)
  }, 30_000)

  it('#11 principalSwitch: one full replace on the fresh replica', async () => {
    const result = await principalSwitch(SMALL_CORPUS)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe('replace')
    const sessionRows = result.events[0]?.rows.filter((r) => r.kind === 'session')
    const issueRows = result.events[0]?.rows.filter((r) => r.kind === 'issue')
    expect(sessionRows).toHaveLength(SMALL_CORPUS.sessions)
    expect(issueRows).toHaveLength(SMALL_CORPUS.issues)
  }, 60_000)

  it('#12 coldBootstrap: empty before, one full replace', async () => {
    const result = await coldBootstrap(SMALL_CORPUS)
    expect(result.before).toEqual({ issues: [], sessions: [], selectedIssueId: null, coarseNow: 0 })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe('replace')
    expect(result.after.issues).toHaveLength(SMALL_CORPUS.issues)
    expect(result.after.sessions).toHaveLength(SMALL_CORPUS.sessions)
  }, 60_000)

  it('#13 rescopeGrowth: two replaces; the corpus returns to before', async () => {
    const result = await rescopeGrowth(SMALL_CORPUS)
    expect(result.events).toHaveLength(2)
    expect(result.events[0]?.type).toBe('replace')
    expect(result.events[1]?.type).toBe('replace')
    expect(result.events[0]?.rows.length).toBeGreaterThan(result.events[1]?.rows.length ?? 0)
    expect(result.after.issues.map((i) => i.id).sort()).toEqual(
      result.before.issues.map((i) => i.id).sort(),
    )
  }, 60_000)
})

describe('heartbeat cost at live scales (counts only)', () => {
  it('visits 1 row at 1x, 2x and 4x corpus', async () => {
    const table: Record<string, { rowsVisited: number; rebuilds: number; rows: number }> = {}
    for (const [scale, spec] of Object.entries(GROWTH_CORPORA)) {
      table[scale] = await measureHeartbeat(spec)
    }
    for (const [scale, cost] of Object.entries(table)) {
      expect(cost.rows, `${scale}: one addressed row`).toBe(1)
      expect(cost.rowsVisited, `${scale}: O(addresses) visits`).toBe(1)
    }
    console.info(`COST TABLE heartbeat ${JSON.stringify(table)}`)
  }, 300_000)
})
