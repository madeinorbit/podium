import { describe, expect, it } from 'vitest'
import type { UiState } from '../replica/replica'
import { DOCK_SHELLS_KEY, readStoredDockShells } from './persistence'

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
