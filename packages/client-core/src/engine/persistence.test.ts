import { describe, expect, it } from 'vitest'
import type { UiState } from '../replica/replica'
import {
  DOCK_SHELLS_KEY,
  FILE_TABS_KEY,
  RECENT_FILES_KEY,
  readStoredDockShells,
  readStoredFileTabs,
  readStoredRecentFiles,
} from '../ui-state'

function fakeUi(entries: Record<string, string>): UiState {
  const map = new Map(Object.entries(entries))
  return {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string | null) => {
      if (v === null) map.delete(k)
      else map.set(k, v)
    },
    subscribe: () => () => {},
  } as unknown as UiState
}

describe('readStoredDockShells (#23)', () => {
  it('reads a valid worktree→session map', () => {
    const ui = fakeUi({ [DOCK_SHELLS_KEY]: JSON.stringify({ '/repo/wt': 'abc' }) })
    expect(readStoredDockShells(ui)).toEqual({ '/repo/wt': 'abc' })
  })

  it('missing key reads as empty', () => {
    expect(readStoredDockShells(fakeUi({}))).toEqual({})
  })

  it('corrupt JSON reads as empty', () => {
    expect(readStoredDockShells(fakeUi({ [DOCK_SHELLS_KEY]: '{nope' }))).toEqual({})
  })

  it('non-string and empty values are dropped', () => {
    const ui = fakeUi({
      [DOCK_SHELLS_KEY]: JSON.stringify({ '/a': 'ok', '/b': 7, '/c': '', '/d': null }),
    })
    expect(readStoredDockShells(ui)).toEqual({ '/a': 'ok' })
  })
})

describe('readStoredRecentFiles (POD-149)', () => {
  const entry = {
    path: '/wt/a.md',
    worktreePath: '/wt',
    openedAt: 1,
  }

  it('reads valid entries, keeping machineId and artifact ids', () => {
    const full = { ...entry, machineId: 'm1', artifact: { issueId: 'i1', artifactId: 'a1' } }
    const ui = fakeUi({ [RECENT_FILES_KEY]: JSON.stringify([entry, full]) })
    expect(readStoredRecentFiles(ui)).toEqual([entry, full])
  })

  it('missing key / corrupt JSON / non-array read as empty', () => {
    expect(readStoredRecentFiles(fakeUi({}))).toEqual([])
    expect(readStoredRecentFiles(fakeUi({ [RECENT_FILES_KEY]: '[nope' }))).toEqual([])
    expect(readStoredRecentFiles(fakeUi({ [RECENT_FILES_KEY]: '{"a":1}' }))).toEqual([])
  })

  it('drops malformed entries individually and strips a half-formed artifact', () => {
    const ui = fakeUi({
      [RECENT_FILES_KEY]: JSON.stringify([
        entry,
        null,
        { path: '', worktreePath: '/wt', openedAt: 1 },
        { path: '/x', worktreePath: '/wt' },
        { ...entry, artifact: { issueId: 'i1' } },
      ]),
    })
    expect(readStoredRecentFiles(ui)).toEqual([entry, entry])
  })
})

describe('readStoredFileTabs (POD-1247)', () => {
  const sessionTab = {
    id: 'file:s:sess1:/wt/a.md',
    scope: { kind: 'session', sessionId: 'sess1' },
    path: '/wt/a.md',
    worktreePath: '/wt',
  }
  const worktreeTab = {
    id: 'file:w:/wt:/wt/b.md',
    scope: { kind: 'worktree', root: '/wt', machineId: 'm1' },
    path: '/wt/b.md',
    worktreePath: '/wt',
    issueId: 'i1',
  }
  const artifactTab = {
    id: 'file:a:i1:art1:shot.png',
    scope: { kind: 'artifact', issueId: 'i1', artifactId: 'art1' },
    path: 'shot.png',
    worktreePath: '',
    issueId: 'i1',
  }

  it('reads every scope arm back, keeping the owning issue', () => {
    const ui = fakeUi({
      [FILE_TABS_KEY]: JSON.stringify([sessionTab, worktreeTab, artifactTab]),
    })
    expect(readStoredFileTabs(ui)).toEqual([sessionTab, worktreeTab, artifactTab])
  })

  it('missing key / corrupt JSON / non-array read as no tabs', () => {
    expect(readStoredFileTabs(fakeUi({}))).toEqual([])
    expect(readStoredFileTabs(fakeUi({ [FILE_TABS_KEY]: '[nope' }))).toEqual([])
    expect(readStoredFileTabs(fakeUi({ [FILE_TABS_KEY]: '{"a":1}' }))).toEqual([])
  })

  it('drops rows with an unusable scope rather than guessing one', () => {
    const ui = fakeUi({
      [FILE_TABS_KEY]: JSON.stringify([
        { ...sessionTab, scope: { kind: 'session' } },
        { ...worktreeTab, scope: { kind: 'nebula', root: '/wt' } },
        { ...artifactTab, scope: undefined },
        sessionTab,
      ]),
    })
    expect(readStoredFileTabs(ui)).toEqual([sessionTab])
  })

  it('drops malformed and duplicate rows', () => {
    const ui = fakeUi({
      [FILE_TABS_KEY]: JSON.stringify([
        sessionTab,
        sessionTab,
        { ...worktreeTab, id: '' },
        { ...worktreeTab, path: 7 },
        null,
      ]),
    })
    expect(readStoredFileTabs(ui)).toEqual([sessionTab])
  })
})
