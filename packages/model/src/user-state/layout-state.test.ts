/**
 * normalizeDockWorktreeKey (POD-4436) — the one spelling for the server-owned
 * dock-shell mapping key. `a` and `a/` name one directory, so both spellings
 * must resolve to one mapping row; relative paths cannot name a worktree.
 */

import { describe, expect, it } from 'vitest'
import { normalizeDockWorktreeKey } from './layout-state'

describe('normalizeDockWorktreeKey', () => {
  it('leaves absolute paths alone', () => {
    expect(normalizeDockWorktreeKey('/r/.worktrees/a')).toBe('/r/.worktrees/a')
  })

  it('folds trailing slashes to one row', () => {
    expect(normalizeDockWorktreeKey('/r/.worktrees/a/')).toBe('/r/.worktrees/a')
    expect(normalizeDockWorktreeKey('/r/.worktrees/a///')).toBe('/r/.worktrees/a')
  })

  it('preserves the filesystem root', () => {
    expect(normalizeDockWorktreeKey('/')).toBe('/')
  })

  it('refuses relative, empty and blank paths', () => {
    expect(normalizeDockWorktreeKey('relative/path')).toBeNull()
    expect(normalizeDockWorktreeKey('')).toBeNull()
    expect(normalizeDockWorktreeKey('   ')).toBeNull()
  })
})
