/**
 * POD-5405 — the cold index against the rule over whole rows, one mechanism
 * per case. Every assertion compares with `coldByRule` through
 * `tableColdContext` (what a rebuild and the gate partition with), and each
 * case first pins the branch it exercises so a vacuous green is impossible.
 * The 1x/4x corpus and generated sequences live in the harness
 * (`packages/worklist-proto/harness/src/cold-index.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import { createColdIndex } from './cold-index'
import { coldByRule, type EntityName, SCHEMA, tableColdContext } from './schema'
import type { RowRecord } from './source'

type Row = Record<string, unknown>
type Kind = 'issue' | 'session' | 'worktree'

const T0 = Date.parse('2026-10-01T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const DAY = 24 * 60 * 60 * 1000
const LATER = T0 + 365 * DAY

function feed() {
  const tables: Record<Kind, Map<string, Row>> = { issue: new Map(), session: new Map(), worktree: new Map() }
  const index = createColdIndex(SCHEMA)
  const put = (kind: Kind, id: string, value: Row | undefined) => {
    if (value === undefined) tables[kind].delete(id)
    else tables[kind].set(id, value)
    index.apply({ type: 'update', rows: [{ kind, id, value } as RowRecord] })
  }
  const expected = (entity: 'issue' | 'session', id: string, now: number) => {
    const ctx = tableColdContext(SCHEMA, (e: EntityName) => tables[e as Kind], now)
    const row = tables[entity].get(id)
    return row !== undefined && coldByRule(SCHEMA, entity, row, ctx)
  }
  /** Every answer the index gives at `now` equals the rule over whole rows. */
  const check = (now: number) => {
    const ctx = tableColdContext(SCHEMA, (e: EntityName) => tables[e as Kind], now)
    for (const entity of ['issue', 'session'] as const) {
      const resident: string[] = []
      for (const [id, row] of tables[entity]) {
        const cold = coldByRule(SCHEMA, entity, row, ctx)
        expect(index.coldByRule(entity, id, now), `${entity}:${id} at ${iso(now)}`).toBe(cold)
        if (!cold) resident.push(id)
      }
      expect(index.residentCandidates(entity, now).sort(), `${entity} resident at ${iso(now)}`).toEqual(resident.sort())
      expect(index.count(entity)).toBe(tables[entity].size)
    }
  }
  return { tables, index, put, expected, check }
}

const closedIssue = (id: string, extra: Row = {}): Row => ({
  id,
  title: id,
  stage: 'done',
  audience: 'human',
  closedAt: iso(T0 - DAY),
  updatedAt: iso(T0 - DAY),
  parentId: 'root-parent',
  ...extra,
})
const runningSession = (sessionId: string, extra: Row = {}): Row => ({
  sessionId,
  agentKind: 'claude-code',
  status: 'live',
  cwd: '/elsewhere',
  lastActiveAt: iso(T0),
  ...extra,
})

describe('cold index (POD-5405)', () => {
  it('keeps navigation paths addressed across hidden membership, rehomes and readmission', () => {
    const f = feed()
    f.put('session', 's1', runningSession('s1', { cwd: '/unscanned/old/', headless: true }))
    expect(f.index.relations.forward('session', 's1', 'worktree')).toBeNull()
    expect(f.index.relations.prefixPath('session', 's1', 'worktree')).toBe('/unscanned/old')
    f.put('session', 's1', runningSession('s1', { cwd: '/unscanned/new', headless: true }))
    expect(f.index.relations.prefixPath('session', 's1', 'worktree')).toBe('/unscanned/new')
    f.put('session', 's1', undefined)
    expect(f.index.relations.prefixPath('session', 's1', 'worktree')).toBeNull()
    f.put('session', 's1', runningSession('s1', { cwd: '/readmitted' }))
    expect(f.index.relations.prefixPath('session', 's1', 'worktree')).toBe('/readmitted')
    f.index.apply({ type: 'replace', rows: [] })
    expect(f.index.relations.prefixPath('session', 's1', 'worktree')).toBeNull()
  })

  it('follows member keeps and their decay with the clock', () => {
    const f = feed()
    f.put('issue', 'i1', closedIssue('i1', { parentId: undefined, audience: 'agent' }))
    f.put('session', 's1', runningSession('s1', { issueId: 'i1', stoppedAt: iso(T0 - 60_000), status: 'exited' }))
    // Pinned branch: kept now by a finished session, cold once its window passes.
    expect(f.expected('issue', 'i1', T0)).toBe(false)
    expect(f.expected('issue', 'i1', LATER)).toBe(true)
    expect(f.expected('session', 's1', LATER)).toBe(true)
    f.check(T0)
    f.check(LATER)
    // A new running member warms it at the later clock; removing it cools it again.
    f.put('session', 's2', runningSession('s2', { issueId: 'i1' }))
    expect(f.expected('issue', 'i1', LATER)).toBe(false)
    f.check(LATER)
    f.put('session', 's2', undefined)
    f.check(LATER)
  })

  it('seats issueless sessions under the longest root and keeps the lane owner', () => {
    const f = feed()
    f.put('issue', 'i1', closedIssue('i1', { parentId: undefined, audience: 'agent', worktreePath: '/w/a' }))
    f.put('session', 's1', runningSession('s1', { cwd: '/w/a/sub' }))
    // Pinned branch: only the lane seat keeps it shown.
    expect(f.expected('issue', 'i1', LATER)).toBe(false)
    f.check(LATER)
    // A longer root takes the seat: the owner's lane loses its keeper.
    f.put('worktree', '/w/a/sub', { path: '/w/a/sub' })
    expect(f.expected('issue', 'i1', LATER)).toBe(true)
    f.check(LATER)
    f.put('worktree', '/w/a/sub', undefined)
    expect(f.expected('issue', 'i1', LATER)).toBe(false)
    f.check(LATER)
    // The owner's own root leaving unseats the member.
    f.put('issue', 'i1', closedIssue('i1', { parentId: undefined, audience: 'agent', worktreePath: '/w/b' }))
    f.check(LATER)
    // A headless member never sits (the prefix's where).
    f.put('issue', 'i1', closedIssue('i1', { parentId: undefined, audience: 'agent', worktreePath: '/w/a' }))
    f.put('session', 's1', runningSession('s1', { cwd: '/w/a/sub', headless: true }))
    expect(f.expected('issue', 'i1', LATER)).toBe(true)
    f.check(LATER)
  })

  it('drops collapsed resume twins from the lane', () => {
    const f = feed()
    const resume = { kind: 'claude', value: 'r1' }
    f.put('issue', 'i1', closedIssue('i1', { parentId: undefined, audience: 'agent', worktreePath: '/w/a' }))
    // Winner: newer, archived (keeps nothing). Loser: older, finished within its window.
    f.put('session', 'win', runningSession('win', { cwd: '/w/a', resume, status: 'exited', archived: true, lastActiveAt: iso(T0) }))
    f.put('session', 'lose', runningSession('lose', { cwd: '/w/a', resume, status: 'exited', stoppedAt: iso(T0 - 60_000), lastActiveAt: iso(T0 - DAY) }))
    // Pinned branch: the loser's keep would show it, but the loser is collapsed away.
    expect(f.expected('issue', 'i1', T0)).toBe(true)
    f.check(T0)
    // Flip the recency: the keeper wins and keeps the owner shown.
    f.put('session', 'win', runningSession('win', { cwd: '/w/a', resume, status: 'exited', archived: true, lastActiveAt: iso(T0 - 2 * DAY) }))
    expect(f.expected('issue', 'i1', T0)).toBe(false)
    f.check(T0)
    // Removing the other twin ends the group.
    f.put('session', 'win', undefined)
    f.check(T0)
  })

  it('reads ancestors for an internal child (canShow)', () => {
    const f = feed()
    f.put('issue', 'p', closedIssue('p', { parentId: undefined }))
    f.put('issue', 'c', closedIssue('c', { audience: 'agent', parentId: 'p' }))
    f.put('session', 'sc', runningSession('sc', { issueId: 'c' }))
    // Pinned branch: kept by its session, but its only placed ancestor is cold.
    expect(f.expected('issue', 'p', T0)).toBe(true)
    expect(f.expected('issue', 'c', T0)).toBe(true)
    f.check(T0)
    // The parent warms: the child can show again.
    f.put('session', 'sp', runningSession('sp', { issueId: 'p' }))
    expect(f.expected('issue', 'c', T0)).toBe(false)
    f.check(T0)
    // An unknown ancestor is conservative.
    f.put('issue', 'p', undefined)
    f.check(T0)
  })

  it('follows a via target, an unknown target and unbound decay', () => {
    const f = feed()
    f.put('session', 's1', runningSession('s1', { issueId: 'gone', stoppedAt: iso(T0 - 3 * DAY), status: 'exited' }))
    f.put('session', 'u1', runningSession('u1', { stoppedAt: iso(T0 - 60_000), status: 'exited' }))
    // Pinned branches: a missing target is never cold; an unbound run decays.
    expect(f.expected('session', 's1', LATER)).toBe(false)
    expect(f.expected('session', 'u1', T0)).toBe(false)
    expect(f.expected('session', 'u1', LATER)).toBe(true)
    f.check(T0)
    f.check(LATER)
    f.put('issue', 'gone', closedIssue('gone', { parentId: undefined, audience: 'agent' }))
    expect(f.expected('session', 's1', LATER)).toBe(true)
    f.check(LATER)
  })

  it('answers exactly after a clock rewind and a replace', () => {
    const f = feed()
    f.put('issue', 'i1', closedIssue('i1', { parentId: undefined, audience: 'agent' }))
    f.put('session', 's1', runningSession('s1', { issueId: 'i1', stoppedAt: iso(T0 - 60_000), status: 'exited' }))
    f.put('issue', 'o1', { id: 'o1', title: 'open', stage: 'in_progress', audience: 'human' })
    f.check(LATER)
    f.check(T0)
    const rows = [...f.tables.issue].map(([id, value]) => ({ kind: 'issue', id, value }) as unknown as RowRecord)
    f.index.apply({ type: 'replace', rows })
    f.tables.session.clear()
    f.check(T0)
  })
})
