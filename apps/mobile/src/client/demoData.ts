import type { IssueWire, SessionMeta, TranscriptItem } from '@podium/protocol'

/**
 * Fixture metadata for demo mode (`?demo=1` on web): realistic sessions and
 * issues so design work and store screenshots don't need a seeded backend.
 * Never active unless explicitly requested via the query param.
 */

export function demoEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1'
  } catch {
    return false
  }
}

const T0 = Date.now()
const min = (n: number) => new Date(T0 - n * 60_000).toISOString()

function session(
  partial: Partial<SessionMeta> & { sessionId: string; title: string },
): SessionMeta {
  return {
    agentKind: 'claude-code',
    cwd: '/home/dev/src/podium',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: min(240),
    lastActiveAt: min(3),
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...partial,
  } as SessionMeta
}

export const DEMO_SESSIONS: SessionMeta[] = [
  session({
    sessionId: 'demo-auth',
    title: 'Fix OAuth token refresh',
    name: 'Fix OAuth token refresh',
    agentColor: 'orange',
    issueId: 'demo-issue-auth',
    lastActiveAt: min(2),
    agentState: {
      phase: 'needs_user',
      since: min(2),
      openTaskCount: 1,
      need: {
        kind: 'question',
        summary: 'Should refresh tokens rotate on every use, or only on expiry?',
      },
    },
  }),
  session({
    sessionId: 'demo-perf',
    title: 'Profile slow dashboard query',
    agentColor: 'cyan',
    lastActiveAt: min(11),
    agentState: {
      phase: 'idle',
      since: min(11),
      openTaskCount: 0,
      idle: {
        kind: 'approval',
        summary: 'Plan ready: add covering index + cache warm-up on deploy.',
      },
    },
  }),
  session({
    sessionId: 'demo-flaky',
    title: 'Deflake payments e2e suite',
    agentColor: 'purple',
    lastActiveAt: min(26),
    agentState: { phase: 'working', since: min(26), openTaskCount: 3 },
  }),
  session({
    sessionId: 'demo-docs',
    title: 'API reference overhaul',
    agentColor: 'green',
    lastActiveAt: min(95),
    status: 'hibernated',
    resumable: true,
    agentState: { phase: 'idle', since: min(95), openTaskCount: 0, idle: { kind: 'done' } },
  }),
  session({
    sessionId: 'demo-migrate',
    title: 'Migrate CI to blacksmith runners',
    agentColor: 'blue',
    lastActiveAt: min(41),
    agentState: { phase: 'working', since: min(41), openTaskCount: 1 },
    queuedMessageCount: 1,
  }),
]

export const DEMO_ISSUES: IssueWire[] = [
  {
    id: 'demo-issue-auth',
    repoPath: '/home/dev/src/podium',
    seq: 87,
    title: 'OAuth refresh loop logs users out',
    description:
      'Users report being logged out mid-session. Suspect the refresh token rotation races the concurrent tab.',
    stage: 'in_progress',
    worktreePath: null,
    branch: 'issue/87-oauth-refresh',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 1,
    type: 'bug',
    pinned: false,
    needsHuman: true,
    labels: [],
    deps: [],
    dependents: [],
    comments: [
      {
        id: 'c1',
        author: 'till',
        body: 'Repros on Safari with two tabs open. Backend logs show 401 storms.',
        createdAt: min(180),
      },
    ],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: min(600),
    updatedAt: min(20),
    archived: false,
    origin: 'human',
    draft: false,
    sessions: [],
    sessionSummary: { total: 1, byPhase: { needs_user: 1 } },
    readAt: null,
    unread: false,
  } as IssueWire,
]

export const DEMO_TRANSCRIPTS: Record<string, TranscriptItem[]> = {
  'demo-auth': [
    {
      id: 't1',
      role: 'user',
      text: 'The OAuth refresh loop is logging users out — see issue #87. Find the race and fix it.',
      ts: min(55),
    },
    {
      id: 't2',
      role: 'assistant',
      text: 'Reproduced it. Two tabs refresh concurrently; the second rotation invalidates the first tab’s brand-new token. The fix is either a rotation grace window or refresh-token reuse detection with a shared lock.',
      ts: min(30),
    },
    {
      id: 't3',
      role: 'tool',
      text: '',
      toolName: 'Bash',
      toolTitle: 'Run auth integration tests',
      toolResult: '14 passed',
      toolUseId: 'x1',
      ts: min(12),
    },
    {
      id: 't4',
      role: 'tool',
      text: '',
      toolName: 'AskUserQuestion',
      toolInputJson: JSON.stringify({
        questions: [
          {
            question: 'Should refresh tokens rotate on every use, or only on expiry?',
            options: [
              {
                label: 'Rotate every use (recommended)',
                description: 'Best security; needs the 30s grace window to fix multi-tab.',
              },
              {
                label: 'Rotate on expiry only',
                description: 'Simpler; slightly weaker against token theft.',
              },
            ],
          },
        ],
      }),
      ts: min(2),
    },
  ],
}

export const DEMO_SUPERAGENT = [
  {
    id: 1,
    role: 'user' as const,
    content: 'What needs my attention across my repos this morning?',
    createdAt: min(65),
  },
  {
    id: 2,
    role: 'assistant' as const,
    content:
      'Three things: the OAuth bug (#87) has a question waiting for you, the payments e2e suite is being deflaked (ETA ~20m), and CI runner migration is idle-ready to merge once tests go green. I can queue the merge for you.',
    createdAt: min(64),
  },
]
