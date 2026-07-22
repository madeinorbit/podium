import type { IssueGitState } from '@podium/protocol'
import { describe, expect, test } from 'vitest'
import { deriveGitStamp } from './git-stamp'

const base: IssueGitState = {
  updatedAt: '2026-07-20T12:00:00Z',
  branch: 'issue/98-commit-viz',
  shared: false,
  dirtyFiles: 0,
}

describe('deriveGitStamp', () => {
  test('no gitState → hidden', () => {
    expect(deriveGitStamp(null, undefined).kind).toBe('hidden')
  })

  test('first probe in flight → loading shimmer', () => {
    const m = deriveGitStamp(null, { ...base, updatedAt: '', computing: true })
    expect(m.kind).toBe('loading')
    expect(m.dot).toBe('loading')
  })

  test('refresh keeps data visible with refreshing flag', () => {
    const m = deriveGitStamp(null, { ...base, ahead: 3, computing: true })
    expect(m.kind).toBe('ready')
    expect(m.refreshing).toBe(true)
    expect(m.ahead).toBe(3)
  })

  test('fresh private branch, clean → hollow dot, "no commits"', () => {
    const m = deriveGitStamp('issue/98-commit-viz', base)
    expect(m.dot).toBe('none')
    expect(m.note).toBe('no commits')
  })

  test('private branch dirty, nothing committed → amber, files label', () => {
    const m = deriveGitStamp(null, { ...base, dirtyFiles: 4 })
    expect(m.dot).toBe('dirty')
    expect(m.dirty).toBe(4)
    expect(m.dirtyLabel).toBe('files')
  })

  test('private branch committed clean → green ↑N + clean note', () => {
    const m = deriveGitStamp(null, { ...base, ahead: 3 })
    expect(m.dot).toBe('clean')
    expect(m.ahead).toBe(3)
    expect(m.note).toBe('clean')
  })

  test('committed and dirty → both counters, dirty dot wins', () => {
    const m = deriveGitStamp(null, { ...base, ahead: 3, dirtyFiles: 2 })
    expect(m.dot).toBe('dirty')
    expect(m.ahead).toBe(3)
    expect(m.dirty).toBe(2)
  })

  test('merged → relaxed ✓, no counters', () => {
    const m = deriveGitStamp(null, { ...base, merged: true })
    expect(m.merged).toBe(true)
    expect(m.dot).toBe('clean')
    expect(m.note).toBeUndefined()
  })

  test('shared checkout suppresses the merge axis', () => {
    const m = deriveGitStamp(null, {
      ...base,
      branch: 'main',
      shared: true,
      ahead: 12, // whatever a probe reported, shared checkouts have no merge axis
      commits: ['abc', 'def'],
    })
    expect(m.ahead).toBeUndefined()
    expect(m.commits).toBe(2)
    expect(m.dot).toBe('clean')
  })

  test('shared checkout attributes dirty to the task (yours)', () => {
    const m = deriveGitStamp(null, {
      ...base,
      branch: 'v3',
      shared: true,
      dirtyFiles: 7,
      dirtyOwn: 4,
    })
    expect(m.dirty).toBe(4)
    expect(m.dirtyLabel).toBe('yours')
    expect(m.title).toContain('+3 more from other sessions')
  })

  test('shared checkout without attribution omits checkout-wide dirt', () => {
    const m = deriveGitStamp(null, {
      ...base,
      branch: 'main',
      shared: true,
      dirtyFiles: 7,
      fallback: true,
    })
    expect(m.dirty).toBeUndefined()
    expect(m.dot).toBe('none')
    expect(m.title).not.toContain('checkout-level')
  })

  test('shared clean, no attributed commits → "no changes"', () => {
    const m = deriveGitStamp(null, { ...base, branch: 'main', shared: true })
    expect(m.dot).toBe('none')
    expect(m.note).toBe('no changes')
  })

  test('marker-only attribution never shows checkout dirt as issue-owned', () => {
    const m = deriveGitStamp(null, {
      ...base,
      branch: 'main',
      shared: true,
      dirtyFiles: 7,
      commits: ['a', 'b', 'c'], // history markers; no touched-file set
    })
    expect(m.commits).toBe(3)
    expect(m.dirty).toBeUndefined()
  })

  test('clean-for-you on a dirty shared checkout says "none yours"', () => {
    const m = deriveGitStamp(null, {
      ...base,
      branch: 'main',
      shared: true,
      dirtyFiles: 7,
      dirtyOwn: 0,
    })
    expect(m.dot).toBe('none')
    expect(m.note).toBe('none yours')
  })

  test('unpushed lights only when task commits are off-upstream', () => {
    const on = deriveGitStamp(null, {
      ...base,
      branch: 'main',
      shared: true,
      commits: ['abc'],
      unpushed: 1,
    })
    expect(on.unpushed).toBe(true)
    const off = deriveGitStamp(null, { ...base, branch: 'main', shared: true, commits: ['abc'] })
    expect(off.unpushed).toBe(false)
  })

  test('mismatch: issue has a private branch, checkout dirties a shared one', () => {
    const m = deriveGitStamp('issue/98-commit-viz', {
      ...base,
      branch: 'main',
      shared: true,
      dirtyFiles: 7,
      dirtyOwn: 7,
    })
    expect(m.mismatch).toBe(true)
    // …but a clean shared checkout is no anomaly:
    const clean = deriveGitStamp('issue/98-commit-viz', { ...base, branch: 'main', shared: true })
    expect(clean.mismatch).toBe(false)
    // …and deliberate on-main work (no issue branch) never alarms:
    const deliberate = deriveGitStamp(null, {
      ...base,
      branch: 'main',
      shared: true,
      dirtyFiles: 7,
    })
    expect(deliberate.mismatch).toBe(false)
  })
})
