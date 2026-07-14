import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { deriveTrayItems, trayScopeIssues, workingSessionCount } from './derive-tray'

const session = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    sessionId: 's1',
    agentKind: 'claude-code',
    status: 'live',
    createdAt: 't',
    lastActiveAt: 't',
    cwd: '/r/wt',
    agentState: { phase: 'working', since: 't', openTaskCount: 0 },
    ...over,
  }) as SessionMeta

describe('trayScopeIssues', () => {
  const parent = makeIssue({ id: 'p', seq: 1 })
  const child = makeIssue({ id: 'c', seq: 2, parentId: 'p' })
  const grandchild = makeIssue({ id: 'g', seq: 3, parentId: 'c' })
  const stranger = makeIssue({ id: 'x', seq: 9 })

  it('scopes to the selected issue and its descendants', () => {
    const scope = trayScopeIssues([parent, child, grandchild, stranger], 'p')
    expect(scope.map((i) => i.id).sort()).toEqual(['c', 'g', 'p'])
  })

  it('widens to all live issues when nothing (or an unknown id) is selected', () => {
    expect(trayScopeIssues([parent, stranger], null).map((i) => i.id)).toEqual(['p', 'x'])
    expect(trayScopeIssues([parent, stranger], 'gone').map((i) => i.id)).toEqual(['p', 'x'])
  })

  it('never includes archived or soft-deleted issues', () => {
    const dead = makeIssue({ id: 'c', parentId: 'p', archived: true })
    const tombstoned = makeIssue({ id: 'g', parentId: 'p', deletedAt: 't' })
    expect(trayScopeIssues([parent, dead, tombstoned], 'p').map((i) => i.id)).toEqual(['p'])
  })
})

describe('deriveTrayItems', () => {
  it('shows ONLY human-actionable items: questions and human-audience reviews', () => {
    const asking = makeIssue({
      id: 'q',
      parentId: 'p',
      needsHuman: true,
      humanQuestion: 'Ship with flag on?',
      updatedAt: '2026-07-14T10:00:00Z',
    })
    const review = makeIssue({
      id: 'r',
      parentId: 'p',
      stage: 'review',
      suggestedReason: 'Tests green, ready to merge.',
      updatedAt: '2026-07-14T11:00:00Z',
    })
    const working = makeIssue({ id: 'w', parentId: 'p', stage: 'in_progress' })
    const internalReview = makeIssue({
      id: 'i',
      parentId: 'p',
      stage: 'review',
      audience: 'agent',
    })
    const items = deriveTrayItems(
      [makeIssue({ id: 'p' }), asking, review, working, internalReview],
      'p',
    )
    expect(items.map((i) => `${i.kind}:${i.issue.id}`)).toEqual(['review:r', 'question:q'])
  })

  it('sorts newest first and falls back to placeholder texts', () => {
    const older = makeIssue({ id: 'a', needsHuman: true, updatedAt: '2026-07-14T09:00:00Z' })
    const newer = makeIssue({
      id: 'b',
      stage: 'review',
      prUrl: 'https://pr/1',
      updatedAt: '2026-07-14T12:00:00Z',
    })
    const items = deriveTrayItems([older, newer], null)
    expect(items.map((i) => i.issue.id)).toEqual(['b', 'a'])
    expect(items[1]).toMatchObject({ kind: 'question', text: 'Needs your input.' })
    expect(items[0]).toMatchObject({ kind: 'review', body: 'Ready for review — https://pr/1' })
  })

  it('an issue in review that also asks a question yields both cards', () => {
    const both = makeIssue({
      id: 'b',
      stage: 'review',
      needsHuman: true,
      humanQuestion: 'Merge strategy?',
    })
    expect(
      deriveTrayItems([both], null)
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['question', 'review'])
  })
})

describe('workingSessionCount', () => {
  it('counts working agent sessions in scope, excluding shells/headless/archived', () => {
    const issue = makeIssue({
      id: 'p',
      sessions: [
        session({ sessionId: 'w1' }),
        session({
          sessionId: 'w2',
          agentState: { phase: 'needs_user', since: 't', openTaskCount: 0 },
        }),
        session({ sessionId: 'w3', agentKind: 'shell', busy: true }),
        session({ sessionId: 'w4', headless: true }),
        session({ sessionId: 'w5', archived: true }),
      ] as SessionMeta[],
    })
    const child = makeIssue({
      id: 'c',
      parentId: 'p',
      sessions: [session({ sessionId: 'w6' })] as SessionMeta[],
    })
    const outside = makeIssue({
      id: 'x',
      sessions: [session({ sessionId: 'w7' })] as SessionMeta[],
    })
    expect(workingSessionCount([issue, child, outside], 'p')).toBe(2)
    expect(workingSessionCount([issue, child, outside], null)).toBe(3)
  })
})
