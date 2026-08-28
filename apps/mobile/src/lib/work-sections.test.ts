import type {
  IssueNavigationModel,
  UnifiedIssueRow,
  UnifiedWorkGroup,
  UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import type { IssueWireInput, SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  buildWorkSections,
  foldWorkSections,
  workGroupFoldKey,
  workRowListKey,
} from './work-sections'

/**
 * What this file guards is BANDING: which section of the Work tab a row lands
 * in, in what section order, and what a fold may and may not hide. Whether a
 * row is "waiting" is `rowWaitingCount`'s call and is tested where it lives
 * (client-core row-attention); the fixtures here make a row wait the real way
 * — a session blocked on the human — so the banding is exercised through the
 * genuine predicate rather than a stand-in.
 */
function issue(over: Partial<IssueWireInput> = {}): IssueNavigationModel {
  return {
    id: 'i',
    repoPath: '/r',
    seq: 1,
    title: 't',
    description: '',
    stage: 'in_progress',
    priority: 2,
    type: 'task',
    audience: 'human',
    origin: 'human',
    draft: false,
    archived: false,
    labels: [],
    deps: [],
    dependents: [],
    blockedByNotes: [],
    ready: true,
    blocked: false,
    deferred: false,
    pinned: false,
    needsHuman: false,
    unread: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as unknown as IssueNavigationModel
}

/** An agent blocked on the human — the state that makes a row an ask. */
const waitingSession = (id: string): SessionMeta =>
  ({
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    status: 'live',
    archived: false,
    cwd: '/r',
    lastActiveAt: '2026-08-27T00:00:00.000Z',
    agentState: { phase: 'needs_user', since: '2026-08-27T00:00:00.000Z' },
  }) as SessionMeta

function row(id: string, over: { pinned?: boolean; waiting?: boolean } = {}): UnifiedIssueRow {
  return {
    kind: 'issue',
    issue: issue({ id, pinned: over.pinned ?? false }),
    sessions: over.waiting ? [waitingSession(`${id}-s`)] : [],
    activityAt: 0,
  }
}

function group(
  key: string,
  rows: UnifiedWorkRow[],
  over: Partial<UnifiedWorkGroup> = {},
): UnifiedWorkGroup {
  return { key, label: key, rows, snoozedRows: [], closedRows: [], ...over }
}

const bandKeys = (split: ReturnType<typeof buildWorkSections>) => split.sections.map((s) => s.key)
const ids = (rows: UnifiedWorkRow[] = []) =>
  rows.map((r) => (r.kind === 'issue' ? r.issue.id : r.worktree.path))

describe('buildWorkSections', () => {
  it('puts Pinned first, above Needs you, above the project bands', () => {
    const split = buildWorkSections(
      [row('pin', { pinned: true })],
      [group('repo', [row('ask', { waiting: true }), row('calm')])],
    )
    expect(bandKeys(split)).toEqual(['pinned', 'needs-you', 'repo'])
    expect(ids(split.sections[0]?.data)).toEqual(['pin'])
    expect(ids(split.sections[1]?.data)).toEqual(['ask'])
    expect(ids(split.sections[2]?.data)).toEqual(['calm'])
  })

  it('shows a waiting pinned row in BOTH Pinned and Needs you, pinned asks first', () => {
    const split = buildWorkSections(
      [row('pin-ask', { pinned: true, waiting: true })],
      [group('repo', [row('ask', { waiting: true })])],
    )
    // It never leaves Pinned…
    expect(ids(split.sections.find((s) => s.key === 'pinned')?.data)).toEqual(['pin-ask'])
    // …and it ALSO answers "where am I needed", ahead of the group asks.
    expect(ids(split.sections.find((s) => s.key === 'needs-you')?.data)).toEqual(['pin-ask', 'ask'])
    // The subtitle's count still owns every ask ONCE, wherever it is banded.
    expect(split.attentionCount).toBe(2)
  })

  it('gives the duplicated pinned ask a distinct list key per band', () => {
    const split = buildWorkSections(
      [row('pin-ask', { pinned: true, waiting: true })],
      [group('repo', [row('ask', { waiting: true })])],
    )
    const keys = split.sections.flatMap((s) => s.data.map(workRowListKey))
    // SectionList flattens its sections, so the WHOLE list must be key-unique.
    expect(new Set(keys).size).toBe(keys.length)
    // The Pinned copy keeps the canonical id; the Needs-you copy is the marked one.
    expect(keys).toContain('pin-ask')
    expect(keys).toContain('needs-you:pin-ask')
  })

  it('keeps a calm pinned row out of Needs you', () => {
    const split = buildWorkSections(
      [row('pin', { pinned: true })],
      [group('repo', [row('ask', { waiting: true })])],
    )
    expect(ids(split.sections.find((s) => s.key === 'needs-you')?.data)).toEqual(['ask'])
  })

  it('lifts asks out of their project band without duplicating them', () => {
    const split = buildWorkSections(
      [],
      [group('repo', [row('a'), row('ask', { waiting: true }), row('b')])],
    )
    expect(bandKeys(split)).toEqual(['needs-you', 'repo'])
    expect(ids(split.sections[1]?.data)).toEqual(['a', 'b'])
    const everywhere = split.sections.flatMap((s) => ids(s.data))
    expect(everywhere.filter((id) => id === 'ask')).toHaveLength(1)
  })

  it('drops the empty bands but keeps a band that is only folds', () => {
    const closed = row('done')
    const split = buildWorkSections(
      [],
      [group('empty', []), group('folded', [], { closedRows: [closed] })],
    )
    expect(bandKeys(split)).toEqual(['folded'])
    expect(split.sections[0]?.data).toEqual([])
    expect(split.sections[0]?.closedRows).toEqual([closed])
  })

  it('scopes reordering to pinned and the FULL project groups, never Needs you', () => {
    const split = buildWorkSections(
      [row('pin', { pinned: true })],
      [group('repo', [row('ask', { waiting: true }), row('calm')])],
    )
    expect(split.orderingSections.map((s) => s.key)).toEqual(['pinned', 'repo'])
    // The ordering copy of the project keeps the lifted ask: sortKey patches
    // only mean anything against the scope's complete row set [POD-168].
    expect(ids(split.orderingSections[1]?.data)).toEqual(['ask', 'calm'])
  })

  it('counts issues, pinned rows and asks over the whole open set', () => {
    const split = buildWorkSections(
      [row('pin', { pinned: true, waiting: true })],
      [group('repo', [row('ask', { waiting: true }), row('calm')])],
    )
    expect(split.issueCount).toBe(3)
    expect(split.pinnedCount).toBe(1)
    expect(split.attentionCount).toBe(2)
    // The band header's count survives folding via `total`. Needs-you counts
    // the pinned ask's second rendering: the header states what the band shows.
    expect(split.sections.map((s) => [s.key, s.total])).toEqual([
      ['pinned', 1],
      ['needs-you', 2],
      ['repo', 1],
    ])
  })
})

describe('foldWorkSections', () => {
  const split = buildWorkSections(
    [row('pin', { pinned: true })],
    [
      group('repo', [row('ask', { waiting: true }), row('calm')], {
        closedRows: [row('done')],
      }),
    ],
  )

  it('empties a collapsed band — rows AND its Snoozed/Closed folds — but keeps the count', () => {
    const folded = foldWorkSections(split.sections, new Set(['repo']), false)
    const repo = folded.find((s) => s.key === 'repo')
    expect(repo?.data).toEqual([])
    expect(repo?.closedRows).toEqual([])
    expect(repo?.total).toBe(1)
    // Untouched bands keep their rows.
    expect(ids(folded.find((s) => s.key === 'needs-you')?.data)).toEqual(['ask'])
  })

  it('ignores every fold while a search is active, so a match can never hide', () => {
    const folded = foldWorkSections(split.sections, new Set(['repo', 'pinned']), true)
    expect(ids(folded.find((s) => s.key === 'repo')?.data)).toEqual(['calm'])
    expect(ids(folded.find((s) => s.key === 'pinned')?.data)).toEqual(['pin'])
  })
})

describe('workGroupFoldKey', () => {
  it('stays inside the replicated podium:sidebar: namespace — an invented one throws in ui-state', () => {
    expect(workGroupFoldKey('needs-you')).toBe('podium:sidebar:work-group-fold:needs-you')
  })
})
