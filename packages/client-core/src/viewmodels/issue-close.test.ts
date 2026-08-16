import { asSessionId, type SessionMeta, type SessionMetaInput } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { blockingCloseConcerns, type IssueCloseSubject, issueCloseConcerns } from './issue-close'

const session = (over: Partial<SessionMetaInput>): SessionMeta =>
  ({
    sessionId: asSessionId('s'),
    agentKind: 'codex',
    title: 'Agent',
    cwd: '/r/wt',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-22T10:00:00.000Z',
    lastActiveAt: '2026-07-22T10:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  }) as SessionMeta

const issue = (over: Partial<IssueCloseSubject> = {}): IssueCloseSubject => ({
  needsHuman: false,
  childCount: 0,
  childDoneCount: 0,
  parentBranch: 'main',
  ...over,
})

const working = { phase: 'working', since: 'now', nativeSubagentCount: 0 } as const
const offer = { message: 'Choose a direction', actions: [], createdAt: 'now' }

describe('issue close concerns', () => {
  it('surfaces decisions, questions, working agents, children, and delivery work', () => {
    const members = [
      session({ sessionId: 'waiting', offer }),
      session({ sessionId: 'working', agentState: working }),
    ]

    expect(
      issueCloseConcerns(
        issue({
          needsHuman: true,
          humanQuestion: 'Which direction should we ship?',
          childCount: 3,
          childDoneCount: 1,
          gitState: {
            updatedAt: '2026-07-23T10:00:00.000Z',
            branch: 'issue/4',
            shared: false,
            ahead: 2,
            dirtyFiles: 1,
            dirtyOwn: 1,
          },
        }),
        members,
      ).map((concern) => concern.key),
    ).toEqual(['offers', 'question', 'working', 'children', 'dirty', 'delivery'])
  })

  it('omits unrelated shared-checkout fallback dirt', () => {
    expect(
      issueCloseConcerns(
        issue({
          gitState: {
            updatedAt: '2026-07-23T10:00:00.000Z',
            branch: 'main',
            shared: true,
            dirtyFiles: 26,
            fallback: true,
          },
        }),
      ),
    ).toEqual([])
  })

  it('drops archived members, so neither caller has to remember to', () => {
    // The desktop resolves membership from `memberSessionIds` and the phone from
    // `session.issueId`; only one of those spellings naturally excludes an
    // archived row, so the derivation owns the rule.
    const members = [
      session({ sessionId: 'retired', archived: true, offer }),
      session({ sessionId: 'also-retired', archived: true, agentState: working }),
    ]

    expect(issueCloseConcerns(issue(), members)).toEqual([])
  })

  it('counts a busy shell as work in flight, exactly as the green dot does', () => {
    // #115: `isSessionWorking` is one predicate. A terminal running a command is
    // work the close would walk away from, whatever launched it.
    const concerns = issueCloseConcerns(issue(), [
      session({ sessionId: 'sh', agentKind: 'shell', busy: true }),
    ])

    expect(concerns.map((concern) => concern.key)).toEqual(['working'])
    expect(concerns[0]?.label).toBe('1 agent is still working')
  })

  it('says nothing about a tidy issue — which is what lets the phone press stay cheap', () => {
    expect(blockingCloseConcerns(issueCloseConcerns(issue(), [session({})]))).toEqual([])
  })

  it('treats every concern it raises as one that must be read', () => {
    // POD-1129 hangs the phone's whole interrupt decision on `blocking`. If a
    // non-blocking concern is ever added, the phone silently stops showing it —
    // so the day that changes, this fails and the mobile guard gets revisited.
    const concerns = issueCloseConcerns(issue({ childCount: 2, childDoneCount: 0 }), [
      session({ offer }),
    ])

    expect(blockingCloseConcerns(concerns)).toEqual(concerns)
  })
})
