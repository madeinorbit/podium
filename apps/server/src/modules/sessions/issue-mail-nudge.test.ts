import { asIssueId, asSessionId, type SessionMeta, type SessionMetaInput } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { nudgeIssueMail } from './issue-mail-nudge'

const ISSUE_ID = asIssueId('iss_target')

const session = (input: Partial<SessionMetaInput> & { sessionId: string }): SessionMeta =>
  ({
    agentKind: 'codex',
    cwd: '/r/.worktrees/target',
    status: 'live',
    lastActiveAt: '2026-08-27T00:00:00.000Z',
    ...input,
    sessionId: asSessionId(input.sessionId),
  }) as never

function harness(sessions: SessionMeta[], coordinatorSessionId?: string) {
  return {
    issueMeta: vi.fn(() => ({
      id: ISSUE_ID,
      worktreePath: '/r/.worktrees/target',
      ...(coordinatorSessionId ? { coordinatorSessionId: asSessionId(coordinatorSessionId) } : {}),
    })),
    sessionsForIssue: vi.fn(() => sessions),
    sendText: vi.fn(),
    queueText: vi.fn(),
  }
}

describe('legacy issue-mail coordinator nudge', () => {
  it('resolves explicit membership by canonical issue id and sends to the idle coordinator', () => {
    const ports = harness(
      [
        session({
          sessionId: 'worker',
          lastActiveAt: '2026-08-27T02:00:00.000Z',
          agentState: { phase: 'idle', since: 't', nativeSubagentCount: 0 },
        }),
        session({
          sessionId: 'coordinator',
          lastActiveAt: '2026-08-27T01:00:00.000Z',
          agentState: { phase: 'idle', since: 't', nativeSubagentCount: 0 },
        }),
      ],
      'coordinator',
    )

    nudgeIssueMail(ports, { issueId: ISSUE_ID, seq: 42 })

    expect(ports.sessionsForIssue).toHaveBeenCalledWith('/r/.worktrees/target', ISSUE_ID)
    expect(ports.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: asSessionId('coordinator') }),
    )
    expect(ports.queueText).not.toHaveBeenCalled()
  })

  it('queues for a busy coordinator and falls back only when the coordinator is unavailable', () => {
    const members = [
      session({
        sessionId: 'worker',
        lastActiveAt: '2026-08-27T02:00:00.000Z',
        agentState: { phase: 'idle', since: 't', nativeSubagentCount: 0 },
      }),
      session({
        sessionId: 'coordinator',
        lastActiveAt: '2026-08-27T01:00:00.000Z',
        agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 },
      }),
    ]
    const coordinated = harness(members, 'coordinator')
    nudgeIssueMail(coordinated, { issueId: ISSUE_ID, seq: 42 })
    expect(coordinated.queueText).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: asSessionId('coordinator') }),
    )

    const dangling = harness(members, 'gone')
    nudgeIssueMail(dangling, { issueId: ISSUE_ID, seq: 42 })
    expect(dangling.queueText).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: asSessionId('worker') }),
    )
  })
})
