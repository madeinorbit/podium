import type { IssueWire, SessionMeta, TranscriptItem } from '@podium/model'

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
      nativeSubagentCount: 1,
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
    issueId: 'demo-issue-header',
    name: 'claude — header polish',
    lastActiveAt: min(11),
    agentState: {
      phase: 'idle',
      since: min(11),
      nativeSubagentCount: 0,
      idle: {
        kind: 'approval',
        summary: 'Plan ready: add covering index + cache warm-up on deploy.',
      },
    },
    offer: {
      message:
        'Login screen ready to merge\n43 tests green, header matches the mock; git chip stays on the dark recipe.',
      actions: [
        { label: '✓ Merge', prompt: 'Merge the branch to main.' },
        { label: 'Send back…', prompt: 'Do not merge yet. Address this feedback:', input: true },
      ],
      createdAt: min(4),
    },
  }),
  session({
    sessionId: 'demo-flaky',
    title: 'Deflake payments e2e suite',
    agentColor: 'purple',
    lastActiveAt: min(26),
    agentState: { phase: 'working', since: min(26), nativeSubagentCount: 3 },
  }),
  session({
    sessionId: 'demo-docs',
    title: 'API reference overhaul',
    agentColor: 'green',
    lastActiveAt: min(95),
    status: 'hibernated',
    resumable: true,
    agentState: { phase: 'idle', since: min(95), nativeSubagentCount: 0, idle: { kind: 'done' } },
  }),
  session({
    sessionId: 'demo-migrate',
    title: 'Migrate CI to blacksmith runners',
    agentColor: 'blue',
    lastActiveAt: min(41),
    agentState: { phase: 'working', since: min(41), nativeSubagentCount: 1 },
    queuedMessageCount: 1,
  }),
]

/** Shared scaffolding for the demo proposals (POD-277's screening deck). */
function proposal(
  partial: Partial<IssueWire> & Pick<IssueWire, 'id' | 'seq' | 'title' | 'description'>,
): IssueWire {
  return {
    repoPath: '/home/dev/src/podium',
    displayRef: `POD-${partial.seq}`,
    prefix: 'POD',
    stage: 'proposed',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 2,
    type: 'task',
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
    createdAt: min(300),
    updatedAt: min(300),
    archived: false,
    origin: 'agent',
    audience: 'human',
    draft: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    readAt: null,
    unread: true,
    ...partial,
  } as IssueWire
}

export const DEMO_ISSUES: IssueWire[] = [
  proposal({
    id: 'demo-proposal-retry',
    seq: 301,
    priority: 1,
    type: 'bug',
    color: 'cyan',
    title: 'Transcript reconnect drops queued turns',
    description:
      'After a phone reconnect the composer clears but the queued turn never reaches the agent, so the operator retypes it.',
    brief:
      'Repro: background the app mid-turn, kill wifi, return. packages/client-core/src/engine/engine.ts drops the outbox entry when the socket re-handshakes with a newer cursor. Add a replay test in engine.test.ts before touching the flush path.',
    createdAt: min(90),
    updatedAt: min(90),
  }),
  proposal({
    id: 'demo-proposal-quota',
    seq: 298,
    type: 'feature',
    color: 'lime',
    title: 'Quota strip on the phone tray',
    description:
      'The desktop shows per-harness quota; the phone has no way to see how much budget is left before starting more work.',
    brief:
      'Reuse the web quota viewmodel in packages/client-core/src/viewmodels; render as a two-row strip under the Tray header. Mono micro type, no new colours.',
    createdAt: min(210),
    updatedAt: min(210),
  }),
  proposal({
    id: 'demo-proposal-cleanup',
    seq: 294,
    priority: 3,
    type: 'chore',
    title: 'Retire the legacy focus helpers',
    description:
      'Two focus-ranking helpers survive from before the shared store landed and now disagree with it in edge cases.',
    brief:
      'Delete groupSessionsLegacy and its tests once the mobile Tray reads the store ordering.',
    blockedBy: ['demo-issue-header'],
    dependencyNote: 'waits on the session header work',
    createdAt: min(1400),
    updatedAt: min(1400),
  }),
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
    humanQuestion: 'Should refresh tokens rotate on every use, or only on expiry?',
    humanQuestionOptions: ['Rotate every use', 'Rotate on expiry only'],
    color: 'teal',
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
    audience: 'human',
    draft: false,
    sessions: [],
    sessionSummary: { total: 1, byPhase: { needs_user: 1 } },
    readAt: null,
    unread: false,
  } as IssueWire,
  {
    id: 'demo-issue-header',
    repoPath: '/home/dev/src/podium',
    seq: 121,
    title: 'Session header redesign',
    description: 'Segmented mode switch, model token, overflow menu.',
    stage: 'review',
    worktreePath: null,
    branch: 'issue/121-session-header',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 2,
    type: 'feature',
    pinned: false,
    needsHuman: false,
    color: 'violet',
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 2,
    childDoneCount: 1,
    createdAt: min(900),
    updatedAt: min(4),
    archived: false,
    origin: 'human',
    audience: 'human',
    draft: false,
    sessions: [
      {
        sessionId: 'demo-perf',
        agentKind: 'claude-code',
        title: 'Profile slow dashboard query',
        name: 'claude — header polish',
        cwd: '/home/dev/src/podium',
        status: 'live',
        controllerId: null,
        geometry: { cols: 80, rows: 24 },
        epoch: 0,
        clientCount: 0,
        createdAt: min(240),
        lastActiveAt: min(4),
        origin: { kind: 'spawn' },
        archived: false,
        readAt: null,
        unread: false,
        issueId: 'demo-issue-header',
        offer: {
          message:
            'Login screen ready to merge\n43 tests green, header matches the mock; git chip stays on the dark recipe.',
          actions: [
            { label: '✓ Merge', prompt: 'Merge the branch to main.' },
            {
              label: 'Send back…',
              prompt: 'Do not merge yet. Address this feedback:',
              input: true,
            },
          ],
          createdAt: min(4),
        },
      } as unknown as SessionMeta,
    ],
    sessionSummary: { total: 1, byPhase: { idle: 1 } },
    readAt: null,
    unread: false,
  } as IssueWire,
  {
    id: 'demo-issue-ci',
    repoPath: '/home/dev/src/podium',
    seq: 118,
    title: 'CI runner migration',
    description: 'Move CI to blacksmith runners.',
    stage: 'done',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 2,
    type: 'chore',
    pinned: false,
    needsHuman: false,
    color: 'rose',
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: min(2000),
    updatedAt: min(30),
    closedAt: min(30),
    closedReason: 'merged to main · 52769669',
    archived: false,
    origin: 'human',
    audience: 'human',
    draft: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    readAt: null,
    unread: false,
  } as IssueWire,
]

export const DEMO_TRANSCRIPTS: Record<string, TranscriptItem[]> = {
  'demo-auth': [
    {
      id: 't1',
      role: 'user',
      text: 'The OAuth refresh loop is logging users out — see POD-87. Find the race and fix it.',
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

/** The global thread's headless session in demo mode. The Super agent screen
 *  renders that session's TRANSCRIPT (POD-344) — it no longer reads the legacy
 *  `superagent.history` buffer — so the fixture has to ride this seam to show up. */
export const DEMO_SUPER_SESSION = 'demo-superagent'

DEMO_TRANSCRIPTS[DEMO_SUPER_SESSION] = [
  {
    id: 'super-t1',
    role: 'user',
    text: 'What needs my attention across my repos this morning?',
    ts: min(65),
  },
  {
    id: 'super-t2',
    role: 'assistant',
    text: 'Three things: the OAuth bug (#87) has a question waiting for you, the payments e2e suite is being deflaked (ETA ~20m), and CI runner migration is idle-ready to merge once tests go green. I can queue the merge for you.',
    ts: min(64),
  },
]
