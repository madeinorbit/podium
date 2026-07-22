import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { issueCloseConcerns } from './issue-lifecycle'

const session = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    sessionId: 's',
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
    const issue = makeIssue({
      needsHuman: true,
      humanQuestion: 'Which direction should we ship?',
      childCount: 3,
      childDoneCount: 1,
      sessions: [
        session({
          offer: { message: 'Choose a direction', actions: [], createdAt: 'now' },
          agentState: {
            phase: 'working',
            since: 'now',
            nativeSubagentCount: 0,
          },
        }),
      ],
      gitState: {
        updatedAt: '2026-07-23T10:00:00.000Z',
        branch: 'issue/4',
        shared: false,
        ahead: 2,
        dirtyFiles: 1,
        dirtyOwn: 1,
      },
    })

    expect(issueCloseConcerns(issue).map((concern) => concern.key)).toEqual([
      'offers',
      'question',
      'working',
      'children',
      'dirty',
      'delivery',
    ])
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
