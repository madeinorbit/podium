import { asSessionId, type SessionMeta, type SessionMetaInput } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { issueBulkCloseSummary, issueCloseConcerns } from './issue-lifecycle'

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

describe('issue close concerns', () => {
  it('surfaces decisions, questions, working agents, children, and delivery work', () => {
    const sessions = [
      session({
        sessionId: 'waiting',
        offer: { message: 'Choose a direction', actions: [], createdAt: 'now' },
      }),
      session({
        sessionId: 'working',
        agentState: {
          phase: 'working',
          since: 'now',
          nativeSubagentCount: 0,
        },
      }),
    ]
    const issue = makeIssue({
      needsHuman: true,
      humanQuestion: 'Which direction should we ship?',
      childCount: 3,
      childDoneCount: 1,
      memberSessionIds: sessions.map((member) => member.sessionId),
      gitState: {
        updatedAt: '2026-07-23T10:00:00.000Z',
        branch: 'issue/4',
        shared: false,
        ahead: 2,
        dirtyFiles: 1,
        dirtyOwn: 1,
      },
    })

    expect(issueCloseConcerns(issue, sessions).map((concern) => concern.key)).toEqual([
      'offers',
      'question',
      'working',
      'children',
      'dirty',
      'delivery',
    ])
  })

  it('counts a batch by what is unresolved in it, keeping selection order', () => {
    const sessions = [
      session({
        sessionId: 'busy',
        agentState: { phase: 'working', since: 'now', nativeSubagentCount: 0 },
      }),
    ]
    const summary = issueBulkCloseSummary(
      [
        makeIssue({ id: 'clean', seq: 1 }),
        makeIssue({ id: 'busy', seq: 2, memberSessionIds: ['busy'] }),
        makeIssue({ id: 'children', seq: 3, childCount: 2, childDoneCount: 0 }),
      ],
      sessions,
    )

    expect(summary.clear).toBe(1)
    expect(summary.flagged.map((entry) => entry.issue.id)).toEqual(['busy', 'children'])
    // Every flagged row can be drawn: `lead` is the concern the icon comes from.
    expect(summary.flagged.map((entry) => entry.lead.key)).toEqual(['working', 'children'])
  })

  it('flags nothing when a whole batch is resolved', () => {
    const summary = issueBulkCloseSummary([makeIssue({ id: 'a' }), makeIssue({ id: 'b' })])

    expect(summary).toEqual({ flagged: [], clear: 2 })
  })

  it('omits unrelated shared-checkout fallback dirt', () => {
    const concerns = issueCloseConcerns(
      makeIssue({
        gitState: {
          updatedAt: '2026-07-23T10:00:00.000Z',
          branch: 'main',
          shared: true,
          dirtyFiles: 26,
          fallback: true,
        },
      }),
    )

    expect(concerns).toEqual([])
  })
})
