/**
 * THE SHARED RULE CORPUS (POD-7084): records and the expected answer of every
 * declared rule over them. The JavaScript evaluator is held to it in
 * `records.test.ts`; the SQL evaluator, on SQLite, in
 * `@podium/sync`'s `rule-sql.test.ts`. A new rule without a case fails both.
 *
 * Records carry only the fields the rules read, plus their ids, as wire
 * values: absent means unset. The edges are deliberate: a time exactly at the
 * cutoff, a parent cycle, a parent that is not in the corpus, an absent
 * boolean, nested agent states.
 */

import type { IssueId, SessionId, UserId } from '../ids'
import { issueUserStateRowId } from '../user-state/issue-state'
import { sessionUserStateRowId } from '../user-state/session-state'
import { pinRowId } from '../user-state/synced-records'
import type { RuleArgs } from './rule'

/** The corpus clock: every case is answered at this instant. */
export const CORPUS_NOW = Date.parse('2026-11-17T12:00:00.000Z')

const DAY = 86_400_000
const ago = (days: number): string => new Date(CORPUS_NOW - days * DAY).toISOString()

type Row = Readonly<Record<string, unknown>>

/** The corpus records, by record kind. */
export const CORPUS_RECORDS: Readonly<Record<string, readonly Row[]>> = {
  issueProjection: [
    {
      id: 'i1',
      repoId: 'r1',
      seq: 1,
      stage: 'in_progress',
      priority: 1,
      archived: false,
      audience: 'human',
      updatedAt: ago(1),
    },
    {
      id: 'i2',
      repoId: 'r1',
      seq: 2,
      parentId: 'i1',
      stage: 'done',
      archived: false,
      updatedAt: ago(20),
    },
    {
      id: 'i3',
      repoId: 'r1',
      seq: 3,
      parentId: 'i2',
      stage: 'backlog',
      archived: false,
      updatedAt: ago(8),
    },
    { id: 'i4', repoId: 'r1', seq: 4, stage: 'proposed', archived: false, updatedAt: ago(2) },
    {
      id: 'i5',
      repoId: 'r1',
      seq: 5,
      parentId: 'i4',
      stage: 'review',
      archived: true,
      updatedAt: ago(3),
    },
    {
      id: 'i6',
      repoId: 'r2',
      seq: 1,
      stage: 'planning',
      archived: false,
      deletedAt: ago(4),
      updatedAt: ago(4),
    },
    // Exactly at the 7-day cutoff: not newer than it.
    { id: 'i7', repoId: 'r2', seq: 2, stage: 'shipping', archived: false, updatedAt: ago(7) },
    {
      id: 'i8',
      repoId: 'r1',
      seq: 6,
      parentId: 'i1',
      stage: 'in_progress',
      priority: 2,
      closedReason: 'cancelled',
      archived: false,
      updatedAt: ago(30),
    },
    // A parent cycle: the walk must end.
    {
      id: 'i9',
      repoId: 'r2',
      seq: 3,
      parentId: 'i10',
      stage: 'backlog',
      archived: false,
      updatedAt: ago(10),
    },
    {
      id: 'i10',
      repoId: 'r2',
      seq: 4,
      parentId: 'i9',
      stage: 'done',
      archived: false,
      updatedAt: ago(10),
    },
    // Its parent is not in the corpus.
    {
      id: 'i11',
      repoId: 'r2',
      seq: 5,
      parentId: 'gone',
      stage: 'review',
      archived: false,
      isDraftVessel: true,
      updatedAt: ago(0.5),
    },
    {
      id: 'i12',
      repoId: 'r1',
      seq: 7,
      stage: 'done',
      closedReason: '',
      archived: false,
      updatedAt: ago(6.99),
    },
  ],
  session: [
    {
      sessionId: 's1',
      status: 'live',
      archived: false,
      issueId: 'i1',
      agentKind: 'claude',
      headless: false,
      lastActiveAt: ago(0.04),
    },
    {
      sessionId: 's2',
      status: 'starting',
      archived: false,
      agentKind: 'claude',
      lastActiveAt: ago(0.01),
    },
    {
      sessionId: 's3',
      status: 'exited',
      archived: true,
      issueId: 'i1',
      agentKind: 'claude',
      lastActiveAt: ago(30),
    },
    {
      sessionId: 's4',
      status: 'hibernated',
      archived: false,
      issueId: 'i2',
      agentKind: 'codex',
      lastActiveAt: ago(40),
      offer: { message: 'Ready to land', actions: [], createdAt: ago(40) },
    },
    {
      sessionId: 's5',
      status: 'exited',
      archived: false,
      agentKind: 'claude',
      lastActiveAt: ago(9),
      agentState: { phase: 'needs_user', since: ago(9), nativeSubagentCount: 0 },
    },
    {
      sessionId: 's6',
      status: 'live',
      archived: false,
      issueId: 'i3',
      agentKind: 'claude',
      lastActiveAt: ago(2),
      agentState: {
        phase: 'idle',
        since: ago(2),
        nativeSubagentCount: 0,
        idle: { kind: 'question' },
      },
    },
    {
      sessionId: 's7',
      status: 'live',
      archived: false,
      issueId: 'i3',
      agentKind: 'claude',
      headless: true,
      lastActiveAt: ago(7),
      agentState: { phase: 'idle', since: ago(7), nativeSubagentCount: 0, idle: { kind: 'done' } },
    },
    {
      sessionId: 's8',
      status: 'exited',
      archived: true,
      issueId: 'i1',
      agentKind: 'shell',
      lastActiveAt: ago(1),
      agentState: { phase: 'errored', since: ago(1), nativeSubagentCount: 0 },
    },
    {
      sessionId: 's9',
      status: 'exited',
      archived: true,
      agentKind: 'claude',
      lastActiveAt: ago(100),
    },
    // `headless` absent: not headless.
    {
      sessionId: 's10',
      status: 'live',
      archived: false,
      issueId: 'i1',
      agentKind: 'codex',
      lastActiveAt: ago(3),
      agentState: { phase: 'working', since: ago(3), nativeSubagentCount: 0 },
    },
    {
      sessionId: 's11',
      status: 'live',
      archived: false,
      issueId: 'i1',
      agentKind: 'shell',
      lastActiveAt: ago(3),
    },
    // No issue, not archived, finished long ago: history, not a sidebar lane.
    {
      sessionId: 's12',
      status: 'exited',
      archived: false,
      agentKind: 'claude',
      lastActiveAt: ago(40),
    },
    // No issue, finished, but active within the week.
    {
      sessionId: 's13',
      status: 'exited',
      archived: false,
      agentKind: 'claude',
      lastActiveAt: ago(2),
    },
  ],
  issueDep: [
    { id: 'd1', fromId: 'i1', toId: 'i2', type: 'blocks' },
    { id: 'd2', fromId: 'i3', toId: 'i1', type: 'blocks' },
  ],
  issueUserState: [
    { userId: 'u1', entityId: 'i1', readAt: ago(1) },
    { userId: 'u1', entityId: 'i2' },
  ],
  sessionUserState: [
    { userId: 'u1', sessionId: 's1', readAt: ago(1) },
    { userId: 'u1', sessionId: 's2' },
  ],
  issueGitState: [
    { id: 'i1', updatedAt: ago(1) },
    { id: 'i3', updatedAt: ago(2) },
  ],
  issueBrief: [
    { id: 'i1', text: 'Brief one' },
    { id: 'i2', text: 'Brief two' },
  ],
  issueDescription: [{ id: 'i1', text: 'Description one' }],
  issuePanelTodo: [
    { id: 't1', issueId: 'i1', position: 0, text: 'a', done: false },
    { id: 't2', issueId: 'i1', position: 1, text: 'b', done: true },
    { id: 't3', issueId: 'i2', position: 0, text: 'c', done: false },
  ],
  issuePanelArtifact: [{ id: 'a1', issueId: 'i2', position: 0, path: 'x.png', addedAt: ago(1) }],
  issuePanelDeferred: [{ id: 'f1', issueId: 'i1', position: 0, text: 'later', addedAt: ago(1) }],
  issuePanelState: [{ id: 'i3', text: 'Working on it', updatedAt: ago(1) }],
  pin: [
    { userId: 'u1', kind: 'issue', entityId: 'i1', pinnedAt: ago(1) },
    { userId: 'u1', kind: 'panel', entityId: 's1', pinnedAt: ago(1) },
    { userId: 'u1', kind: 'repo', entityId: 'r1', pinnedAt: ago(1) },
  ],
  conversation: [
    { id: 'c1', createdAt: ago(1) },
    { id: 'c2', createdAt: ago(10) },
    // No creation time known.
    { id: 'c3' },
  ],
  automationRun: [
    { id: 'ar1', automationId: 'a1', firedAt: ago(0.5) },
    { id: 'ar2', automationId: 'a1', firedAt: ago(8) },
  ],
  workflowRun: [
    { id: 'wr1', startedAt: ago(6) },
    { id: 'wr2', startedAt: ago(45) },
  ],
}

/** One case: a declared rule, its arguments, and the ids it must answer (in any order). */
export interface CorpusCase {
  readonly rule: string
  readonly args?: RuleArgs
  readonly expect: readonly string[]
}

const recent = { recentDays: 7 } as const
const U1 = 'u1' as UserId

export const CORPUS_CASES: readonly CorpusCase[] = [
  // Sessions
  { rule: 'session.live', expect: ['s1', 's2', 's6', 's7', 's10', 's11'] },
  { rule: 'session.asking', expect: ['s4', 's5', 's6'] },
  {
    rule: 'session.recent',
    args: recent,
    expect: ['s1', 's2', 's6', 's8', 's10', 's11', 's13'],
  },
  {
    rule: 'session.recent',
    args: { recentDays: 30 },
    expect: ['s1', 's2', 's5', 's6', 's7', 's8', 's10', 's11', 's13'],
  },
  { rule: 'session.noIssue', args: recent, expect: ['s2', 's5', 's13'] },
  { rule: 'session.noIssue', args: { recentDays: 1 }, expect: ['s2', 's5'] },
  { rule: 'session.ofIssue', args: { issueId: 'i1' }, expect: ['s1', 's3', 's8', 's10', 's11'] },
  { rule: 'session.ofIssue', args: { issueId: 'nope' }, expect: [] },
  { rule: 'session.one', args: { id: 's5' }, expect: ['s5'] },
  {
    rule: 'session > issueProjection.one if',
    expect: ['s1', 's3', 's4', 's6', 's7', 's8', 's10', 's11'],
  },
  // Issues
  { rule: 'issueProjection.sidebar', expect: ['i1', 'i3', 'i7', 'i9', 'i11'] },
  { rule: 'issueProjection.recent', args: recent, expect: ['i1', 'i4', 'i5', 'i6', 'i11', 'i12'] },
  { rule: 'issueProjection.tree', args: { root: 'i1' }, expect: ['i1', 'i2', 'i3', 'i8'] },
  { rule: 'issueProjection.tree', args: { root: 'i4' }, expect: ['i4', 'i5'] },
  { rule: 'issueProjection.tree', args: { root: 'i9' }, expect: ['i9', 'i10'] },
  { rule: 'issueProjection.tree', args: { root: 'gone' }, expect: ['i11'] },
  { rule: 'issueProjection.byStage', args: { stage: 'in_progress' }, expect: ['i1', 'i8'] },
  { rule: 'issueProjection.byStage', args: { stage: 'review' }, expect: ['i11'] },
  {
    rule: 'issueProjection.byStagePriority',
    args: { stage: 'in_progress', priority: 2 },
    expect: ['i8'],
  },
  { rule: 'issueProjection.byStagePriority', args: { stage: 'review', priority: 2 }, expect: [] },
  { rule: 'issueProjection.one', args: { id: 'i3' }, expect: ['i3'] },
  { rule: 'issueProjection.one', args: { id: 'nope' }, expect: [] },
  {
    rule: 'issueProjection > issueProjection.one if',
    expect: ['i2', 'i3', 'i5', 'i8', 'i9', 'i10', 'i11'],
  },
  // What a sidebar issue and a deck's tree issue come with
  {
    rule: 'issueProjection.sidebar > session.ofIssue',
    args: { issueId: 'i1' },
    expect: ['s1', 's10', 's11'],
  },
  {
    rule: 'issueProjection.sidebar > session.ofIssue',
    args: { issueId: 'i3' },
    expect: ['s6', 's7'],
  },
  {
    rule: 'issueProjection.tree > session.ofIssue',
    args: { issueId: 'i1' },
    expect: ['s1', 's10'],
  },
  { rule: 'issueProjection.tree > session.ofIssue', args: { issueId: 'i3' }, expect: ['s6'] },
  // What comes with an issue or a session
  { rule: 'issueDep.ofIssue', args: { issueId: 'i1' }, expect: ['d1'] },
  {
    rule: 'issueUserState.ofIssue',
    args: { issueId: 'i2' },
    expect: [issueUserStateRowId(U1, 'i2' as IssueId)],
  },
  {
    rule: 'sessionUserState.ofSession',
    args: { sessionId: 's1' },
    expect: [sessionUserStateRowId(U1, 's1' as SessionId)],
  },
  { rule: 'issueGitState.ofIssue', args: { issueId: 'i3' }, expect: ['i3'] },
  // Body records
  { rule: 'issueBrief.ofIssue', args: { issueId: 'i2' }, expect: ['i2'] },
  { rule: 'issueDescription.ofIssue', args: { issueId: 'i2' }, expect: [] },
  { rule: 'issuePanelTodo.ofIssue', args: { issueId: 'i1' }, expect: ['t1', 't2'] },
  { rule: 'issuePanelArtifact.ofIssue', args: { issueId: 'i2' }, expect: ['a1'] },
  { rule: 'issuePanelDeferred.ofIssue', args: { issueId: 'i1' }, expect: ['f1'] },
  { rule: 'issuePanelState.ofIssue', args: { issueId: 'i3' }, expect: ['i3'] },
  // Pins come with the record they point to
  { rule: 'pin > issueProjection.one if', expect: [pinRowId(U1, 'issue', 'i1')] },
  { rule: 'pin > session.one if', expect: [pinRowId(U1, 'panel', 's1')] },
  // Types that grow with history
  { rule: 'conversation.recent', args: recent, expect: ['c1'] },
  { rule: 'conversation.one', args: { id: 'c3' }, expect: ['c3'] },
  { rule: 'automationRun.recent', args: recent, expect: ['ar1'] },
  { rule: 'automationRun.one', args: { id: 'ar2' }, expect: ['ar2'] },
  { rule: 'workflowRun.recent', args: recent, expect: ['wr1'] },
  { rule: 'workflowRun.one', args: { id: 'wr2' }, expect: ['wr2'] },
]
