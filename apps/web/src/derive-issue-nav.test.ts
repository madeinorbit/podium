import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { draftIssueLabel, pickPaneSession, resolveDefaultAgent, sessionsForIssueNav } from './derive'
import { filterBoardScope } from './issues-display'

const NOW = Date.parse('2026-07-06T12:00:00.000Z')

function sess(id: string, cwd: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    cwd,
    lastActiveAt: new Date(NOW - 3_600_000).toISOString(),
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: 'some live title',
    ...over,
  } as unknown as SessionMeta
}

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'i1',
    repoPath: '/r/acme',
    seq: 1,
    title: 'Fix login',
    description: '',
    stage: 'in_progress',
    worktreePath: '/r/acme/.worktrees/issue-1',
    branch: 'issue/1',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedBy: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    needsHuman: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human' as const,
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    ...over,
  } as IssueWire
}

const WT = '/r/acme/.worktrees/issue-1'
const ROOTS = ['/r/acme', WT]

describe('sessionsForIssueNav', () => {
  it('explicit issueId wins: attached sessions are members regardless of cwd', () => {
    const sessions = [sess('a', '/somewhere/else', { issueId: 'i1' })]
    expect(sessionsForIssueNav(issue(), sessions, ROOTS).map((s) => s.sessionId)).toEqual(['a'])
  })

  it('a session attached to a DIFFERENT issue is excluded even when cwd-contained', () => {
    const sessions = [sess('a', WT, { issueId: 'other' })]
    expect(sessionsForIssueNav(issue(), sessions, ROOTS)).toEqual([])
  })

  it('cwd containment is the fallback only for sessions with NO issueId', () => {
    const sessions = [sess('a', WT), sess('b', `${WT}/packages/web`), sess('c', '/r/acme')]
    expect(
      sessionsForIssueNav(issue(), sessions, ROOTS)
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(['a', 'b'])
  })

  it('no worktree → cwd fallback contributes nothing', () => {
    const sessions = [sess('a', WT)]
    expect(sessionsForIssueNav(issue({ worktreePath: null }), sessions, ROOTS)).toEqual([])
  })

  it('excludes shells by default but includes them when opted in (tab strip)', () => {
    const sessions = [sess('sh', WT, { agentKind: 'shell' }), sess('a', WT)]
    expect(sessionsForIssueNav(issue(), sessions, ROOTS).map((s) => s.sessionId)).toEqual(['a'])
    expect(
      sessionsForIssueNav(issue(), sessions, ROOTS, { includeShells: true })
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(['a', 'sh'])
  })

  it('excludes archived and headless sessions', () => {
    const sessions = [
      sess('arch', WT, { archived: true, issueId: 'i1' }),
      sess('hl', WT, { headless: true, issueId: 'i1' }),
    ]
    expect(sessionsForIssueNav(issue(), sessions, ROOTS)).toEqual([])
  })

  it('works when the issue worktree is missing from the known roots list', () => {
    const sessions = [sess('a', `${WT}/sub`)]
    expect(sessionsForIssueNav(issue(), sessions, ['/r/acme']).map((s) => s.sessionId)).toEqual([
      'a',
    ])
  })
})

describe('draftIssueLabel', () => {
  it('uses the attached session display name (user name beats title)', () => {
    const sessions = [sess('a', WT, { issueId: 'i1', name: 'My run', title: 'live title' })]
    expect(draftIssueLabel(issue({ draft: true }), sessions, ROOTS)).toBe('My run')
  })

  it('falls back to the normalized live title', () => {
    const sessions = [sess('a', WT, { issueId: 'i1', title: '✻ Fixing the bug' })]
    expect(draftIssueLabel(issue({ draft: true }), sessions, ROOTS)).toBe('Fixing the bug')
  })

  it("falls back to 'New agent' when there is no session or no title", () => {
    expect(draftIssueLabel(issue({ draft: true }), [], ROOTS)).toBe('New agent')
    const untitled = [sess('a', WT, { issueId: 'i1', title: '' })]
    expect(draftIssueLabel(issue({ draft: true }), untitled, ROOTS)).toBe('New agent')
  })
})

describe('resolveDefaultAgent', () => {
  it('returns an explicit setting untouched', () => {
    expect(resolveDefaultAgent('codex', [])).toBe('codex')
  })

  it("resolves 'auto' to the most recently active non-shell kind", () => {
    const sessions = [
      sess('old', '/x', { agentKind: 'grok', lastActiveAt: '2026-07-01T00:00:00.000Z' }),
      sess('new', '/x', { agentKind: 'codex', lastActiveAt: '2026-07-05T00:00:00.000Z' }),
      sess('sh', '/x', { agentKind: 'shell', lastActiveAt: '2026-07-06T00:00:00.000Z' }),
    ]
    expect(resolveDefaultAgent('auto', sessions)).toBe('codex')
  })

  it('falls back to claude-code with no history', () => {
    expect(resolveDefaultAgent('auto', [])).toBe('claude-code')
    expect(resolveDefaultAgent(undefined, [])).toBe('claude-code')
  })
})

describe('filterBoardScope', () => {
  it('always drops draft issues from the board', () => {
    const list = [issue({ id: 'd', draft: true }), issue({ id: 'k' })]
    expect(filterBoardScope(list, true).map((i) => i.id)).toEqual(['k'])
    expect(filterBoardScope(list, false).map((i) => i.id)).toEqual(['k'])
  })

  it('hides agent-origin issues by default, shows them with the toggle', () => {
    const list = [issue({ id: 'h' }), issue({ id: 'a', origin: 'agent' })]
    expect(filterBoardScope(list, false).map((i) => i.id)).toEqual(['h'])
    expect(
      filterBoardScope(list, true)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['a', 'h'])
  })

  it('keeps an agent-origin CHILD whose parent is visible (rides under the epic)', () => {
    const list = [
      issue({ id: 'epic' }),
      issue({ id: 'kid', origin: 'agent', parentId: 'epic' }),
      issue({ id: 'stray', origin: 'agent' }),
      issue({ id: 'orphan', origin: 'agent', parentId: 'missing' }),
    ]
    expect(
      filterBoardScope(list, false)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['epic', 'kid'])
  })

  it('keeps a deep agent chain reachable from a human ancestor', () => {
    const list = [
      issue({ id: 'root' }),
      issue({ id: 'mid', origin: 'agent', parentId: 'root' }),
      issue({ id: 'leaf', origin: 'agent', parentId: 'mid' }),
    ]
    expect(
      filterBoardScope(list, false)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['leaf', 'mid', 'root'])
  })
})

describe('pickPaneSession (#108 — sidebar click opens a pane)', () => {
  const old = sess('old', WT, { lastActiveAt: new Date(NOW - 5 * 3_600_000).toISOString() })
  const recent = sess('recent', WT, { lastActiveAt: new Date(NOW - 3_600_000).toISOString() })

  it('keeps the current pane when it is already a member', () => {
    expect(pickPaneSession([old, recent], 'old')).toBe('old')
  })

  it('keeps the current pane when it is a row file tab (extraValidIds)', () => {
    expect(pickPaneSession([old, recent], 'file:x', ['file:x'])).toBe('file:x')
  })

  it('opens the most recently active member when the pane is foreign or empty', () => {
    expect(pickPaneSession([old, recent], 'elsewhere')).toBe('recent')
    expect(pickPaneSession([old, recent], null)).toBe('recent')
    expect(pickPaneSession([old], null)).toBe('old')
  })

  it('returns null for an empty row (clear to the picker)', () => {
    expect(pickPaneSession([], 'elsewhere')).toBeNull()
    expect(pickPaneSession([], null)).toBeNull()
  })
})
