import { describe, expect, it } from 'vitest'
import { PROC_MIN_ROLE, ROLE_RANK, resolveRole } from './issue-roles'

describe('resolveRole', () => {
  const env = { maintainerToken: 'MAINT', issueWorktrees: ['/repo/.worktrees/issue-1-foo'] }
  it('maintainer token wins', () => {
    expect(resolveRole({ token: 'MAINT' }, env)).toBe('maintainer')
  })
  it('cwd inside an issue worktree ⇒ worker', () => {
    expect(resolveRole({ cwd: '/repo/.worktrees/issue-1-foo' }, env)).toBe('worker')
    expect(resolveRole({ cwd: '/repo/.worktrees/issue-1-foo/src' }, env)).toBe('worker')
  })
  it('no credentials ⇒ reader (fail-safe)', () => {
    expect(resolveRole({}, env)).toBe('reader')
    expect(resolveRole({ cwd: '/elsewhere' }, env)).toBe('reader')
    expect(resolveRole({ token: 'wrong' }, env)).toBe('reader')
  })
  it('an empty maintainerToken never authenticates', () => {
    expect(resolveRole({ token: '' }, { maintainerToken: '', issueWorktrees: [] })).toBe('reader')
  })
})

describe('PROC_MIN_ROLE', () => {
  it('queries are reader, work ops are worker, structural ops are maintainer', () => {
    expect(PROC_MIN_ROLE.list ?? 'reader').toBe('reader')
    expect(PROC_MIN_ROLE.claim).toBe('worker')
    expect(PROC_MIN_ROLE.linearSearch).toBe('worker')
    expect(PROC_MIN_ROLE.create).toBe('maintainer')
    expect(PROC_MIN_ROLE.archive).toBe('maintainer')
    expect(ROLE_RANK.maintainer).toBeGreaterThan(ROLE_RANK.worker)
    expect(ROLE_RANK.worker).toBeGreaterThan(ROLE_RANK.reader)
  })
})
