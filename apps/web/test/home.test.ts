import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  attentionGroup,
  attentionSummary,
  compareRecency,
  groupSessions,
  kanbanColumns,
  relativeTime,
} from '../src/lib/home'

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
  ({ phase, since: '2026-06-12T08:00:00.000Z', nativeSubagentCount: 0, ...extra }) as NonNullable<
    SessionMeta['agentState']
  >

describe('compareRecency with drafts', () => {
  const ids = (list: SessionMeta[]) => list.sort(compareRecency).map((s) => s.sessionId)

  it('a recent draft edit lifts a session above one with a newer lastActiveAt but no draft', () => {
    const draft = base({
      sessionId: 'draft',
      lastActiveAt: '2026-06-10T00:00:00.000Z',
      draftUpdatedAt: '2026-06-12T09:00:00.000Z',
    })
    const plain = base({ sessionId: 'plain', lastActiveAt: '2026-06-12T08:00:00.000Z' })
    // draft was edited 09:00 > plain's last activity 08:00 → draft sorts first
    expect(ids([plain, draft])).toEqual(['draft', 'plain'])
  })

  it('lastActiveAt still wins when it is newer than the draft edit', () => {
    const active = base({
      sessionId: 'active',
      lastActiveAt: '2026-06-12T10:00:00.000Z',
      draftUpdatedAt: '2026-06-12T07:00:00.000Z',
    })
    const draft = base({
      sessionId: 'draft',
      lastActiveAt: '2026-06-10T00:00:00.000Z',
      draftUpdatedAt: '2026-06-12T09:00:00.000Z',
    })
    // active's 10:00 activity beats draft's 09:00 effective recency
    expect(ids([draft, active])).toEqual(['active', 'draft'])
  })
})

describe('compareRecency with a returned (expired) snooze', () => {
  const now = Date.parse('2026-06-12T12:00:00.000Z')
  const sorted = (list: SessionMeta[]) =>
    [...list].sort((a, b) => compareRecency(a, b, now)).map((s) => s.sessionId)

  it('a just-expired snooze lifts the session by its snooze-expiry (it just re-entered the queue)', () => {
    const returned = base({
      sessionId: 'returned',
      lastActiveAt: '2026-06-10T00:00:00.000Z',
      snoozedUntil: '2026-06-12T11:59:00.000Z', // expired one minute ago
    })
    const older = base({ sessionId: 'older', lastActiveAt: '2026-06-11T00:00:00.000Z' })
    expect(sorted([older, returned])).toEqual(['returned', 'older'])
  })

  it('a still-active (future) snooze must NOT inflate recency', () => {
    const snoozed = base({
      sessionId: 'snz',
      lastActiveAt: '2026-06-10T00:00:00.000Z',
      snoozedUntil: '2999-01-01T00:00:00.000Z',
    })
    const older = base({ sessionId: 'older', lastActiveAt: '2026-06-11T00:00:00.000Z' })
    expect(sorted([snoozed, older])).toEqual(['older', 'snz'])
  })
})

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
  it('a shell is working only while producing output (busy), idle at its prompt', () => {
    expect(attentionGroup(base({ agentKind: 'shell' }))).toBe('idle')
    expect(attentionGroup(base({ agentKind: 'shell', busy: true }))).toBe('working')
  })
  it('other uninstrumented sessions fall back to process status', () => {
    // A live, uninstrumented non-shell (e.g. Codex pre-instrumentation) reads as working.
    expect(attentionGroup(base({ agentKind: 'codex' }))).toBe('working')
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
  it('lanes by workState with an unsorted inbox first; archived file into Done', () => {
    const lanes = kanbanColumns([
      base({ sessionId: 'a' }),
      base({ sessionId: 'b', workState: 'implementing' }),
      base({ sessionId: 'c', workState: 'icebox' }),
      // Archived sessions land in Done (Archive = "filed away as done") rather
      // than disappearing from the board.
      base({ sessionId: 'z', archived: true, workState: 'done' }),
    ])
    expect(lanes[0]).toMatchObject({ key: 'unsorted' })
    expect(lanes[0].sessions.map((s) => s.sessionId)).toEqual(['a'])
    expect(lanes.find((l) => l.key === 'implementing')?.sessions.map((s) => s.sessionId)).toEqual([
      'b',
    ])
    expect(lanes.find((l) => l.key === 'done')?.sessions.map((s) => s.sessionId)).toEqual(['z'])
    expect(lanes.find((l) => l.key === 'icebox')?.sessions.map((s) => s.sessionId)).toEqual(['c'])
  })

  it('routes an archived session into Done even with no explicit workState', () => {
    const lanes = kanbanColumns([base({ sessionId: 'z', archived: true })])
    expect(lanes.find((l) => l.key === 'done')?.sessions.map((s) => s.sessionId)).toEqual(['z'])
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
