import { describe, expect, it } from 'vitest'
import {
  isMergeLockName,
  lockNameProblem,
  mergeLockName,
  mergeLockNameProblem,
  normalizeMergeLockBranch,
} from './lock-names'

/**
 * POD-672: the merge mutex answered to two names. `merge` and `merge:main` were
 * independent leases, so two sessions each held "the merge lock" and the second
 * reset away the first's landing. These tests pin the namespace shut.
 */

describe('mergeLockName', () => {
  it('builds the canonical branch-scoped name, defaulting to main', () => {
    expect(mergeLockName()).toBe('merge:main')
    expect(mergeLockName('main')).toBe('merge:main')
    expect(mergeLockName('release/2.0')).toBe('merge:release/2.0')
  })

  it('collapses the refs/heads spelling onto the same lease', () => {
    expect(mergeLockName('refs/heads/main')).toBe('merge:main')
    expect(normalizeMergeLockBranch('refs/heads/topic')).toBe('topic')
    expect(normalizeMergeLockBranch('  main  ')).toBe('main')
  })

  it('round-trips through the recogniser', () => {
    expect(isMergeLockName(mergeLockName('main'))).toBe(true)
    expect(isMergeLockName('merge')).toBe(false)
    expect(isMergeLockName('test:heavy')).toBe(false)
  })
})

describe('lockNameProblem', () => {
  it('leaves the free-form namespace alone', () => {
    // The general lock namespace is the point of the feature — only `merge` is reserved.
    for (const name of ['test:heavy', 'podium:dev-bundle', 'validation:admission', 'deploy', '20260810-migration']) {
      expect(lockNameProblem(name)).toBeNull()
    }
  })

  it('accepts the canonical merge mutex for any branch', () => {
    expect(lockNameProblem('merge:main')).toBeNull()
    expect(lockNameProblem('merge:release/2.0')).toBeNull()
  })

  it('refuses the bare `merge` — the exact name that split the mutex', () => {
    const problem = lockNameProblem('merge')
    expect(problem).not.toBeNull()
    // The error must carry the canonical name; an agent that reads it should not
    // have to go looking for the right spelling.
    expect(problem).toContain('merge:main')
    expect(problem).toMatch(/merge-lock acquire/)
  })

  it('refuses near-misses that would each take their own lease', () => {
    for (const name of ['merge', 'merge-main', 'merge_lock', 'mergemain', 'merge/main', 'MERGE', 'Merge:main']) {
      expect(lockNameProblem(name)).not.toBeNull()
    }
  })

  it('refuses a merge name with no branch', () => {
    expect(lockNameProblem('merge:')).toContain('names no branch')
  })

  it('refuses ref paths and remote-tracking refs, naming the local branch instead', () => {
    // Landing moves the LOCAL branch; keying on origin/main would split the mutex again.
    expect(lockNameProblem('merge:origin/main')).toContain("'merge:main'")
    expect(lockNameProblem('merge:refs/heads/main')).toContain("'merge:main'")
    expect(lockNameProblem('merge:remotes/origin/main')).not.toBeNull()
  })

  it('still enforces charset and length', () => {
    expect(lockNameProblem('')).toBe('lock name is required')
    expect(lockNameProblem('-leading-dash')).toMatch(/letters, digits/)
    expect(lockNameProblem('has space')).toMatch(/letters, digits/)
    expect(lockNameProblem(`a${'b'.repeat(200)}`)).toMatch(/longer than 200/)
  })

  it('reports charset before the merge rule so a garbled name is not mislabelled', () => {
    expect(lockNameProblem('merge lock')).toMatch(/letters, digits/)
  })
})

describe('mergeLockNameProblem', () => {
  it('is silent for names outside the reserved namespace', () => {
    expect(mergeLockNameProblem('test:heavy')).toBeNull()
    expect(mergeLockNameProblem('remerge:main')).toBeNull()
  })
})
