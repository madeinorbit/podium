import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  artifactKind,
  basename,
  cwdInWorktree,
  issueForCwd,
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
    ).toEqual({ cwd: '/wt/c', machineId: 'm2' })
  })

  it('falls back to the most recently active session', () => {
    expect(resolveActiveWorktree({ paneA: null, fileTabs: [], sessions: [s1, s2] })).toEqual({
      cwd: '/wt/b',
      machineId: undefined,
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
