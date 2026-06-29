import { describe, expect, it } from 'vitest'
import { isAllowedRoot } from './root-allowlist'

describe('isAllowedRoot', () => {
  it('allows a registered repo root exactly', () => {
    expect(isAllowedRoot(['/home/u/repo'], '/home/u/repo')).toBe(true)
  })

  it('allows a nested worktree path under the repo root', () => {
    expect(isAllowedRoot(['/home/u/repo'], '/home/u/repo/.claude/worktrees/x')).toBe(true)
  })

  it('allows any arbitrary nesting under the repo root', () => {
    expect(isAllowedRoot(['/home/u/repo'], '/home/u/repo/subdir/deep')).toBe(true)
  })

  it('rejects an unrelated path', () => {
    expect(isAllowedRoot(['/home/u/repo'], '/etc/passwd')).toBe(false)
  })

  it('rejects a sibling-prefix trap (repo-evil should not match repo)', () => {
    expect(isAllowedRoot(['/home/u/repo'], '/home/u/repo-evil')).toBe(false)
  })

  it('rejects when the allowlist is empty', () => {
    expect(isAllowedRoot([], '/anything')).toBe(false)
  })

  it('allows when multiple repos are registered and root matches the second', () => {
    expect(isAllowedRoot(['/home/u/other', '/home/u/repo'], '/home/u/repo')).toBe(true)
  })

  it('rejects root that is a parent of a registered repo (containment is one-way)', () => {
    expect(isAllowedRoot(['/home/u/repo'], '/home/u')).toBe(false)
  })
})
