import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  attentionGroup,
  attentionSummary,
  groupSessions,
  kanbanColumns,
  relativeTime,
} from '../src/home'

const base = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: 's1',
  agentKind: 'claude-code',
  title: 't',
  cwd: '/w',
  status: 'live',
  controllerId: null,
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 0,
  createdAt: '2026-06-12T08:00:00.000Z',
  lastActiveAt: '2026-06-12T08:00:00.000Z',
  origin: { kind: 'spawn' },
  archived: false,
  ...over,
})

const state = (
  phase: NonNullable<SessionMeta['agentState']>['phase'],
  extra: Record<string, unknown> = {},
) =>
  ({ phase, since: '2026-06-12T08:00:00.000Z', openTaskCount: 0, ...extra }) as NonNullable<
    SessionMeta['agentState']
  >

describe('attentionGroup', () => {
  it('needs_user and errored demand the human', () => {
    expect(attentionGroup(base({ agentState: state('needs_user') }))).toBe('needsYou')
    expect(attentionGroup(base({ agentState: state('errored') }))).toBe('needsYou')
  })
  it('idle splits on the verdict: done is calm, question/approval/todos want you', () => {
    expect(attentionGroup(base({ agentState: state('idle', { idle: { kind: 'done' } }) }))).toBe(
      'idle',
    )
    expect(attentionGroup(base({ agentState: state('idle') }))).toBe('idle')
    for (const kind of ['question', 'approval', 'open_todos'] as const) {
      expect(attentionGroup(base({ agentState: state('idle', { idle: { kind } }) }))).toBe(
        'needsYou',
      )
    }
  })
  it('working/compacting run without us', () => {
    expect(attentionGroup(base({ agentState: state('working') }))).toBe('working')
    expect(attentionGroup(base({ agentState: state('compacting') }))).toBe('working')
  })
  it('uninstrumented sessions fall back to process status', () => {
    expect(attentionGroup(base({ agentKind: 'shell' }))).toBe('working')
    expect(attentionGroup(base({ status: 'exited', exitCode: 0 }))).toBe('idle')
    expect(attentionGroup(base({ status: 'hibernated' }))).toBe('idle')
  })
})

describe('attentionSummary', () => {
  it('prefers the captured question text over a generic label', () => {
    expect(
      attentionSummary(
        base({
          agentState: state('idle', {
            idle: { kind: 'question', summary: 'Use SQLite or Postgres?' },
          }),
        }),
      ),
    ).toBe('Use SQLite or Postgres?')
    expect(
      attentionSummary(base({ agentState: state('needs_user', { need: { kind: 'permission' } }) })),
    ).toBe('Waiting for permission to continue.')
  })
  it('describes errors with the class and retryability', () => {
    expect(
      attentionSummary(
        base({ agentState: state('errored', { error: { class: 'rate_limit', retryable: true } }) }),
      ),
    ).toContain('retryable')
  })
  it('returns null for calm states', () => {
    expect(attentionSummary(base())).toBeNull()
    expect(attentionSummary(base({ agentState: state('working') }))).toBeNull()
  })
})

describe('groupSessions', () => {
  it('drops archived sessions and recency-orders each group', () => {
    const groups = groupSessions([
      base({ sessionId: 'old-idle', status: 'exited', lastActiveAt: '2026-06-10T00:00:00.000Z' }),
      base({ sessionId: 'new-idle', status: 'exited', lastActiveAt: '2026-06-12T00:00:00.000Z' }),
      base({ sessionId: 'gone', archived: true }),
      base({ sessionId: 'asks', agentState: state('needs_user') }),
    ])
    expect(groups.needsYou.map((s) => s.sessionId)).toEqual(['asks'])
    expect(groups.idle.map((s) => s.sessionId)).toEqual(['new-idle', 'old-idle'])
    expect(groups.working.map((s) => s.sessionId)).toEqual([])
  })
})

describe('kanbanColumns', () => {
  it('lanes by workState with an unsorted inbox first', () => {
    const lanes = kanbanColumns([
      base({ sessionId: 'a' }),
      base({ sessionId: 'b', workState: 'implementing' }),
      base({ sessionId: 'c', workState: 'icebox' }),
      base({ sessionId: 'z', archived: true, workState: 'done' }),
    ])
    expect(lanes[0]).toMatchObject({ key: 'unsorted' })
    expect(lanes[0].sessions.map((s) => s.sessionId)).toEqual(['a'])
    expect(lanes.find((l) => l.key === 'implementing')?.sessions.map((s) => s.sessionId)).toEqual([
      'b',
    ])
    expect(lanes.find((l) => l.key === 'done')?.sessions).toEqual([])
    expect(lanes.find((l) => l.key === 'icebox')?.sessions.map((s) => s.sessionId)).toEqual(['c'])
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-06-12T12:00:00.000Z')
  it('rounds coarsely upward through the units', () => {
    expect(relativeTime('2026-06-12T11:59:40.000Z', now)).toBe('just now')
    expect(relativeTime('2026-06-12T11:55:00.000Z', now)).toBe('5m ago')
    expect(relativeTime('2026-06-12T09:00:00.000Z', now)).toBe('3h ago')
    expect(relativeTime('2026-06-10T12:00:00.000Z', now)).toBe('2d ago')
    expect(relativeTime('garbage', now)).toBe('')
  })
})
