import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { buildFocusCards } from './focusCards'

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

function issue(overrides: Partial<IssueWire> & { id: string; seq: number; title: string }): IssueWire {
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
    readAt: null,
    unread: false,
    origin: 'human',
    draft: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    ...rest,
    id,
    seq,
    title,
  }
}

describe('mobile focus cards', () => {
  it('orders needs-you sessions first and carries issue context', () => {
    const cards = buildFocusCards({
      sessions: [
        session({
          sessionId: 'working',
          title: 'Working agent',
          lastActiveAt: '2026-07-01T03:00:00.000Z',
          agentState: { phase: 'working', since: '2026-07-01T03:00:00.000Z', openTaskCount: 0 },
        }),
        session({
          sessionId: 'need',
          title: 'Needs decision',
          issueId: 'issue-1',
          lastActiveAt: '2026-07-01T01:00:00.000Z',
          agentState: {
            phase: 'needs_user',
            since: '2026-07-01T01:00:00.000Z',
            openTaskCount: 0,
            need: { kind: 'question', summary: 'Pick the navigation model' },
          },
        }),
      ],
      issues: [issue({ id: 'issue-1', seq: 80, title: 'Expo mobile client' })],
      now: Date.parse('2026-07-01T03:10:00.000Z'),
    })

    expect(cards.map((card) => card.sessionId)).toEqual(['need', 'working'])
    expect(cards[0]).toMatchObject({
      issueLabel: '#80 Expo mobile client',
      summary: 'Pick the navigation model',
      title: 'Needs decision',
    })
  })

  it('filters shell and headless sessions out of the mobile focus queue', () => {
    const cards = buildFocusCards({
      sessions: [
        session({ sessionId: 'agent' }),
        session({ sessionId: 'shell', agentKind: 'shell' }),
        session({ sessionId: 'headless', headless: true }),
      ],
      issues: [],
      now: Date.parse('2026-07-01T00:00:00.000Z'),
    })

    expect(cards.map((card) => card.sessionId)).toEqual(['agent'])
  })
})
