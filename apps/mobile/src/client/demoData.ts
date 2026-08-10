import type { SessionId } from '@podium/model'
import {
  asIssueId,
  asMachineId,
  asSessionId,
  type HostMetricsWire,
  type IssueWire,
  type IssueWireInput,
  type MachineQuotaWire,
  type QuotaWindowWire,
  type SessionMeta,
  type SessionMetaInput,
  type TranscriptItem,
  type UsageBucketWire,
} from '@podium/model'

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
  partial: Partial<SessionMetaInput> & { sessionId: SessionId; title: string },
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

const DEMO_MISSION_SESSIONS: SessionMeta[] = [
  session({
    sessionId: asSessionId('demo-mission-coord'),
    title: 'Check status and plan for landing PR 554',
    name: 'Check status and plan for landing PR 554',
    issueId: 'demo-mission-root',
    agentColor: 'rose',
    lastActiveAt: min(1),
    agentState: {
      phase: 'working',
      since: min(31),
      nativeSubagentCount: 0,
      workingMsTotal: 1127538,
    },
  }),
  session({
    sessionId: asSessionId('demo-mission-gc-agent'),
    title: 'Worktree GC janitor sweep',
    name: 'Worktree GC janitor sweep',
    issueId: 'demo-mission-gc',
    agentColor: 'orange',
    lastActiveAt: min(12),
    agentState: {
      phase: 'idle',
      since: min(12),
      nativeSubagentCount: 0,
      idle: { kind: 'approval' },
    },
    offer: {
      message:
        'Worktree GC is committed and verified\nFlipping worktreeGc.mode to auto applies it; a dirty tree always refuses and is reported.',
      actions: [
        { label: 'Merge it', prompt: 'Merge the branch to main.' },
        { label: 'Send back…', prompt: 'Do not merge yet. Address this feedback:', input: true },
      ],
      createdAt: min(12),
    },
  }),
  session({
    sessionId: asSessionId('demo-mission-hibernate-agent'),
    title: 'Load-pressure hibernation path',
    name: 'Load-pressure hibernation path',
    agentKind: 'grok',
    issueId: 'demo-mission-hibernate',
    lastActiveAt: min(64),
    agentState: { phase: 'idle', since: min(64), nativeSubagentCount: 0, idle: { kind: 'done' } },
  }),
  session({
    sessionId: asSessionId('demo-mission-archive-agent'),
    title: 'Archive frees the worktree',
    name: 'Archive frees the worktree',
    issueId: 'demo-mission-archive',
    status: 'hibernated',
    lastActiveAt: min(140),
    agentState: {
      phase: 'idle',
      since: min(140),
      nativeSubagentCount: 0,
      idle: { kind: 'done' },
      workingMsTotal: 601044,
    },
  }),
]

export const DEMO_SESSIONS: SessionMeta[] = [
  ...DEMO_MISSION_SESSIONS,
  session({
    sessionId: asSessionId('demo-auth'),
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
    sessionId: asSessionId('demo-perf'),
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
    sessionId: asSessionId('demo-flaky'),
    title: 'Deflake payments e2e suite',
    agentColor: 'purple',
    lastActiveAt: min(26),
    agentState: { phase: 'working', since: min(26), nativeSubagentCount: 3 },
  }),
  session({
    sessionId: asSessionId('demo-docs'),
    title: 'API reference overhaul',
    agentColor: 'green',
    lastActiveAt: min(95),
    status: 'hibernated',
    resumable: true,
    agentState: { phase: 'idle', since: min(95), nativeSubagentCount: 0, idle: { kind: 'done' } },
  }),
  session({
    sessionId: asSessionId('demo-migrate'),
    title: 'Migrate CI to blacksmith runners',
    agentColor: 'blue',
    lastActiveAt: min(41),
    agentState: { phase: 'working', since: min(41), nativeSubagentCount: 1 },
    queuedMessageCount: 1,
  }),
]

/** Shared scaffolding for the demo proposals (POD-277's screening deck). */
function proposal(
  partial: Partial<IssueWireInput> & Pick<IssueWire, 'id' | 'seq' | 'title' | 'description'>,
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
    blockedByNotes: [],
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
    readAt: null,
    ...partial,
  } as IssueWire
}

/**
 * A MISSION, not a flat row [POD-592].
 *
 * Demo mode carried no parent/child edge at all, so the Flight Deck — the whole
 * point of tapping a Work row — had nothing to draw and could not be seen
 * without a live server. This is the smallest tree that exercises the spine's
 * real vocabulary: a running root with a coordinator, a blocked child that
 * names its blockers, two children with agents that stopped and asked, one
 * proposal nobody has accepted, and one done.
 */
function missionTask(
  partial: Partial<IssueWireInput> & Pick<IssueWire, 'id' | 'seq' | 'title' | 'description'>,
): IssueWire {
  return {
    ...proposal(partial),
    stage: 'backlog',
    origin: 'agent',
    ...partial,
  } as IssueWire
}

const DEMO_MISSION: IssueWire[] = [
  missionTask({
    id: asIssueId('demo-mission-root'),
    seq: 554,
    title: 'Host resource lifecycle policy',
    description:
      'Closed work still leaves agent sessions and git worktrees on the host, so the board can look quiet while the machine stays overloaded. We need a safe lifecycle policy for when sessions stop and worktrees free.',
    stage: 'review',
    priority: 1,
    color: 'rose',
    branch: 'issue/554-host-resource-lifecycle-policy',
    worktreePath: '/home/dev/src/podium/.worktrees/issue-554-host-resource-lifecycle-policy',
    childCount: 5,
    childDoneCount: 1,
    activityNotes:
      'Design is written and attached. Recommendation: treat process / worktree / branch as three resources released at three different points, ordered by how reversible each release is.',
    notesUpdatedAt: min(18),
    panel: {
      todos: [
        { text: 'Read the recommendation — the archive-vs-done decision is section 2', done: true },
        { text: 'Decide whether to file the six PRs as issues now or later', done: false },
      ],
      artifacts: [],
      deferred: [],
    },
    createdAt: min(2400),
    updatedAt: min(18),
  }),
  missionTask({
    id: asIssueId('demo-mission-readout'),
    seq: 563,
    parentId: asIssueId('demo-mission-root'),
    title: 'Host pressure readout in top bar',
    description:
      'Surface load per core and agent count in the top bar so an overloaded machine is visible before it starts failing work.',
    blocked: true,
    ready: false,
    deps: [
      { id: asIssueId('demo-mission-gc'), type: 'blocks' },
      { id: asIssueId('demo-mission-hibernate'), type: 'blocks' },
    ],
    createdAt: min(2300),
    updatedAt: min(300),
  }),
  missionTask({
    id: asIssueId('demo-mission-gc'),
    seq: 564,
    parentId: asIssueId('demo-mission-root'),
    title: 'Worktree GC janitor sweep',
    description:
      'Closed issues that were never archived keep their disk checkout forever, and sub-issues are outside the archive sweep entirely. Add a janitor that proposes reclaimable checkouts rather than removing them silently.',
    stage: 'review',
    branch: 'issue/564-worktree-gc-janitor-sweep',
    gitState: {
      updatedAt: min(18),
      branch: 'issue/564-worktree-gc-janitor-sweep',
      ahead: 1,
      dirtyFiles: 0,
      shared: false,
    },
    activityNotes:
      'Done and committed (f5cc373). The janitor finds closed issues whose checkout is still on disk — including sub-issues, which the archive sweep can never reach — and by default only PROPOSES them.',
    notesUpdatedAt: min(18),
    panel: {
      todos: [
        { text: 'worktreeGc setting: mode (off/propose/auto) + afterDays', done: true },
        { text: 'worktree-gc janitor proposes reclaimable checkouts', done: true },
        { text: 'Dirty tree refuses and is reported', done: true },
      ],
      artifacts: [],
      deferred: [],
    },
    dependents: [{ id: asIssueId('demo-mission-readout'), type: 'blocks' }],
    createdAt: min(2300),
    updatedAt: min(18),
  }),
  missionTask({
    id: asIssueId('demo-mission-unobserved'),
    seq: 565,
    parentId: asIssueId('demo-mission-root'),
    title: 'Unobserved sessions in idle policy',
    description:
      'A session nobody has observed should not count against the idle policy the same way an abandoned one does.',
    stage: 'proposed',
    createdAt: min(2300),
    updatedAt: min(2300),
  }),
  missionTask({
    id: asIssueId('demo-mission-hibernate'),
    seq: 566,
    parentId: asIssueId('demo-mission-root'),
    title: 'Load pressure hibernation trigger',
    description:
      'Hibernate sessions when the host is under sustained load per core, not only when a session has been idle long enough.',
    stage: 'review',
    branch: 'issue/566-load-pressure-hibernation-trigger',
    dependents: [{ id: asIssueId('demo-mission-readout'), type: 'blocks' }],
    createdAt: min(2300),
    updatedAt: min(64),
  }),
  missionTask({
    id: asIssueId('demo-mission-archive'),
    seq: 567,
    parentId: asIssueId('demo-mission-root'),
    title: 'Archive frees the worktree',
    description:
      'Archiving an issue should free its checkout while keeping the branch, so the disk is reclaimed without losing work.',
    stage: 'done',
    ready: false,
    createdAt: min(2300),
    updatedAt: min(140),
  }),
]

export const DEMO_ISSUES: IssueWire[] = [
  ...DEMO_MISSION,
  proposal({
    id: asIssueId('demo-proposal-retry'),
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
    id: asIssueId('demo-proposal-quota'),
    seq: 298,
    type: 'feature',
    color: 'lime',
    title: 'Quota strip on mobile Work',
    description:
      'The desktop shows per-harness quota; the phone has no way to see how much budget is left before starting more work.',
    brief:
      'Reuse the web quota viewmodel in packages/client-core/src/viewmodels; render as a two-row strip under the Work header. Mono micro type, no new colours.',
    createdAt: min(210),
    updatedAt: min(210),
  }),
  proposal({
    id: asIssueId('demo-proposal-cleanup'),
    seq: 294,
    priority: 3,
    type: 'chore',
    title: 'Retire the legacy focus helpers',
    description:
      'Two focus-ranking helpers survive from before the shared store landed and now disagree with it in edge cases.',
    brief: 'Delete groupSessionsLegacy and its tests once mobile Work reads the store ordering.',
    blockedByNotes: ['demo-issue-header'],
    dependencyNote: 'waits on the session header work',
    createdAt: min(1400),
    updatedAt: min(1400),
  }),
  {
    id: asIssueId('demo-issue-auth'),
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
    blockedByNotes: [],
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
        id: asIssueId('c1'),
        author: 'till',
        body: 'Repros on Safari with two tabs open. Backend logs show 401 storms.',
        createdAt: min(180),
      },
    ],
    panel: {
      todos: [
        { text: 'Reproduce the rotation race', done: true },
        { text: 'Add the grace-window guard', done: true },
        { text: 'Verify Safari multi-tab recovery', done: false },
      ],
      artifacts: [],
      deferred: [],
    },
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
    readAt: null,
  } as IssueWire,
  {
    id: asIssueId('demo-issue-header'),
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
    blockedByNotes: [],
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
    readAt: null,
  } as IssueWire,
  {
    id: asIssueId('demo-issue-ci'),
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
    blockedByNotes: [],
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
    readAt: null,
  } as IssueWire,
]

export const DEMO_TRANSCRIPTS: Record<string, TranscriptItem[]> = {
  'demo-auth': [
    {
      id: asIssueId('t1'),
      role: 'user',
      text: 'The OAuth refresh loop is logging users out — see POD-87. Find the race and fix it.',
      ts: min(55),
    },
    {
      id: asIssueId('t2'),
      role: 'assistant',
      text: '## Refresh race found\n\nTwo tabs refresh concurrently; the second rotation invalidates the first tab’s **brand-new token**.\n\n| Option | Security | Multi-tab |\n| --- | :---: | ---: |\n| Grace window | Strong | Safe |\n| Rotate on expiry | Weaker | Safe |\n\n> Recommendation: keep rotation and add a 30-second grace window.\n\n- Guard rotation with a shared lock\n- Record `reuse_detected` for audit\n- Re-run the [auth suite](https://example.com/auth-ci)',
      ts: min(30),
    },
    {
      id: 't2-recap',
      role: 'system',
      systemKind: 'recap',
      text: '**While you were away:** the race was reproduced in two tabs.\n\n- Added a grace-window regression test\n- Preserved token-reuse audit logging',
      ts: min(26),
    },
    {
      id: 't2-envelope',
      role: 'user',
      text: '[podium message msg_demo · from issue:POD-121 · to your session · reply: podium mail reply msg_demo]\n**Dependency cleared.** The header work is ready for review.\n[a response was requested: reply when handled]\n[end podium message msg_demo]',
      ts: min(22),
    },
    {
      id: 't2-file',
      role: 'tool',
      text: '',
      toolName: 'SendUserFile',
      toolTitle: 'Review bundle',
      toolPaths: ['reports/auth-race.md'],
      ts: min(18),
    },
    {
      id: asIssueId('t3'),
      role: 'tool',
      text: '',
      toolName: 'Bash',
      toolTitle: 'Run auth integration tests',
      toolResult: '14 passed',
      toolUseId: 'x1',
      ts: min(12),
    },
    {
      id: asIssueId('t4'),
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
    id: 'super-context',
    role: 'user',
    text: '[CONCIERGE CONTEXT]\nRepository: podium\nReady issues: POD-87, POD-121\nCurrent branch: main\nOperator preference: keep summaries concise.',
    ts: min(70),
  },
  {
    id: asIssueId('super-t1'),
    role: 'user',
    text: 'What needs my attention across my repos this morning?',
    ts: min(65),
  },
  {
    id: asIssueId('super-t2'),
    role: 'assistant',
    text: 'Three things: the OAuth bug (#87) has a question waiting for you, the payments e2e suite is being deflaked (ETA ~20m), and CI runner migration is idle-ready to merge once tests go green. I can queue the merge for you.',
    ts: min(64),
  },
]

// ---------------------------------------------------------------------------
// Pulse fixtures [POD-662]
// ---------------------------------------------------------------------------

/**
 * The three feeds the Pulse tab reads, as fixtures.
 *
 * Host metrics are here rather than on the replica because they are STREAM
 * plane: they arrive over the socket, and demo mode has no socket at all. The
 * other two are polled tRPC reads, stubbed alongside the rest of the demo
 * network in MobileClientProvider.
 */
export const DEMO_HOST_METRICS: HostMetricsWire[] = [
  {
    hostname: 'studio',
    machineId: asMachineId('demo-machine'),
    sampledAt: min(0),
    memory: {
      totalBytes: 64 * 1024 ** 3,
      availableBytes: 28 * 1024 ** 3,
      swapTotalBytes: 8 * 1024 ** 3,
      swapFreeBytes: 7 * 1024 ** 3,
    },
    load: { one: 4.8, five: 4.1, fifteen: 3.6, cpuCount: 8 },
  },
]

const quotaWindow = (
  key: string,
  label: string,
  usedPercent: number,
  resetsInMinutes: number,
  windowMinutes: number,
): QuotaWindowWire => ({
  key,
  label,
  usedPercent,
  resetsAt: new Date(Date.now() + resetsInMinutes * 60_000).toISOString(),
  windowMinutes,
})

export const DEMO_QUOTA: MachineQuotaWire[] = [
  {
    machineId: asMachineId('demo-machine'),
    machineName: 'studio',
    hostname: 'studio',
    agents: [
      {
        agent: 'codex',
        status: 'ok',
        account: { email: 'dev@example.com', plan: 'Pro' },
        windows: [quotaWindow('5h', '5-hour', 38, 199, 300)],
        fetchedAt: min(0),
      },
      {
        agent: 'claude-code',
        status: 'ok',
        account: { email: 'dev@example.com', plan: 'Max' },
        windows: [quotaWindow('weekly', 'Weekly', 19, 3_100, 10_080)],
        fetchedAt: min(0),
      },
    ],
  },
]

/**
 * A week of hourly buckets with a plausible working rhythm — heavier on
 * weekdays, a late-night Friday spike, one idle day — so the trace chart and
 * the per-day bars have a shape to read rather than a flat wall.
 */
const startOfDay = (d: Date): number => {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy.getTime()
}

export const DEMO_USAGE_BUCKETS: UsageBucketWire[] = (() => {
  const out: UsageBucketWire[] = []
  const hourMs = 3_600_000
  const top = Math.floor(Date.now() / hourMs) * hourMs
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let h = 0; h < 7 * 24; h++) {
    const at = top - h * hourMs
    const d = new Date(at)
    // Idle for one whole LOCAL day — counting back in 24h chunks from "now"
    // straddles two calendar days and leaves both of them partly active, which
    // makes the fixture's own "N active days" line disagree with its chart.
    const daysBack = Math.round((today.getTime() - startOfDay(d)) / (24 * hourMs))
    if (daysBack === 3) continue
    const hour = d.getHours()
    const active = hour >= 8 && hour <= 23 ? 1 : hour >= 0 && hour <= 2 ? 0.35 : 0
    if (active === 0) continue
    // A deterministic wobble — a fixture must render the same chart twice.
    const wobble = 0.55 + ((h * 37) % 90) / 100
    const scale = active * wobble
    const claude = Math.round(1_400 * scale)
    out.push({
      hour: new Date(at).toISOString(),
      model: 'claude-opus-4-6',
      inputTokens: claude,
      outputTokens: Math.round(claude * 0.9),
      cacheReadTokens: Math.round(claude * 46),
      cacheCreationTokens: Math.round(claude * 3.1),
      messages: Math.max(1, Math.round(9 * scale)),
    })
    out.push({
      hour: new Date(at).toISOString(),
      model: 'gpt-5.6-sol',
      inputTokens: Math.round(claude * 1.8),
      outputTokens: Math.round(claude * 1.1),
      cacheReadTokens: Math.round(claude * 61),
      cacheCreationTokens: 0,
      messages: Math.max(1, Math.round(13 * scale)),
    })
  }
  return out
})()
