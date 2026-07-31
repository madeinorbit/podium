import { asSessionId, type SessionMeta, type SessionMetaInput } from '@podium/model'
import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { deriveTrayItems as deriveTrayItemsCore, offerKey, workingSessionCount } from './derive-tray'

const session = (over: Partial<SessionMetaInput>): SessionMeta =>
  ({
    sessionId: asSessionId('s1'),
    agentKind: 'claude-code',
    status: 'live',
    createdAt: 't',
    lastActiveAt: 't',
    cwd: '/r/wt',
    agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 },
    ...over,
  }) as SessionMeta


const deriveTrayItems = (issues: ReturnType<typeof makeIssue>[], dismissed?: ReadonlySet<string>) => {
  const sessions = issues.flatMap((issue) => issue.sessions ?? [])
  // Membership moves to `memberSessionIds`; `sessions` is EMPTIED rather than
  // dropped because this tree's `IssueWire` still declares it required, and the
  // point of the normalization is that nothing downstream reads it — an empty
  // array proves that as well as an absent key would, and compiles.
  const normalized: IssueNavigationModel[] = issues.map((issue) => ({
    ...issue,
    memberSessionIds: (issue.sessions ?? []).map((session) => session.sessionId),
    sessions: [],
  }))
  return deriveTrayItemsCore(normalized, sessions, dismissed)
}
describe('deriveTrayItems', () => {
  it('is GLOBAL (§5): items from every live issue, no scoping, dead issues out', () => {
    const asking = makeIssue({
      id: 'q',
      needsHuman: true,
      humanQuestion: 'Ship with flag on?',
      updatedAt: '2026-07-14T10:00:00Z',
    })
    const unrelated = makeIssue({
      id: 'x',
      parentId: 'elsewhere',
      needsHuman: true,
      updatedAt: '2026-07-14T09:00:00Z',
    })
    const archived = makeIssue({ id: 'dead', needsHuman: true, archived: true })
    const tombstoned = makeIssue({ id: 'gone', needsHuman: true, deletedAt: 't' })
    const items = deriveTrayItems([asking, unrelated, archived, tombstoned])
    expect(items.map((i) => i.issue.id)).toEqual(['q', 'x'])
  })

  it('shows ONLY human-actionable items: questions, plus the review backstop', () => {
    const asking = makeIssue({
      id: 'q',
      needsHuman: true,
      humanQuestion: 'Ship with flag on?',
      updatedAt: '2026-07-14T10:00:00Z',
    })
    // Review-ready work normally announces itself via a session offer, but the
    // stage alone gets a deterministic backstop card [POD-118] — a hook-forced
    // agent turn must not be able to make review work invisible.
    const review = makeIssue({
      id: 'r',
      stage: 'review',
      suggestedReason: 'Tests green, ready to merge.',
      updatedAt: '2026-07-14T11:00:00Z',
    })
    const working = makeIssue({ id: 'w', stage: 'in_progress' })
    const items = deriveTrayItems([makeIssue({ id: 'p' }), asking, review, working])
    expect(items.map((i) => `${i.kind}:${i.issue.id}`)).toEqual(['review:r', 'question:q'])
  })

  it('drops offers on closed/done issues so finished work cannot demand a decision (POD-290)', () => {
    const offer = {
      message: 'Merge to main?',
      actions: [{ label: 'Merge', prompt: 'Merge it' }],
      createdAt: '2026-07-14T12:00:00Z',
    }
    const closed = makeIssue({
      id: 'closed',
      stage: 'done',
      closedReason: 'done',
      sessions: [session({ sessionId: asSessionId('delegate'), offer })] as SessionMeta[],
    })
    const review = makeIssue({
      id: 'review',
      stage: 'review',
      sessions: [session({ sessionId: asSessionId('live'), offer })] as SessionMeta[],
      updatedAt: '2026-07-14T13:00:00Z',
    })
    expect(deriveTrayItems([closed, review]).map((i) => `${i.kind}:${i.issue.id}`)).toEqual([
      'offer:review',
    ])
  })

  it('review backstop [POD-118]: yields to a live offer, a dismissed offer, or a question', () => {
    const offer = { message: 'Ready.', actions: [], createdAt: '2026-07-14T12:00:00Z' }
    // No offer at all → the backstop card carries the review stage.
    const bare = makeIssue({ id: 'bare', stage: 'review', updatedAt: '2026-07-14T11:00:00Z' })
    expect(deriveTrayItems([bare]).map((i) => i.kind)).toEqual(['review'])
    // A live offer is the richer announcement — no duplicate backstop.
    const offered = makeIssue({
      id: 'o',
      stage: 'review',
      sessions: [session({ sessionId: asSessionId('agent'), offer })] as SessionMeta[],
    })
    expect(deriveTrayItems([offered]).map((i) => i.kind)).toEqual(['offer'])
    // An optimistically-dismissed offer means the user just acted — the
    // backstop must not pop in for that beat.
    const dismissed = new Set([offerKey(asSessionId('agent'), offer.createdAt)])
    expect(deriveTrayItems([offered], dismissed)).toHaveLength(0)
    // A needsHuman question already gives the issue a card — don't double up.
    const asking = makeIssue({
      id: 'a',
      stage: 'review',
      needsHuman: true,
      humanQuestion: 'Merge?',
    })
    expect(deriveTrayItems([asking]).map((i) => i.kind)).toEqual(['question'])
  })

  it('sorts newest-first, stable whatever is selected (§2.3-v3)', () => {
    const oldQuestion = makeIssue({
      id: 'q-old',
      needsHuman: true,
      humanQuestion: 'Which flag?',
      updatedAt: '2026-07-14T09:00:00Z',
    })
    const newOffer = makeIssue({
      id: 'o-new',
      sessions: [
        session({
          sessionId: asSessionId('agent'),
          offer: { message: 'Ready.', actions: [], createdAt: '2026-07-14T11:00:00Z' },
        }),
      ] as SessionMeta[],
    })
    const items = deriveTrayItems([oldQuestion, newOffer])
    expect(items.map((i) => `${i.kind}:${i.issue.id}`)).toEqual(['offer:o-new', 'question:q-old'])
  })

  it('falls back to the question placeholder text', () => {
    const bare = makeIssue({ id: 'a', needsHuman: true, updatedAt: '2026-07-14T09:00:00Z' })
    expect(deriveTrayItems([bare])[0]).toMatchObject({
      kind: 'question',
      text: 'Needs your input.',
    })
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
        session({ sessionId: asSessionId('agent'), offer }),
        session({ sessionId: asSessionId('sh'), agentKind: 'shell', offer }),
        session({ sessionId: asSessionId('hl'), headless: true, offer }),
        session({ sessionId: asSessionId('dead'), archived: true, offer }),
        session({ sessionId: asSessionId('quiet') }),
      ] as SessionMeta[],
    })
    const items = deriveTrayItems([issue])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'offer',
      offer,
      session: { sessionId: asSessionId('agent') },
      since: offer.createdAt,
    })
  })

  it('hides an offer optimistically via the dismissed set, keyed per offer instance', () => {
    const offer = { message: 'm', actions: [], createdAt: '2026-07-14T12:00:00Z' }
    const issue = makeIssue({
      id: 'o',
      sessions: [session({ sessionId: asSessionId('agent'), offer })] as SessionMeta[],
    })
    const dismissed = new Set([offerKey(asSessionId('agent'), offer.createdAt)])
    expect(deriveTrayItems([issue], dismissed)).toHaveLength(0)
    // A NEW offer on the same session is a new key — it shows again.
    const fresh = { ...offer, createdAt: '2026-07-14T13:00:00Z' }
    const again = makeIssue({
      id: 'o',
      sessions: [session({ sessionId: asSessionId('agent'), offer: fresh })] as SessionMeta[],
    })
    expect(deriveTrayItems([again], dismissed)).toHaveLength(1)
  })

  it('finished/done issues NEVER render — the tray is attention-only [POD-198]', () => {
    // Archive cleanup is not attention: even a just-closed, never-read human
    // issue gets no card. Archiving lives on the board/sidebar.
    const fresh = makeIssue({
      id: 'f',
      stage: 'done',
      closedAt: '2026-07-14T11:00:00Z',
      closedReason: 'merged',
      unread: true,
    })
    const reasonOnly = makeIssue({ id: 'r', closedReason: 'superseded' })
    expect(deriveTrayItems([fresh, reasonOnly])).toHaveLength(0)
  })

  it('an issue with both a question and a session offer yields both cards', () => {
    const both = makeIssue({
      id: 'b',
      stage: 'review',
      needsHuman: true,
      humanQuestion: 'Merge strategy?',
      sessions: [
        session({
          sessionId: asSessionId('agent'),
          offer: { message: 'Ready.', actions: [], createdAt: '2026-07-14T12:00:00Z' },
        }),
      ] as SessionMeta[],
    })
    expect(
      deriveTrayItems([both])
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['offer', 'question'])
  })
})

describe('workingSessionCount', () => {
  it('counts working agent sessions globally, excluding shells/headless/archived', () => {
    const sessions = [
      session({ sessionId: 'w1' }),
      session({
        sessionId: 'w2',
        agentState: { phase: 'needs_user', since: 't', nativeSubagentCount: 0 },
      }),
      session({ sessionId: 'w3', agentKind: 'shell', busy: true }),
      session({ sessionId: 'w4', headless: true }),
      session({ sessionId: 'w5', archived: true }),
      session({ sessionId: 'w6' }),
      session({ sessionId: 'w7' }),
    ] as SessionMeta[]
    const issue = { ...makeIssue({ id: 'p' }), memberSessionIds: ['w1', 'w2', 'w3', 'w4', 'w5'] }
    const child = { ...makeIssue({ id: 'c', parentId: 'p' }), memberSessionIds: ['w6'] }
    const outside = { ...makeIssue({ id: 'x' }), memberSessionIds: ['w7'] }
    expect(workingSessionCount([issue, child, outside], sessions)).toBe(3)
  })
})
