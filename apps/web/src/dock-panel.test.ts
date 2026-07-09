import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  artifactKind,
  basename,
  cwdInWorktree,
  issueForCwd,
  issueForPanel,
  panelNonEmpty,
  readStoredDockTab,
  resolveActiveWorktree,
  subissuesWithPanels,
  worktreeAssetUrl,
} from './dock-panel'
import type { FileTab } from './store'

function sess(id: string, cwd: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    cwd,
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    machineId: undefined,
    archived: false,
    ...over,
  } as unknown as SessionMeta
}

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'i1',
    seq: 7,
    title: 'Fix login',
    worktreePath: '/repo/.worktrees/issue-7',
    panel: undefined,
    ...over,
  } as unknown as IssueWire
}

describe('readStoredDockTab', () => {
  it('accepts the four tabs and falls back to superagent', () => {
    expect(readStoredDockTab('files')).toBe('files')
    expect(readStoredDockTab('git')).toBe('git')
    expect(readStoredDockTab('issue')).toBe('issue')
    expect(readStoredDockTab('superagent')).toBe('superagent')
    expect(readStoredDockTab(null)).toBe('superagent')
    expect(readStoredDockTab('junk')).toBe('superagent')
  })
})

describe('resolveActiveWorktree', () => {
  const s1 = sess('s1', '/wt/a', { machineId: 'm1' })
  const s2 = sess('s2', '/wt/b', { lastActiveAt: '2026-07-02T00:00:00.000Z' })

  it('uses paneA session cwd', () => {
    expect(resolveActiveWorktree({ paneA: 's1', fileTabs: [], sessions: [s1, s2] })).toEqual({
      cwd: '/wt/a',
      machineId: 'm1',
      sessionId: 's1',
    })
  })

  it('uses a file tab worktreePath when paneA is a file tab', () => {
    const tab: FileTab = {
      id: 'file:x:/wt/c/readme.md',
      scope: { kind: 'worktree', machineId: 'm2', root: '/wt/c' },
      path: '/wt/c/readme.md',
      worktreePath: '/wt/c',
    }
    expect(
      resolveActiveWorktree({ paneA: tab.id, fileTabs: [tab], sessions: [s1] }),
    ).toEqual({ cwd: '/wt/c', machineId: 'm2', sessionId: undefined })
  })

  it('falls back to the most recently active session', () => {
    expect(resolveActiveWorktree({ paneA: null, fileTabs: [], sessions: [s1, s2] })).toEqual({
      cwd: '/wt/b',
      machineId: undefined,
      sessionId: 's2',
    })
  })

  it('skips archived sessions in the fallback and returns null when empty', () => {
    const archived = sess('s3', '/wt/z', {
      archived: true,
      lastActiveAt: '2026-07-09T00:00:00.000Z',
    })
    expect(
      resolveActiveWorktree({ paneA: null, fileTabs: [], sessions: [archived, s1] })?.cwd,
    ).toBe('/wt/a')
    expect(resolveActiveWorktree({ paneA: null, fileTabs: [], sessions: [] })).toBeNull()
  })
})

describe('issueForCwd', () => {
  const i = issue()
  it('matches exact and contained cwds only', () => {
    expect(issueForCwd([i], '/repo/.worktrees/issue-7')?.id).toBe('i1')
    expect(issueForCwd([i], '/repo/.worktrees/issue-7/sub/dir')?.id).toBe('i1')
    expect(issueForCwd([i], '/repo/.worktrees/issue-70')).toBeNull()
    expect(issueForCwd([issue({ worktreePath: null })], '/anywhere')).toBeNull()
  })

  it('is deterministic: deepest worktree wins, archived never match, seq breaks ties', () => {
    const root = issue({ id: 'root', seq: 1, worktreePath: '/repo' })
    const nested = issue({ id: 'nested', seq: 9, worktreePath: '/repo/.worktrees/issue-7' })
    // Deepest containing path wins regardless of array order.
    expect(issueForCwd([root, nested], '/repo/.worktrees/issue-7/src')?.id).toBe('nested')
    expect(issueForCwd([nested, root], '/repo/.worktrees/issue-7/src')?.id).toBe('nested')
    // Archived issues never own a cwd.
    const archived = issue({ id: 'a', worktreePath: '/repo/.worktrees/issue-7', archived: true })
    expect(issueForCwd([archived, root], '/repo/.worktrees/issue-7')?.id).toBe('root')
    // Equal-depth tie → lowest seq, in either order.
    const twinA = issue({ id: 'tA', seq: 3, worktreePath: '/wt/x' })
    const twinB = issue({ id: 'tB', seq: 5, worktreePath: '/wt/x' })
    expect(issueForCwd([twinB, twinA], '/wt/x')?.id).toBe('tA')
    expect(issueForCwd([twinA, twinB], '/wt/x')?.id).toBe('tA')
  })
})

describe('issueForPanel', () => {
  const owning = issue() // worktreePath /repo/.worktrees/issue-7
  const attached = issue({ id: 'i2', worktreePath: null })

  it('explicit session attachment beats the owning worktree (#243)', () => {
    // A session attached to a subissue but working in the parent's worktree
    // shows ITS issue, not the worktree owner.
    const s = sess('s1', '/repo/.worktrees/issue-7', { issueId: 'i2' })
    expect(
      issueForPanel({
        issues: [owning, attached],
        sessions: [s],
        cwd: '/repo/.worktrees/issue-7',
        sessionId: 's1',
      })?.id,
    ).toBe('i2')
  })

  it('unattached session in an owned worktree falls back to containment', () => {
    const s = sess('s1', '/repo/.worktrees/issue-7')
    expect(
      issueForPanel({
        issues: [owning, attached],
        sessions: [s],
        cwd: '/repo/.worktrees/issue-7',
        sessionId: 's1',
      })?.id,
    ).toBe('i1')
  })

  it('attachment to an archived issue falls through to containment', () => {
    const archivedTarget = issue({ id: 'i3', worktreePath: null, archived: true })
    const s = sess('s1', '/repo/.worktrees/issue-7', { issueId: 'i3' })
    expect(
      issueForPanel({
        issues: [owning, archivedTarget],
        sessions: [s],
        cwd: '/repo/.worktrees/issue-7',
        sessionId: 's1',
      })?.id,
    ).toBe('i1')
  })

  it('falls back to the active session explicit issue attachment', () => {
    const s = sess('s1', '/elsewhere/wt', { issueId: 'i2' })
    expect(
      issueForPanel({
        issues: [owning, attached],
        sessions: [s],
        cwd: '/elsewhere/wt',
        sessionId: 's1',
      })?.id,
    ).toBe('i2')
  })

  it('ignores archived attached issues and misses cleanly', () => {
    const s = sess('s1', '/elsewhere/wt', { issueId: 'i2' })
    const archived = issue({ id: 'i2', worktreePath: null, archived: true })
    expect(
      issueForPanel({ issues: [archived], sessions: [s], cwd: '/elsewhere/wt', sessionId: 's1' }),
    ).toBeNull()
    // No sessionId (file-tab resolution) → cwd-only behavior.
    expect(
      issueForPanel({ issues: [owning, attached], sessions: [s], cwd: '/elsewhere/wt' }),
    ).toBeNull()
    // Session without issueId → null.
    expect(
      issueForPanel({
        issues: [owning, attached],
        sessions: [sess('s2', '/elsewhere/wt')],
        cwd: '/elsewhere/wt',
        sessionId: 's2',
      }),
    ).toBeNull()
  })
})

describe('panel helpers', () => {
  it('panelNonEmpty and subissuesWithPanels', () => {
    const parent = issue()
    const subEmpty = issue({ id: 's-empty', parentId: 'i1', panel: { todos: [], artifacts: [], deferred: [] } })
    const subFull = issue({
      id: 's-full',
      parentId: 'i1',
      panel: { todos: [{ text: 'x', done: false }], artifacts: [], deferred: [] },
    })
    expect(panelNonEmpty(subEmpty)).toBe(false)
    expect(panelNonEmpty(subFull)).toBe(true)
    expect(subissuesWithPanels([parent, subEmpty, subFull], 'i1').map((s) => s.id)).toEqual([
      's-full',
    ])
  })
})

describe('artifact helpers', () => {
  it('classifies by extension', () => {
    expect(artifactKind('shot.PNG')).toBe('image')
    expect(artifactKind('demo.webm')).toBe('video')
    expect(artifactKind('notes.md')).toBe('file')
  })
  it('basename', () => {
    expect(basename('/a/b/c.md')).toBe('c.md')
    expect(basename('c.md')).toBe('c.md')
  })
  it('worktreeAssetUrl encodes and includes machineId when known', () => {
    expect(
      worktreeAssetUrl({ httpOrigin: 'http://x/', root: '/wt a', path: 'img 1.png', machineId: 'm1' }),
    ).toBe('http://x/files/asset?root=%2Fwt+a&path=img+1.png&machineId=m1')
    expect(worktreeAssetUrl({ httpOrigin: 'http://x', root: '/w', path: 'p.png' })).not.toContain(
      'machineId',
    )
  })
})

describe('cwdInWorktree', () => {
  it('containment', () => {
    expect(cwdInWorktree('/a/b', '/a/b')).toBe(true)
    expect(cwdInWorktree('/a/b/c', '/a/b')).toBe(true)
    expect(cwdInWorktree('/a/bc', '/a/b')).toBe(false)
  })
})
