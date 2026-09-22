/**
 * POD-4547 (L1b) — archived sessions, asserted in BOTH directions (coordinator
 * ruling 2026-09-22 on L1a's open question 1): an archived session IS a member
 * of the R2 and R3 relations the graph maintains, and is NOT one of its row's
 * seats. Each direction has a control proving its predicate can say no.
 */
import { describe, expect, it } from 'vitest'
import { isRowSeat } from './row-view'
import { SCHEMA, type RelationSpec } from './schema'
import type { SliceSession } from './slice-types'

function session(over: Partial<SliceSession>): SliceSession {
  return { sessionId: 's', issueId: 'A', cwd: '/wt/a', lastActiveAt: '2026-09-20T11:00:00Z', ...over }
}

const live = session({ sessionId: 'live' })
const archived = session({ sessionId: 'archived', archived: true })
const shell = session({ sessionId: 'shell', agentKind: 'shell' })
const headless = session({ sessionId: 'headless', headless: true })

const R2 = SCHEMA.session.relations['issue'] as RelationSpec
const R3 = SCHEMA.session.relations['worktree'] as RelationSpec

function member(relation: RelationSpec, s: SliceSession): boolean {
  return relation.where === undefined || relation.where.test(s as unknown as Record<string, unknown>)
}

describe('archived sessions are graph members (R2, R3)', () => {
  it('names the relations it checks', () => {
    expect(R2.slice).toBe('R2')
    expect(R3.slice).toBe('R3')
  })

  it.each([
    ['R2', R2],
    ['R3', R3],
  ] as const)('%s admits an archived session', (_name, relation) => {
    expect(member(relation, archived)).toBe(true)
    expect(relation.where?.fields ?? []).not.toContain('archived')
  })

  it.each([
    ['R2', R2],
    ['R3', R3],
  ] as const)('ARMED: %s membership can say no (headless is dropped)', (_name, relation) => {
    expect(member(relation, headless)).toBe(false)
  })
})

describe('archived sessions are not row seats (read side)', () => {
  it('drops archived and shell sessions, keeps a live one', () => {
    expect(isRowSeat(live)).toBe(true)
    expect(isRowSeat(archived)).toBe(false)
    expect(isRowSeat(shell)).toBe(false)
  })

  it('composes: both are R2 members of A, only the live one is a seat', () => {
    const attached = [live, archived]
    const members = attached.filter((s) => member(R2, s))
    expect(members.map((s) => s.sessionId)).toEqual(['live', 'archived'])
    expect(members.filter(isRowSeat).map((s) => s.sessionId)).toEqual(['live'])
  })
})
