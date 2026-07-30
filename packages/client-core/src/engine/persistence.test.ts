import { describe, expect, it } from 'vitest'
import type { UiState } from '../replica/replica'
import {
  DOCK_SHELLS_KEY,
  RECENT_FILES_KEY,
  readStoredDockShells,
  readStoredRecentFiles,
} from './persistence'

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
