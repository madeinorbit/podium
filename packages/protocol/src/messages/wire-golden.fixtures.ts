/**
 * Golden wire fixtures for the entity schemas relocated to `@podium/model`
 * (POD-300) and for the frames that carry them.
 *
 * The point is a BYTE-IDENTICAL contract across a pure move. Each fixture is
 * parsed by its schema and the parse result is `JSON.stringify`-ed into
 * `wire-golden.json`. That string pins three things at once:
 *
 *   1. every field name and value that survives a parse,
 *   2. the exact FIELD ORDER (zod emits keys in schema-shape order, so a
 *      reordered schema is a changed golden — i.e. a changed wire),
 *   3. the parse-time behaviour: `.default()`, `.catch()`, stripping of
 *      unknown keys, and refinements.
 *
 * Fixtures come in pairs where it matters: a `.full` payload with every
 * optional field populated, and a `.minimal` payload carrying only what is
 * required — the one that exercises defaults and catches.
 *
 * Regenerate deliberately, never casually:  bun --conditions @podium/source scripts/wire-golden-capture.ts
 * A golden that changes during a relocation is a STOP condition, not a fixture
 * to update (POD-300 constraints; the same baseline later proves the multi-user
 * model additions of docs/multi-user-readiness.md are purely additive).
 */

import {
  AgentInventory,
  AgentKind,
  AgentMemoryWire,
  AgentQuotaWire,
  AgentRuntimeState,
  AutomationRunWire,
  AutomationWire,
  ConversationDiagnosticWire,
  ConversationGit,
  ConversationSummaryWire,
  DirectoryEntryWire,
  DirectoryListingWire,
  Geometry,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  GitWorktreeWire,
  HandoffManifest,
  HostMemoryWire,
  HostMetricsWire,
  Inventory,
  IssueComment,
  IssueDepWire,
  IssueGitState,
  IssueGraph,
  IssuePanel,
  IssueSessionSummary,
  IssueStage,
  IssueType,
  IssueWire,
  MachineQuotaWire,
  MachineWire,
  ProjectMemoryWire,
  QuotaWindowWire,
  ResumeRef,
  SessionMeta,
  SessionOffer,
  SessionStatus,
  ToolInventory,
  TranscriptItem,
  UsageBucketWire,
} from '@podium/model'
import type { z } from 'zod'
import { ClientMessage } from './client'
import { ControlMessage } from './control'
import { DaemonMessage } from './daemon'
import { ServerMessage } from './server'

export interface WireFixture {
  /** Stable golden key. Never rename without regenerating deliberately. */
  name: string
  schema: z.ZodTypeAny
  value: unknown
}

// ---------------------------------------------------------------------------
// Building blocks reused across fixtures
// ---------------------------------------------------------------------------

const AGENT_RUNTIME_STATE_FULL = {
  phase: 'idle',
  since: '2026-07-30T10:00:00.000Z',
  workingMsTotal: 123456,
  nativeSubagentCount: 2,
  nativeSubagents: [{ id: 'sub-1', type: 'general-purpose' }, { id: 'sub-2' }],
  awaitingSubagents: true,
  idle: { kind: 'question', summary: 'waiting on an answer' },
  need: { kind: 'permission', summary: 'wants to run a command' },
  error: { class: 'rate_limit', retryable: true },
}

const AGENT_RUNTIME_STATE_MINIMAL = {
  phase: 'working',
  since: '2026-07-30T10:00:00.000Z',
  nativeSubagentCount: 0,
}

const SESSION_OFFER_FULL = {
  message: 'Login screen ready to merge',
  actions: [
    { label: 'Merge', prompt: 'merge it' },
    { label: 'Send back', prompt: 'changes: ', input: true },
  ],
  artifacts: ['docs/shot.png', 'docs/shot2.png'],
  createdAt: '2026-07-30T10:05:00.000Z',
}

const SESSION_META_FULL = {
  sessionId: 'sess-1',
  agentKind: 'claude-code',
  title: 'live terminal title',
  name: 'Curated name',
  model: 'claude-opus-5',
  effort: 'high',
  accountId: 'acct-1',
  nameSource: 'user',
  cwd: '/home/u/repo',
  status: 'live',
  exitCode: 0,
  spawnFailure: 'none',
  controllerId: 'client-1',
  geometry: { cols: 120, rows: 40 },
  epoch: 3,
  clientCount: 2,
  createdAt: '2026-07-30T09:00:00.000Z',
  lastActiveAt: '2026-07-30T10:00:00.000Z',
  lastInputAt: '2026-07-30T09:59:00.000Z',
  origin: { kind: 'resume', conversationId: 'conv-1' },
  agentState: AGENT_RUNTIME_STATE_FULL,
  archived: false,
  readAt: '2026-07-30T09:30:00.000Z',
  stoppedAt: '2026-07-30T10:10:00.000Z',
  stopReason: 'self',
  unread: true,
  workState: 'implementing',
  resumable: true,
  resume: { kind: 'claude-session', value: 'uuid-1' },
  transcriptAvailable: true,
  busy: true,
  agentColor: 'cyan',
  observedModel: 'claude-fable-5',
  observedEffort: 'medium',
  machineId: 'machine-1',
  machineName: 'ludovico',
  snoozedUntil: '2026-07-30T12:00:00.000Z',
  draftUpdatedAt: '2026-07-30T09:58:00.000Z',
  draftSyncEngine: true,
  queuedMessageCount: 2,
  offer: SESSION_OFFER_FULL,
  handoffTarget: 'machine-2',
  conversationPodiumId: 'pconv-1',
  spawnedBy: 'issue:300',
  workflowRunId: 'run-1',
  workflowStepId: 'step-1',
  executionProfileId: 'profile-1',
  issueId: '300',
  refIssueId: '300',
  refLetter: 'A',
  refDraft: 3,
  displayRef: 'POD-300-A',
  headless: false,
  viaHub: true,
  upstreamStale: true,
}

const SESSION_META_MINIMAL = {
  sessionId: 'sess-2',
  agentKind: 'shell',
  title: '',
  cwd: '/home/u',
  status: 'starting',
  controllerId: null,
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 0,
  createdAt: '2026-07-30T09:00:00.000Z',
  lastActiveAt: '2026-07-30T09:00:00.000Z',
  origin: { kind: 'spawn' },
  archived: false,
}

const ISSUE_PANEL_FULL = {
  todos: [{ text: 'move the schemas', done: true }],
  artifacts: [
    {
      path: 'docs/report.md',
      title: 'Report',
      addedAt: '2026-07-30T10:00:00.000Z',
      artifactId: 'art-1',
      entry: 'report.md',
      files: [{ path: 'report.md', size: 1024 }],
    },
  ],
  deferred: [{ text: 'de-nest sessions', addedAt: '2026-07-30T10:00:00.000Z' }],
}

const ISSUE_GIT_STATE_FULL = {
  updatedAt: '2026-07-30T10:00:00.000Z',
  computing: true,
  branch: 'issue/300',
  shared: false,
  ahead: 2,
  dirtyFiles: 5,
  dirtyOwn: 3,
  commits: ['a'.repeat(40)],
  lastCommitAt: '2026-07-30T09:55:00.000Z',
  unpushed: 1,
  merged: false,
  fallback: false,
}

const ISSUE_WIRE_FULL = {
  id: '300',
  repoPath: '/home/u/repo',
  repoId: 'repo-1',
  prefix: 'POD',
  displayRef: 'POD-300',
  seq: 300,
  title: 'Move entity schemas',
  description: 'human summary',
  brief: 'technical handoff',
  stage: 'in_progress',
  worktreePath: '/home/u/repo/.worktrees/issue-300',
  branch: 'issue/300',
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'high',
  machineId: 'machine-1',
  linearId: 'lin-1',
  linearIdentifier: 'ENG-1',
  linearUrl: 'https://linear.app/x',
  activityNotes: 'notes',
  notesUpdatedAt: '2026-07-30T10:00:00.000Z',
  suggestedStage: 'review',
  suggestedReason: 'branch merged',
  blockedBy: ['299'],
  dependencyNote: 'waiting on scaffold',
  prUrl: 'https://github.com/x/y/pull/1',
  priority: 1,
  type: 'task',
  assignee: 'agent',
  parentId: '288',
  design: 'design text',
  acceptance: 'acceptance text',
  notes: 'notes text',
  dueAt: '2026-08-01T00:00:00.000Z',
  deferUntil: 'next-message',
  closedReason: 'shipped',
  closedAt: '2026-07-30T11:00:00.000Z',
  tuckedAt: '2026-07-30T11:05:00.000Z',
  supersededBy: '301',
  duplicateOf: '302',
  pinned: true,
  sortKey: 'a0',
  color: 'violet',
  estimateMin: 90,
  needsHuman: true,
  humanQuestion: 'which grouping?',
  humanQuestionOptions: ['one file', 'per family'],
  humanQuestionAskedBy: 'sess-1',
  humanQuestionAskedAt: '2026-07-30T10:30:00.000Z',
  panel: ISSUE_PANEL_FULL,
  labels: ['rewrite'],
  deps: [{ id: '299', type: 'blocks' }],
  dependents: [{ id: '360', type: 'blocks' }],
  comments: [{ id: 'c1', author: 'agent', body: 'moved', createdAt: '2026-07-30T10:00:00.000Z' }],
  commentCount: 1,
  ready: true,
  blocked: false,
  deferred: false,
  childCount: 2,
  childDoneCount: 1,
  createdAt: '2026-07-29T09:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
  archived: false,
  deletedAt: '2026-07-30T12:00:00.000Z',
  readAt: '2026-07-30T09:30:00.000Z',
  unread: true,
  origin: 'agent',
  audience: 'human',
  draft: false,
  sessions: [SESSION_META_FULL],
  sessionSummary: { total: 2, byPhase: { idle: 1, working: 1 } },
  gitState: ISSUE_GIT_STATE_FULL,
  viaHub: true,
  upstreamStale: true,
  pendingSync: true,
  coordinatorSessionId: 'sess-1',
  startedBySession: 'sess-9',
}

const ISSUE_WIRE_MINIMAL = {
  id: '301',
  repoPath: '/home/u/repo',
  seq: 301,
  title: 'Minimal issue',
  description: '',
  stage: 'backlog',
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
  ready: true,
  blocked: false,
  deferred: false,
  childCount: 0,
  childDoneCount: 0,
  createdAt: '2026-07-29T09:00:00.000Z',
  updatedAt: '2026-07-29T09:00:00.000Z',
  archived: false,
  sessions: [],
  sessionSummary: { total: 0, byPhase: {} },
}

/** Tolerance path: a newer peer sends values this build cannot read. Every
 *  `.catch()` on IssueWire must absorb them rather than fail the whole issue. */
const ISSUE_WIRE_TOLERANT = {
  ...ISSUE_WIRE_MINIMAL,
  id: '302',
  seq: 302,
  color: 'chartreuse-from-the-future',
  tuckedAt: 42,
  humanQuestionOptions: 'not-an-array',
  readAt: 17,
  unread: 'yes',
  origin: 'martian',
  audience: 'martian',
  draft: 'sure',
  gitState: { totally: 'wrong' },
}

const CONVERSATION_SUMMARY_FULL = {
  id: 'native-1',
  path: '/home/u/.claude/projects/x/native-1.jsonl',
  podiumId: 'pconv-1',
  agentKind: 'claude-code',
  title: 'harness title',
  name: 'curated name',
  summary: 'work summary',
  projectPath: '/home/u/repo',
  parentConversationId: 'native-0',
  statusHint: 'idle',
  createdAt: '2026-07-30T09:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
  messageCount: 42,
  sizeBytes: 999,
  git: { branch: 'main', sha: 'b'.repeat(40), originUrl: 'git@github.com:x/y.git' },
  resume: { kind: 'claude-session', value: 'uuid-1' },
  providerId: 'claude-code',
}

const CONVERSATION_SUMMARY_MINIMAL = {
  id: 'native-2',
  agentKind: 'codex',
  providerId: 'codex',
}

const INVENTORY_FULL = {
  os: 'linux',
  arch: 'x64',
  podiumVersion: '0.1.0',
  agents: [
    {
      kind: 'claude-code',
      installed: true,
      version: '1.2.3',
      path: '/usr/bin/claude',
      login: { state: 'in', account: 'a@b.c' },
    },
    { kind: 'cursor', installed: false, login: { state: 'unknown' } },
  ],
  tools: [{ name: 'gh', installed: true, version: '2.0.0', path: '/usr/bin/gh' }],
}

const HOST_MEMORY_FULL = {
  totalBytes: 32_000_000_000,
  availableBytes: 8_000_000_000,
  swapTotalBytes: 2_000_000_000,
  swapFreeBytes: 1_000_000_000,
}

const AGENT_QUOTA_FULL = {
  agent: 'claude-code',
  status: 'ok',
  account: { email: 'a@b.c', plan: 'max' },
  windows: [
    {
      key: 'weekly',
      label: 'Weekly',
      usedPercent: 42.5,
      resetsAt: '2026-08-02T00:00:00.000Z',
      windowMinutes: 10080,
      scopeModel: 'claude-opus-5',
    },
    { key: 'five-hour', label: '5h', usedPercent: 0, resetsAt: '', windowMinutes: 0 },
  ],
  error: 'none',
  fetchedAt: '2026-07-30T10:00:00.000Z',
}

const GIT_REPOSITORY_FULL = {
  path: '/home/u/repo',
  kind: 'repository',
  branch: 'main',
  headSha: 'c'.repeat(40),
  originUrl: 'git@github.com:x/y.git',
  worktrees: [
    {
      path: '/home/u/repo/.worktrees/issue-300',
      branch: 'issue/300',
      headSha: 'd'.repeat(40),
      locked: false,
      prunable: false,
    },
  ],
  machineId: 'machine-1',
  repoId: 'repo-1',
}

const TRANSCRIPT_ITEM_FULL = {
  id: 'item-1',
  cursor: 'cur-1',
  role: 'assistant',
  ts: '2026-07-30T10:00:00.000Z',
  text: 'moved the schemas',
  toolName: 'Edit',
  toolInput: 'packages/model/src/entities/issue.ts',
  toolTitle: 'Relocate IssueWire',
  toolInputJson: '{"question":"which grouping?"}',
  toolResult: 'ok',
  toolUseId: 'tu-1',
  tags: [{ kind: 'file', label: 'issue.ts' }, { kind: 'image' }],
  toolPaths: ['/home/u/repo/packages/model/src/entities/issue.ts'],
  event: 'interrupt',
  answer: true,
  systemKind: 'duration',
  durationMs: 1234,
}

const TRANSCRIPT_ITEM_MINIMAL = { id: 'item-2', role: 'user', text: 'go' }

const AUTOMATION_WIRE_CRON = {
  id: 'auto-1',
  name: 'Nightly sweep',
  enabled: true,
  repoPath: '/home/u/repo',
  scheduleKind: 'cron',
  cron: '0 3 * * *',
  runAt: null,
  targetSessionId: 'sess-1',
  agentKind: 'claude-code',
  model: 'claude-opus-5',
  effort: 'high',
  prompt: 'sweep the tree',
  sessionMode: 'resume',
  nextRunAt: '2026-07-31T03:00:00.000Z',
  lastRunAt: '2026-07-30T03:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
}

const AUTOMATION_WIRE_ONCE = {
  ...AUTOMATION_WIRE_CRON,
  id: 'auto-2',
  enabled: false,
  repoPath: null,
  scheduleKind: 'once',
  cron: null,
  runAt: '2026-08-01T09:00:00.000Z',
  targetSessionId: null,
  sessionMode: 'fresh',
  nextRunAt: null,
  lastRunAt: null,
}

const HANDOFF_MANIFEST_FULL = {
  format: 1,
  sessionId: 'sess-1',
  agentKind: 'codex',
  resume: { kind: 'codex-thread', value: 'thread-1' },
  transcriptFilename: 'rollout.jsonl',
  transcriptRelativeDir: '2026/07/30',
  repoId: 'repo-1',
  branch: 'issue/300',
  headSha: 'a'.repeat(40),
  snapshotSha: 'b'.repeat(40),
  snapshotFlattened: true,
  worktreeName: 'issue-300',
  worktreeRelativePath: '.worktrees/issue-300',
  cwdSubpath: 'packages/model',
  bundleBase: ['c'.repeat(40)],
  title: 'Entity schemas into model',
  issueId: '300',
  sourceMachineId: 'machine-1',
  exportedAt: '2026-07-30T10:00:00.000Z',
}

/**
 * A `format: 2` manifest (POD-1153) — the attribution pair and the owner.
 *
 * Beside the two v1 fixtures rather than replacing them, and that is the whole
 * point: v1's two cases are the PERMANENT proof that a bundle already on disk
 * still opens, and `wire-golden.test.ts` asserts their continued presence so
 * deleting them cannot pass as a tidy-up.
 */
const HANDOFF_MANIFEST_V2 = {
  format: 2,
  sessionId: 'sess-3',
  agentKind: 'claude-code',
  resume: { kind: 'claude-session', value: 'uuid-2' },
  transcriptFilename: 'uuid-2.jsonl',
  transcriptRelativeDir: '2026/07/30',
  repoId: 'repo-1',
  branch: 'issue/1153-attribution',
  headSha: 'a'.repeat(40),
  snapshotSha: null,
  snapshotFlattened: true,
  worktreeName: 'issue-1153',
  worktreeRelativePath: '.worktrees/issue-1153',
  cwdSubpath: 'packages/model',
  bundleBase: ['c'.repeat(40)],
  title: 'Handoff manifest attribution pair',
  issueId: '1153',
  sourceMachineId: 'machine-1',
  // WHEN and WHO, inseparably: the actor is the minting AGENT and the
  // on-behalf-of (and owner) is the human it acted for — ADR 9 D5 A4.
  exported: {
    at: '2026-07-30T10:00:00.000Z',
    by: { actor: { kind: 'agent', id: 'agent-7' }, onBehalfOf: 'user-1' },
  },
  owner: 'user-1',
  visibility: 'personal',
}

const HANDOFF_MANIFEST_MINIMAL = {
  format: 1,
  sessionId: 'sess-2',
  agentKind: 'claude-code',
  resume: { kind: 'claude-session', value: 'uuid-1' },
  transcriptFilename: 'uuid-1.jsonl',
  repoId: 'repo-1',
  branch: 'issue/300',
  headSha: 'a'.repeat(40),
  snapshotSha: null,
  snapshotFlattened: true,
  worktreeName: 'issue-300',
  bundleBase: ['c'.repeat(40)],
  sourceMachineId: 'machine-1',
  exportedAt: '2026-07-30T10:00:00.000Z',
}

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

export const WIRE_FIXTURES: WireFixture[] = [
  // ---- session vocabulary + aggregate (runtime-state.ts / terminal.ts) ----
  { name: 'agentKind', schema: AgentKind, value: 'claude-code' },
  { name: 'geometry', schema: Geometry, value: { cols: 120, rows: 40 } },
  { name: 'resumeRef', schema: ResumeRef, value: { kind: 'claude-session', value: 'uuid-1' } },
  { name: 'sessionStatus', schema: SessionStatus, value: 'hibernated' },
  { name: 'agentRuntimeState.full', schema: AgentRuntimeState, value: AGENT_RUNTIME_STATE_FULL },
  {
    name: 'agentRuntimeState.minimal',
    schema: AgentRuntimeState,
    value: AGENT_RUNTIME_STATE_MINIMAL,
  },
  { name: 'sessionOffer.full', schema: SessionOffer, value: SESSION_OFFER_FULL },
  { name: 'sessionMeta.full', schema: SessionMeta, value: SESSION_META_FULL },
  { name: 'sessionMeta.minimal', schema: SessionMeta, value: SESSION_META_MINIMAL },

  // ---- issue aggregate + projections (issues.ts) ----
  { name: 'issueStage', schema: IssueStage, value: 'in_progress' },
  { name: 'issueType', schema: IssueType, value: 'epic' },
  { name: 'issueDepWire', schema: IssueDepWire, value: { id: '299', type: 'blocks' } },
  {
    name: 'issueComment',
    schema: IssueComment,
    value: { id: 'c1', author: 'agent', body: 'moved', createdAt: '2026-07-30T10:00:00.000Z' },
  },
  { name: 'issuePanel.full', schema: IssuePanel, value: ISSUE_PANEL_FULL },
  { name: 'issuePanel.minimal', schema: IssuePanel, value: {} },
  { name: 'issueGitState.full', schema: IssueGitState, value: ISSUE_GIT_STATE_FULL },
  {
    name: 'issueSessionSummary',
    schema: IssueSessionSummary,
    value: { total: 2, byPhase: { idle: 1, working: 1 } },
  },
  { name: 'issueWire.full', schema: IssueWire, value: ISSUE_WIRE_FULL },
  { name: 'issueWire.minimal', schema: IssueWire, value: ISSUE_WIRE_MINIMAL },
  { name: 'issueWire.tolerant', schema: IssueWire, value: ISSUE_WIRE_TOLERANT },
  {
    name: 'issueGraph',
    schema: IssueGraph,
    value: {
      nodes: [
        {
          id: '300',
          seq: 300,
          title: 'Move entity schemas',
          stage: 'in_progress',
          priority: 1,
          type: 'task',
          ready: true,
          blocked: false,
        },
      ],
      edges: [{ from: '300', to: '299', type: 'blocks' }],
    },
  },

  // ---- conversation projections (discovery.ts) ----
  {
    name: 'conversationGit',
    schema: ConversationGit,
    value: { branch: 'main', sha: 'b'.repeat(40), originUrl: 'git@github.com:x/y.git' },
  },
  {
    name: 'conversationSummary.full',
    schema: ConversationSummaryWire,
    value: CONVERSATION_SUMMARY_FULL,
  },
  {
    name: 'conversationSummary.minimal',
    schema: ConversationSummaryWire,
    value: CONVERSATION_SUMMARY_MINIMAL,
  },
  {
    name: 'conversationDiagnostic',
    schema: ConversationDiagnosticWire,
    value: {
      severity: 'warning',
      providerId: 'codex',
      root: '/home/u/.codex',
      path: '/home/u/.codex/x.jsonl',
      message: 'unreadable',
    },
  },

  // ---- per-machine facts (host.ts / inventory.ts / discovery.ts) ----
  {
    name: 'agentInventory',
    schema: AgentInventory,
    value: {
      kind: 'claude-code',
      installed: true,
      version: '1.2.3',
      path: '/usr/bin/claude',
      login: { state: 'in', account: 'a@b.c' },
    },
  },
  {
    name: 'toolInventory',
    schema: ToolInventory,
    value: { name: 'gh', installed: true, version: '2.0.0', path: '/usr/bin/gh' },
  },
  { name: 'inventory.full', schema: Inventory, value: INVENTORY_FULL },
  {
    name: 'inventory.minimal',
    schema: Inventory,
    value: { os: 'darwin', arch: 'arm64', agents: [] },
  },
  { name: 'hostMemory', schema: HostMemoryWire, value: HOST_MEMORY_FULL },
  {
    name: 'hostMetrics.full',
    schema: HostMetricsWire,
    value: {
      hostname: 'ludovico',
      machineId: 'machine-1',
      name: 'ludovico',
      sampledAt: '2026-07-30T10:00:00.000Z',
      memory: HOST_MEMORY_FULL,
      idleCapUnmet: 2,
    },
  },
  {
    name: 'hostMetrics.minimal',
    schema: HostMetricsWire,
    value: {
      hostname: 'ludovico',
      sampledAt: '2026-07-30T10:00:00.000Z',
      memory: HOST_MEMORY_FULL,
    },
  },
  {
    name: 'machineWire.full',
    schema: MachineWire,
    value: {
      id: 'machine-1',
      name: 'ludovico',
      hostname: 'ludovico.local',
      online: true,
      lastSeenAt: '2026-07-30T10:00:00.000Z',
      use: 'granted',
      inventory: INVENTORY_FULL,
    },
  },
  {
    name: 'machineWire.minimal',
    schema: MachineWire,
    value: {
      id: 'local',
      name: 'local',
      hostname: 'local',
      online: false,
      lastSeenAt: '2026-07-30T10:00:00.000Z',
    },
  },
  {
    name: 'agentMemory',
    schema: AgentMemoryWire,
    value: { sessionId: 'sess-1', bytes: 1024, processCount: 3 },
  },
  {
    name: 'projectMemory',
    schema: ProjectMemoryWire,
    value: {
      root: '/home/u/repo',
      bytes: 2048,
      processCount: 4,
      topProcesses: [{ name: 'node', bytes: 1024 }],
    },
  },
  {
    name: 'usageBucket',
    schema: UsageBucketWire,
    value: {
      hour: '2026-07-30T10:00:00.000Z',
      model: 'claude-opus-5',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      messages: 5,
    },
  },
  {
    name: 'quotaWindow',
    schema: QuotaWindowWire,
    value: {
      key: 'weekly',
      label: 'Weekly',
      usedPercent: 42.5,
      resetsAt: '2026-08-02T00:00:00.000Z',
      windowMinutes: 10080,
      scopeModel: 'claude-opus-5',
    },
  },
  { name: 'agentQuota.full', schema: AgentQuotaWire, value: AGENT_QUOTA_FULL },
  {
    name: 'agentQuota.minimal',
    schema: AgentQuotaWire,
    value: {
      agent: 'grok',
      status: 'unauthenticated',
      windows: [],
      fetchedAt: '2026-07-30T10:00:00.000Z',
    },
  },
  {
    name: 'machineQuota',
    schema: MachineQuotaWire,
    value: {
      machineId: 'machine-1',
      machineName: 'ludovico',
      hostname: 'ludovico.local',
      agents: [AGENT_QUOTA_FULL],
    },
  },
  {
    name: 'gitWorktree',
    schema: GitWorktreeWire,
    value: {
      path: '/home/u/repo/.worktrees/issue-300',
      branch: 'issue/300',
      headSha: 'd'.repeat(40),
      locked: false,
      prunable: true,
    },
  },
  { name: 'gitRepository.full', schema: GitRepositoryWire, value: GIT_REPOSITORY_FULL },
  {
    name: 'gitRepository.minimal',
    schema: GitRepositoryWire,
    value: { path: '/home/u/other', kind: 'bare' },
  },
  {
    name: 'gitDiscoveryDiagnostic',
    schema: GitDiscoveryDiagnosticWire,
    value: { severity: 'error', path: '/home/u/x', message: 'not a repo' },
  },
  {
    name: 'directoryEntry',
    schema: DirectoryEntryWire,
    value: { name: 'repo', path: '/home/u/repo', isRepo: true },
  },
  {
    name: 'directoryListing.full',
    schema: DirectoryListingWire,
    value: {
      path: '/home/u',
      homePath: '/home/u',
      parentPath: '/home',
      entries: [{ name: 'repo', path: '/home/u/repo', isRepo: true }],
      isRepo: false,
      originUrl: 'git@github.com:x/y.git',
    },
  },
  {
    name: 'directoryListing.minimal',
    schema: DirectoryListingWire,
    value: { path: '/', homePath: '/home/u', parentPath: null },
  },

  // ---- scheduled automations (automations.ts) ----
  { name: 'automationWire.cron', schema: AutomationWire, value: AUTOMATION_WIRE_CRON },
  { name: 'automationWire.once', schema: AutomationWire, value: AUTOMATION_WIRE_ONCE },
  {
    name: 'automationRunWire',
    schema: AutomationRunWire,
    value: {
      id: 'run-1',
      automationId: 'auto-1',
      firedAt: '2026-07-30T10:00:00.000Z',
      sessionId: 'sess-1',
      outcome: 'spawned',
      detail: null,
    },
  },

  // ---- transcript items (transcript.ts) ----
  { name: 'transcriptItem.full', schema: TranscriptItem, value: TRANSCRIPT_ITEM_FULL },
  { name: 'transcriptItem.minimal', schema: TranscriptItem, value: TRANSCRIPT_ITEM_MINIMAL },

  // ---- handoff manifest (handoff.ts) ----
  { name: 'handoffManifest.full', schema: HandoffManifest, value: HANDOFF_MANIFEST_FULL },
  { name: 'handoffManifest.minimal', schema: HandoffManifest, value: HANDOFF_MANIFEST_MINIMAL },
  { name: 'handoffManifest.v2', schema: HandoffManifest, value: HANDOFF_MANIFEST_V2 },

  // ---- frames that CARRY the relocated entities (must stay in protocol) ----
  {
    name: 'frame.sessionsChanged',
    schema: ServerMessage,
    value: { type: 'sessionsChanged', sessions: [SESSION_META_FULL, SESSION_META_MINIMAL] },
  },
  {
    name: 'frame.sessionAgentStateChanged',
    schema: ServerMessage,
    value: {
      type: 'sessionAgentStateChanged',
      sessionId: 'sess-1',
      state: AGENT_RUNTIME_STATE_FULL,
    },
  },
  {
    name: 'frame.issuesChanged',
    schema: ServerMessage,
    value: { type: 'issuesChanged', issues: [ISSUE_WIRE_FULL, ISSUE_WIRE_MINIMAL] },
  },
  {
    name: 'frame.issueUpdated',
    schema: ServerMessage,
    value: { type: 'issueUpdated', issue: ISSUE_WIRE_FULL },
  },
  {
    name: 'frame.conversationsChanged',
    schema: ServerMessage,
    value: {
      type: 'conversationsChanged',
      conversations: [CONVERSATION_SUMMARY_FULL, CONVERSATION_SUMMARY_MINIMAL],
      diagnostics: [{ severity: 'warning', message: 'skipped one root' }],
      removed: ['native-3'],
    },
  },
  {
    name: 'frame.automationsChanged',
    schema: ServerMessage,
    value: {
      type: 'automationsChanged',
      automations: [AUTOMATION_WIRE_CRON, AUTOMATION_WIRE_ONCE],
    },
  },
  {
    name: 'frame.automationRunsChanged',
    schema: ServerMessage,
    value: {
      type: 'automationRunsChanged',
      automationRuns: [
        {
          id: 'run-1',
          automationId: 'auto-1',
          firedAt: '2026-07-30T10:00:00.000Z',
          sessionId: null,
          outcome: 'skipped_overlap',
          detail: 'still running',
        },
      ],
    },
  },
  {
    name: 'frame.machinesChanged',
    schema: ServerMessage,
    value: {
      type: 'machinesChanged',
      machines: [
        {
          id: 'machine-1',
          name: 'ludovico',
          hostname: 'ludovico.local',
          online: true,
          lastSeenAt: '2026-07-30T10:00:00.000Z',
          use: 'granted',
          inventory: INVENTORY_FULL,
        },
      ],
    },
  },
  {
    name: 'frame.hostMetricsChanged',
    schema: ServerMessage,
    value: {
      type: 'hostMetricsChanged',
      hosts: [
        {
          hostname: 'ludovico',
          machineId: 'machine-1',
          name: 'ludovico',
          sampledAt: '2026-07-30T10:00:00.000Z',
          memory: HOST_MEMORY_FULL,
          idleCapUnmet: 0,
        },
      ],
    },
  },
  {
    name: 'frame.worktreesChanged',
    schema: ServerMessage,
    value: { type: 'worktreesChanged', repoPath: '/home/u/repo', machineId: 'machine-1' },
  },
  {
    name: 'frame.transcriptDelta',
    schema: ServerMessage,
    value: {
      type: 'transcriptDelta',
      sessionId: 'sess-1',
      items: [TRANSCRIPT_ITEM_FULL, TRANSCRIPT_ITEM_MINIMAL],
      tail: 'cur-2',
      reset: true,
    },
  },
  {
    name: 'frame.inventoryReport',
    schema: DaemonMessage,
    value: { type: 'inventoryReport', machineId: 'machine-1', inventory: INVENTORY_FULL },
  },
  {
    name: 'frame.hostMetrics',
    schema: DaemonMessage,
    value: {
      type: 'hostMetrics',
      hostname: 'ludovico',
      machineId: 'machine-1',
      name: 'ludovico',
      sampledAt: '2026-07-30T10:00:00.000Z',
      memory: HOST_MEMORY_FULL,
      idleCapUnmet: 1,
    },
  },
  {
    name: 'frame.memoryBreakdownResult',
    schema: DaemonMessage,
    value: {
      type: 'memoryBreakdownResult',
      requestId: 'req-1',
      hostname: 'ludovico',
      sampledAt: '2026-07-30T10:00:00.000Z',
      supported: true,
      memory: HOST_MEMORY_FULL,
      agents: [{ sessionId: 'sess-1', bytes: 1024, processCount: 3 }],
      projects: [
        {
          root: '/home/u/repo',
          bytes: 2048,
          processCount: 4,
          topProcesses: [{ name: 'node', bytes: 1024 }],
        },
      ],
      otherBytes: 512,
    },
  },
  {
    name: 'frame.usageResult',
    schema: DaemonMessage,
    value: {
      type: 'usageResult',
      requestId: 'req-2',
      hostname: 'ludovico',
      buckets: [
        {
          hour: '2026-07-30T10:00:00.000Z',
          model: 'claude-opus-5',
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
          messages: 5,
        },
      ],
    },
  },
  {
    name: 'frame.agentQuotaResult',
    schema: DaemonMessage,
    value: {
      type: 'agentQuotaResult',
      requestId: 'req-3',
      hostname: 'ludovico',
      agents: [AGENT_QUOTA_FULL],
    },
  },
  {
    name: 'frame.scanReposResult',
    schema: DaemonMessage,
    value: {
      type: 'scanReposResult',
      requestId: 'req-4',
      repositories: [GIT_REPOSITORY_FULL],
      diagnostics: [{ severity: 'warning', path: '/home/u/x', message: 'skipped' }],
    },
  },
  {
    name: 'frame.scanResult',
    schema: DaemonMessage,
    value: {
      type: 'scanResult',
      requestId: 'req-5',
      conversations: [CONVERSATION_SUMMARY_FULL],
      diagnostics: [],
      removed: [],
    },
  },
  {
    name: 'frame.browseDirsResult',
    schema: DaemonMessage,
    value: {
      type: 'browseDirsResult',
      requestId: 'req-6',
      listing: {
        path: '/home/u',
        homePath: '/home/u',
        parentPath: '/home',
        entries: [{ name: 'repo', path: '/home/u/repo', isRepo: true }],
        isRepo: false,
      },
    },
  },
  {
    name: 'frame.transcriptReadResult',
    schema: DaemonMessage,
    value: {
      type: 'transcriptReadResult',
      requestId: 'req-7',
      sessionId: 'sess-1',
      items: [TRANSCRIPT_ITEM_FULL],
      head: 'cur-1',
      tail: 'cur-1',
      hasMore: false,
    },
  },
  {
    name: 'frame.transcriptRead',
    schema: ControlMessage,
    value: {
      type: 'transcriptRead',
      requestId: 'req-8',
      sessionId: 'sess-1',
      agentKind: 'claude-code',
      cwd: '/home/u/repo',
      resume: { kind: 'claude-session', value: 'uuid-1' },
      pathHint: '/home/u/.claude/projects/x/uuid-1.jsonl',
      anchor: 'cur-1',
      direction: 'before',
      limit: 100,
    },
  },
  {
    name: 'frame.transcriptSubscribe',
    schema: ClientMessage,
    value: { type: 'transcriptSubscribe', sessionId: 'sess-1', since: 'cur-1' },
  },

  // ---- the 7 handoff frames: they STAY protocol frames (POD-300) ----
  {
    name: 'frame.handoffExportRequest',
    schema: ControlMessage,
    value: {
      type: 'handoffExportRequest',
      requestId: 'req-9',
      sessionId: 'sess-1',
      cwd: '/home/u/repo/.worktrees/issue-300',
      fallbackCwd: '/home/u/repo',
      agentKind: 'codex',
      resume: { kind: 'codex-thread', value: 'thread-1' },
      branch: 'issue/300',
      baseShas: ['c'.repeat(40)],
      repoId: 'repo-1',
      title: 'Entity schemas into model',
      issueId: '300',
      sourceMachineId: 'machine-1',
    },
  },
  {
    name: 'frame.handoffExportResult',
    schema: DaemonMessage,
    value: {
      type: 'handoffExportResult',
      requestId: 'req-9',
      ok: true,
      manifest: HANDOFF_MANIFEST_FULL,
      sizeBytes: 4096,
      stagePath: '/tmp/handoff-1.tar',
    },
  },
  {
    name: 'frame.handoffChunkReadRequest',
    schema: ControlMessage,
    value: {
      type: 'handoffChunkReadRequest',
      requestId: 'req-10',
      stagePath: '/tmp/handoff-1.tar',
      offset: 0,
      length: 65536,
    },
  },
  {
    name: 'frame.handoffChunkReadResult',
    schema: DaemonMessage,
    value: {
      type: 'handoffChunkReadResult',
      requestId: 'req-10',
      ok: true,
      data: 'AAAA',
      sizeBytes: 3,
      eof: true,
    },
  },
  {
    name: 'frame.handoffImportChunk',
    schema: ControlMessage,
    value: {
      type: 'handoffImportChunk',
      requestId: 'req-11',
      sessionId: 'sess-1',
      offset: 0,
      data: 'AAAA',
    },
  },
  {
    name: 'frame.handoffImportChunkResult',
    schema: DaemonMessage,
    value: {
      type: 'handoffImportChunkResult',
      requestId: 'req-11',
      ok: true,
      sizeBytes: 3,
    },
  },
  {
    name: 'frame.handoffImportRequest',
    schema: ControlMessage,
    value: {
      type: 'handoffImportRequest',
      requestId: 'req-12',
      sessionId: 'sess-1',
      repoPath: '/home/u/repo',
      worktreeName: 'issue-300',
      occupiedWorktreePaths: ['/home/u/repo/.worktrees/issue-299'],
    },
  },
  {
    name: 'frame.handoffImportResult',
    schema: DaemonMessage,
    value: {
      type: 'handoffImportResult',
      requestId: 'req-12',
      ok: true,
      newCwd: '/home/u/repo/.worktrees/issue-300/packages/model',
      worktreeRoot: '/home/u/repo/.worktrees/issue-300',
    },
  },
  // POD-643: the fail-closed refusal on the wire (ADR 9 D6 M5). Added, not
  // regenerated over — the `.ok` fixtures above are byte-identical, which is what
  // proves `refusal` is purely additive. These pin the encoding for POD-1079 /
  // POD-323, who populate it.
  {
    name: 'frame.handoffImportResult.refusedUnauthorized',
    schema: DaemonMessage,
    value: {
      type: 'handoffImportResult',
      requestId: 'req-13',
      ok: false,
      error: 'no `use` on the target machine',
      refusal: 'unauthorized',
    },
  },
  {
    name: 'frame.handoffImportResult.refusedUnreachable',
    schema: DaemonMessage,
    value: {
      type: 'handoffImportResult',
      requestId: 'req-14',
      ok: false,
      error: 'target machine is offline',
      refusal: 'unreachable',
    },
  },
  // All THREE arms are pinned, not two. Mutation-testing found that dropping
  // `unknown-target` — the fail-identically arm, and the one whose absence turns
  // a refusal into an existence oracle — was invisible to this corpus while only
  // the other two had fixtures. The arm that matters most for a leak is the one
  // an incomplete fixture set would have let go.
  {
    name: 'frame.handoffImportResult.refusedUnknownTarget',
    schema: DaemonMessage,
    value: {
      type: 'handoffImportResult',
      requestId: 'req-15',
      ok: false,
      error: 'no such machine',
      refusal: 'unknown-target',
    },
  },
]
