import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { sessionCardModel, sessionTitle } from './session-card'

function session(overrides: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  const { sessionId, ...rest } = overrides
  return {
    agentKind: 'claude-code',
    title: 'Implement mobile',
    cwd: '/repo/podium',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...rest,
    sessionId,
  }
}

function issue(
  overrides: Partial<IssueWire> & { id: string; seq: number; title: string },
): IssueWire {
  const { id, seq, title, ...rest } = overrides
  return {
    repoPath: '/repo/podium',
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 0,
    type: 'feature',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archived: false,
    origin: 'human',
    audience: 'human',
    draft: false,
    readAt: null,
    unread: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    ...rest,
    id,
    seq,
    title,
  }
}

describe('session card view model', () => {
  it('carries attention summary, group and issue context', () => {
    const model = sessionCardModel(
      session({
        sessionId: 'need',
        title: 'Needs decision',
        issueId: 'issue-1',
        lastActiveAt: '2026-07-01T01:00:00.000Z',
        queuedMessageCount: 2,
        agentState: {
          phase: 'needs_user',
          since: '2026-07-01T01:00:00.000Z',
          openTaskCount: 0,
          need: { kind: 'question', summary: 'Pick the navigation model' },
        },
      }),
      issue({ id: 'issue-1', seq: 80, title: 'Expo mobile client' }),
      Date.parse('2026-07-01T03:10:00.000Z'),
    )

    expect(model).toMatchObject({
      sessionId: 'need',
      title: 'Needs decision',
      issueLabel: '#80 Expo mobile client',
      summary: 'Pick the navigation model',
      group: 'needsYou',
      dotTone: 'attention',
      queuedCount: 2,
    })
    expect(model.subtitle).toContain('Claude')
    expect(model.subtitle).toContain('2h ago')
  })

  it('prefers the user-set name, then title, then the cwd basename', () => {
    expect(sessionTitle(session({ sessionId: 'a', name: 'My rename', title: 'live title' }))).toBe(
      'My rename',
    )
    expect(sessionTitle(session({ sessionId: 'b', title: 'live title' }))).toBe('live title')
    expect(sessionTitle(session({ sessionId: 'c', title: '  ' }))).toBe('podium')
  })
})
