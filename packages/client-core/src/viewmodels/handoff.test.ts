import {
  asIssueId,
  asSessionId,
  type IssueEventWire,
  type SessionMeta,
  type TranscriptItem,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  deriveHandoffNext,
  deriveHandoffNow,
  pairLatestPromptAndAnswer,
  reviewReturnCount,
  selectLatestPromptSession,
} from './handoff'
import { parseEnvelopeBatch } from './message-envelope'
import type { IssueNavigationModel } from './slices/issues'

const issue = (id: string, over: Partial<IssueNavigationModel> = {}): IssueNavigationModel =>
  ({
    id: asIssueId(id),
    seq: Number(id.replace(/\D/g, '')) || 1,
    displayRef: `POD-${Number(id.replace(/\D/g, '')) || 1}`,
    title: id,
    stage: 'backlog',
    ready: true,
    blocked: false,
    archived: false,
    deletedAt: null,
    deps: [],
    dependents: [],
    childCount: 0,
    childDoneCount: 0,
    memberSessionIds: [],
    ...over,
  }) as IssueNavigationModel

const session = (id: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    sessionId: asSessionId(id),
    agentKind: 'codex',
    title: id,
    cwd: '/repo',
    status: 'live',
    archived: false,
    lastActiveAt: '2026-09-01T10:00:00.000Z',
    createdAt: '2026-09-01T09:00:00.000Z',
    transcriptAvailable: true,
    ...over,
  }) as SessionMeta

const item = (id: string, over: Partial<TranscriptItem> = {}): TranscriptItem => ({
  id,
  role: 'assistant',
  text: id,
  ...over,
})

describe('Handoff transcript context', () => {
  it('selects the newest transcript-capable session with operator input', () => {
    expect(
      selectLatestPromptSession([
        session('older', { lastInputAt: '2026-09-01T09:00:00.000Z' }),
        session('shell', { agentKind: 'shell', lastInputAt: '2026-09-01T12:00:00.000Z' }),
        session('newer', { lastInputAt: '2026-09-01T11:00:00.000Z' }),
      ])?.sessionId,
    ).toBe('newer')
  })

  it('ignores machine context and interrupts, and pairs only the latest turn', () => {
    const mail =
      '[podium message msg_1 · from issue:POD-1 · to your session · reply: podium mail reply msg_1]\ninternal\n[end podium message msg_1]'
    const pair = pairLatestPromptAndAnswer(
      asSessionId('s1'),
      [
        item('machine', { role: 'user', text: '<superagent-context>seed</superagent-context>' }),
        item('old-prompt', { role: 'user', text: 'old' }),
        item('old-answer', { answer: true }),
        item('interrupt', { role: 'user', event: 'interrupt', text: 'stop' }),
        item('prompt', {
          role: 'user',
          cursor: 'prompt-cursor',
          text: `${mail}latest`,
        }),
        item('narration', { text: 'working' }),
        item('answer', { cursor: 'answer-cursor', answer: true, text: 'done' }),
      ],
      {
        collapseMachineContext: true,
        operatorTextOf: (text) => parseEnvelopeBatch(text)?.operatorText,
      },
    )
    expect(pair?.prompt.anchor.itemKey).toBe('prompt-cursor')
    expect(pair?.prompt.item.text).toBe('latest')
    expect(pair?.answer?.anchor.itemKey).toBe('answer-cursor')
    expect(pair?.answer?.legacy).toBe(false)
  })

  it('uses latest assistant prose only when the transcript has no answer markers', () => {
    const pair = pairLatestPromptAndAnswer(
      asSessionId('s1'),
      [
        item('prompt', { role: 'user', text: 'question' }),
        item('reply-1', { text: 'first' }),
        item('reply-2', { text: 'latest' }),
      ],
      { collapseMachineContext: false },
    )
    expect(pair?.answer?.item.id).toBe('reply-2')
    expect(pair?.answer?.legacy).toBe(true)
  })
})

describe('Handoff mission derivations', () => {
  it('keeps proposed work out of current and next', () => {
    const issues = [
      issue('root', { stage: 'in_progress' }),
      issue('p2', { parentId: asIssueId('root'), stage: 'proposed' }),
    ]
    expect(deriveHandoffNow(issues, [], 'root').some((entry) => entry.issueId === 'p2')).toBe(false)
    expect(deriveHandoffNext(issues, [], 'root').some((entry) => entry.issueId === 'p2')).toBe(
      false,
    )
  })

  it('orders working, review, blocked, stalled, then needs-you', () => {
    const issues = [
      issue('root', { stage: 'backlog' }),
      issue('i1', {
        parentId: asIssueId('root'),
        stage: 'in_progress',
        memberSessionIds: [asSessionId('s1')],
      }),
      issue('i2', { parentId: asIssueId('root'), stage: 'review' }),
      issue('i3', { parentId: asIssueId('root'), stage: 'in_progress', blocked: true }),
      issue('i4', { parentId: asIssueId('root'), stage: 'in_progress' }),
      issue('i5', { parentId: asIssueId('root'), stage: 'in_progress', needsHuman: true }),
    ]
    const rows = deriveHandoffNow(
      issues,
      [
        session('s1', {
          issueId: asIssueId('i1'),
          agentState: { phase: 'working' } as SessionMeta['agentState'],
        }),
      ],
      'root',
    )
    expect(rows.map((row) => row.kind)).toEqual([
      'working',
      'review',
      'blocked',
      'stalled',
      'needs-you',
    ])
  })

  it('makes a session waiting state one needs-you row', () => {
    const issues = [
      issue('root'),
      issue('i1', {
        parentId: asIssueId('root'),
        stage: 'in_progress',
        memberSessionIds: [asSessionId('s1')],
      }),
    ]
    const rows = deriveHandoffNow(
      issues,
      [
        session('s1', {
          issueId: asIssueId('i1'),
          agentState: { phase: 'needs_user' } as SessionMeta['agentState'],
        }),
      ],
      'root',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('needs-you')
  })

  it('uses formal blockers and waits for the last open child before resuming a parent', () => {
    const issues = [
      issue('root', { stage: 'in_progress' }),
      issue('i2', { parentId: asIssueId('root'), stage: 'in_progress' }),
      issue('i3', {
        parentId: asIssueId('root'),
        stage: 'backlog',
        blocked: true,
        ready: false,
        deps: [{ id: asIssueId('i2'), type: 'blocks' }],
      }),
    ]
    const next = deriveHandoffNext(issues, [], 'root')
    expect(next.find((entry) => entry.issueId === 'i3')?.text).toBe(
      'After POD-2 closes, resume POD-3.',
    )
    expect(next.find((entry) => entry.issueId === 'root')?.text).toBeUndefined()

    const oneChild = [
      issues[0] as IssueNavigationModel,
      { ...(issues[1] as IssueNavigationModel), closedReason: 'done' },
      issues[2] as IssueNavigationModel,
    ]
    expect(
      deriveHandoffNext(oneChild, [], 'root').find((entry) => entry.issueId === 'root')?.text,
    ).toBe('After POD-3 closes, resume POD-1.')
  })
})

describe('review return count', () => {
  it('counts only returns from review to an active stage', () => {
    const event = (kind: string, payload: unknown): IssueEventWire =>
      ({
        id: crypto.randomUUID(),
        eventId: Math.ceil(Math.random() * 1000),
        ts: 't',
        kind,
        subject: 'i1',
        repoPath: null,
        payload,
      }) as IssueEventWire
    expect(
      reviewReturnCount([
        event('issue.stage_changed', { from: 'review', to: 'in_progress' }),
        event('issue.stage_changed', { from: 'review', to: 'planning' }),
        event('issue.stage_changed', { from: 'backlog', to: 'in_progress' }),
        event('issue.comment', { from: 'review', to: 'in_progress' }),
      ]),
    ).toBe(2)
  })
})
