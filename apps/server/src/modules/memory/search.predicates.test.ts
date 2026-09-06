import { asIssueId, asMachineId, asSessionId, asUserId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IssueRow, SessionRow, SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { MemorySearchService } from './search'
import { MemoryVisibilityPolicy } from './visibility'

const READER = { kind: 'user' as const, id: asUserId('reader') }
const issue = (): IssueRow => ({
  id: asIssueId('iss_2'),
  repoPath: '/repo',
  repoId: null,
  seq: 1,
  title: 'bare',
  description: '',
  brief: null,
  stage: 'backlog',
  worktreePath: null,
  branch: null,
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  machineId: null,
  linearId: null,
  linearIdentifier: null,
  linearUrl: null,
  activityNotes: null,
  notesUpdatedAt: null,
  suggestedStage: null,
  suggestedReason: null,
  blockedBy: [],
  dependencyNote: null,
  prUrl: null,
  createdAt: 't0',
  updatedAt: 't0',
  archived: false,
  deletedAt: null,
  priority: 2,
  type: 'task',
  assignee: null,
  parentId: null,
  design: null,
  acceptance: null,
  notes: null,
  dueAt: null,
  deferUntil: null,
  closedReason: null,
  closedAt: null,
  supersededBy: null,
  duplicateOf: null,
  sortKey: null,
  color: null,
  estimateMin: null,
  needsHuman: false,
  humanQuestion: null,
  humanQuestionOptions: null,
  humanQuestionAskedBy: null,
  humanQuestionAskedAt: null,
  panel: null,
  origin: 'human',
  audience: 'human',
  draft: false,
  coordinatorSessionId: null,
  startedBySession: null,
})
const session = (id: string, resumeValue: string): SessionRow => ({
  id: asSessionId(id),
  ownerUserId: READER.id,
  agentKind: 'claude-code',
  cwd: '/home/u/repo',
  title: 'a session',
  name: null,
  nameSource: null,
  originKind: 'resume',
  conversationId: null,
  resumeKind: resumeValue === null ? null : 'conversation',
  resumeValue,
  status: 'live',
  exitCode: null,
  spawnFailure: null,
  durableLabel: `label-${id}`,
  createdAt: '2026-01-01T00:00:00Z',
  lastActiveAt: '2026-01-01T00:00:00Z',
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: asMachineId('machine-1'),
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
})

const stores: SessionStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})
async function build() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const visibility = new MemoryVisibilityPolicy(store)
  vi.spyOn(visibility, 'forRequest').mockResolvedValue(visibility)
  vi.spyOn(visibility, 'mayRead').mockImplementation(async (_reader, ref) =>
    'id' in ref ? ref.id === 'allowed' : 'nativeId' in ref && ref.nativeId === 'allowed',
  )
  vi.spyOn(store.sessions, 'loadSessions').mockResolvedValue([])
  vi.spyOn(store.issues, 'listIssueRows').mockResolvedValue([])
  vi.spyOn(store.issues, 'searchIssueComments').mockResolvedValue([])
  vi.spyOn(store.superagent, 'listSuperagentThreads').mockResolvedValue([])
  vi.spyOn(store.conversations.index, 'searchCandidates').mockResolvedValue([])
  vi.spyOn(store.conversations.transcriptIndex, 'searchCandidates').mockResolvedValue([])
  return { store, visibility, search: new MemorySearchService(store, visibility) }
}

describe('async predicate regression: memory selection', () => {
  it('filters unreadable conversations before applying the limit', async () => {
    const { store, search } = await build()
    vi.mocked(store.conversations.index.searchCandidates).mockResolvedValue(
      ['denied', 'allowed'].map((id) => ({
        id,
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        machineId: asMachineId('machine-1'),
      })),
    )
    expect((await search.searchConversations(READER, { limit: 1 })).map((row) => row.id)).toEqual([
      'allowed',
    ])
  })

  it('excludes denied and deleted issues from search results', async () => {
    const { store, search } = await build()
    vi.mocked(store.issues.listIssueRows).mockResolvedValue([
      { ...issue(), id: asIssueId('denied'), title: 'needle private' },
      { ...issue(), id: asIssueId('allowed'), title: 'needle visible' },
      { ...issue(), id: asIssueId('deleted'), title: 'needle deleted', deletedAt: 't1' },
    ])
    expect((await search.search(READER, { text: 'needle' })).map((hit) => hit.id)).toEqual([
      'allowed',
    ])
  })

  it('never links a transcript to the first unrelated or unreadable session', async () => {
    const { store, search } = await build()
    vi.mocked(store.sessions.loadSessions).mockResolvedValue([
      session('unrelated', 'foreign'),
      session('denied', 'allowed'),
      session('allowed', 'allowed'),
    ])
    vi.mocked(store.conversations.transcriptIndex.searchCandidates).mockResolvedValue([
      {
        machineId: asMachineId('machine-1'),
        nativeId: 'allowed',
        rank: -1,
        snippet: 'needle',
      },
    ])
    const hits = await search.search(READER, { text: 'needle' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe('allowed')
  })
})
