import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { deriveTrayItems, offerKey, trayScopeIssues, workingSessionCount } from './derive-tray'

const session = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    sessionId: 's1',
    agentKind: 'claude-code',
    status: 'live',
    createdAt: 't',
    lastActiveAt: 't',
    cwd: '/r/wt',
    agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 },
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
  it('shows ONLY human-actionable items: questions, plus the review backstop', () => {
    const asking = makeIssue({
      id: 'q',
      parentId: 'p',
      needsHuman: true,
      humanQuestion: 'Ship with flag on?',
      updatedAt: '2026-07-14T10:00:00Z',
    })
    // Review-ready work normally announces itself via a session offer, but the
    // stage alone gets a deterministic backstop card [POD-118] — a hook-forced
    // agent turn must not be able to make review work invisible.
    const review = makeIssue({
      id: 'r',
      parentId: 'p',
      stage: 'review',
      suggestedReason: 'Tests green, ready to merge.',
      updatedAt: '2026-07-14T11:00:00Z',
    })
    const working = makeIssue({ id: 'w', parentId: 'p', stage: 'in_progress' })
    const items = deriveTrayItems([makeIssue({ id: 'p' }), asking, review, working], 'p')
    expect(items.map((i) => `${i.kind}:${i.issue.id}`)).toEqual(['review:r', 'question:q'])
  })

  it('review backstop [POD-118]: yields to a live offer, a dismissed offer, or a question', () => {
    const offer = { message: 'Ready.', actions: [], createdAt: '2026-07-14T12:00:00Z' }
    // No offer at all → the backstop card carries the review stage.
    const bare = makeIssue({ id: 'bare', stage: 'review', updatedAt: '2026-07-14T11:00:00Z' })
    expect(deriveTrayItems([bare], null).map((i) => i.kind)).toEqual(['review'])
    // A live offer is the richer announcement — no duplicate backstop.
    const offered = makeIssue({
      id: 'o',
      stage: 'review',
      sessions: [session({ sessionId: 'agent', offer })] as SessionMeta[],
    })
    expect(deriveTrayItems([offered], null).map((i) => i.kind)).toEqual(['offer'])
    // An optimistically-dismissed offer means the user just acted — the
    // backstop must not pop in for that beat.
    const dismissed = new Set([offerKey('agent', offer.createdAt)])
    expect(deriveTrayItems([offered], null, dismissed)).toHaveLength(0)
    // A needsHuman question already gives the issue a card — don't double up.
    const asking = makeIssue({
      id: 'a',
      stage: 'review',
      needsHuman: true,
      humanQuestion: 'Merge?',
    })
    expect(deriveTrayItems([asking], null).map((i) => i.kind)).toEqual(['question'])
  })

  it('sorts newest first and falls back to the question placeholder', () => {
    const older = makeIssue({ id: 'a', needsHuman: true, updatedAt: '2026-07-14T09:00:00Z' })
    const newer = makeIssue({
      id: 'b',
      needsHuman: true,
      humanQuestion: 'Which flag?',
      updatedAt: '2026-07-14T12:00:00Z',
    })
    const items = deriveTrayItems([older, newer], null)
    expect(items.map((i) => i.issue.id)).toEqual(['b', 'a'])
    expect(items[1]).toMatchObject({ kind: 'question', text: 'Needs your input.' })
    expect(items[0]).toMatchObject({ kind: 'question', text: 'Which flag?' })
  })

  it('surfaces a session offer as a card, excluding shells/headless/archived', () => {
    const offer = {
      message: 'PR is up.',
      actions: [{ label: 'Merge it', prompt: 'merge the PR' }],
      createdAt: '2026-07-14T12:00:00Z',
    }
    const issue = makeIssue({
      id: 'o',
      updatedAt: '2026-07-14T10:00:00Z',
      sessions: [
        session({ sessionId: 'agent', offer }),
        session({ sessionId: 'sh', agentKind: 'shell', offer }),
        session({ sessionId: 'hl', headless: true, offer }),
        session({ sessionId: 'dead', archived: true, offer }),
        session({ sessionId: 'quiet' }),
      ] as SessionMeta[],
    })
    const items = deriveTrayItems([issue], null)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'offer',
      offer,
      session: { sessionId: 'agent' },
      since: offer.createdAt,
    })
  })

  it('hides an offer optimistically via the dismissed set, keyed per offer instance', () => {
    const offer = { message: 'm', actions: [], createdAt: '2026-07-14T12:00:00Z' }
    const issue = makeIssue({
      id: 'o',
      sessions: [session({ sessionId: 'agent', offer })] as SessionMeta[],
    })
    const dismissed = new Set([offerKey('agent', offer.createdAt)])
    expect(deriveTrayItems([issue], null, dismissed)).toHaveLength(0)
    // A NEW offer on the same session is a new key — it shows again.
    const fresh = { ...offer, createdAt: '2026-07-14T13:00:00Z' }
    const again = makeIssue({
      id: 'o',
      sessions: [session({ sessionId: 'agent', offer: fresh })] as SessionMeta[],
    })
    expect(deriveTrayItems([again], null, dismissed)).toHaveLength(1)
  })

  it('finished human issues get a deterministic card for 24h after finishing', () => {
    const NOW = Date.parse('2026-07-14T12:00:00Z')
    const fresh = makeIssue({
      id: 'f',
      stage: 'done',
      closedAt: '2026-07-14T11:00:00Z',
      closedReason: 'merged',
    })
    const internal = makeIssue({
      id: 'i',
      stage: 'done',
      audience: 'agent',
      closedAt: '2026-07-14T11:00:00Z',
    })
    // Past the 24h window — even NEVER-READ old done issues stay out (the tray
    // is "act now"; the sidebar's 7d unread visibility does not apply here).
    const decayed = makeIssue({
      id: 'd',
      stage: 'done',
      closedAt: '2026-07-10T11:00:00Z',
      unread: true,
    })
    const items = deriveTrayItems([fresh, internal, decayed], null, undefined, NOW)
    expect(items.map((i) => `${i.kind}:${i.issue.id}`)).toEqual(['finished:f'])
    expect(items[0]).toMatchObject({ since: '2026-07-14T11:00:00Z' })
  })

  it('an issue with both a question and a session offer yields both cards', () => {
    const both = makeIssue({
      id: 'b',
      stage: 'review',
      needsHuman: true,
      humanQuestion: 'Merge strategy?',
      sessions: [
        session({
          sessionId: 'agent',
          offer: { message: 'Ready.', actions: [], createdAt: '2026-07-14T12:00:00Z' },
        }),
      ] as SessionMeta[],
    })
    expect(
      deriveTrayItems([both], null)
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['offer', 'question'])
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
          agentState: { phase: 'needs_user', since: 't', nativeSubagentCount: 0 },
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
