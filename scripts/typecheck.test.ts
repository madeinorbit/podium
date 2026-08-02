import { describe, expect, it } from 'vitest'
import { decideForce, fingerprint } from './typecheck'

describe('decideForce', () => {
  it('plain run forwards args untouched and stays cached', () => {
    const d = decideForce(['--concurrency=4', '--filter=@podium/web'], {})
    expect(d.error).toBeNull()
    expect(d.forceRequested).toBe(false)
    expect(d.forwardArgs).toEqual(['--concurrency=4', '--filter=@podium/web'])
  })

  it('refuses --force without a reason', () => {
    const d = decideForce(['--force'], {})
    expect(d.error).toContain('--uncached-because')
    expect(d.forwardArgs).not.toContain('--force')
  })

  it('refuses TURBO_FORCE env without a reason', () => {
    expect(decideForce([], { TURBO_FORCE: '1' }).error).toContain('--uncached-because')
    expect(decideForce([], { TURBO_FORCE: 'false' }).error).toBeNull()
  })

  it('refuses write-only --cache spellings without a reason', () => {
    expect(decideForce(['--cache=local:w,remote:w'], {}).error).toContain('--uncached-because')
    expect(decideForce(['--cache=local:rw'], {}).error).toBeNull()
  })

  it('a stated reason unlocks --force and strips the reason flag', () => {
    for (const args of [
      ['--force', '--uncached-because=suspect stale artifact'],
      ['--uncached-because', 'suspect stale artifact'],
    ]) {
      const d = decideForce(args, {})
      expect(d.error).toBeNull()
      expect(d.reason).toBe('suspect stale artifact')
      expect(d.forwardArgs).toEqual(['--force'])
    }
  })

  it('refuses an empty reason', () => {
    expect(decideForce(['--uncached-because='], {}).error).toContain('empty')
  })
})

describe('fingerprint', () => {
  const base = { bunfig: 'linker = "hoisted"\n', links: ['cli', 'model'] }

  it('moves when bunfig.toml changes (the POD-1343 linker blind spot)', () => {
    expect(fingerprint({ ...base, bunfig: 'linker = "isolated"\n' })).not.toBe(fingerprint(base))
  })

  it('moves when a workspace link dangles or disappears', () => {
    expect(fingerprint({ ...base, links: ['cli', 'model!DANGLING'] })).not.toBe(fingerprint(base))
    expect(fingerprint({ ...base, links: ['cli'] })).not.toBe(fingerprint(base))
  })

  it('is stable for identical environments', () => {
    expect(fingerprint({ ...base })).toBe(fingerprint(base))
  })
})
