import { describe, expect, it } from 'vitest'
import { resolveAgainstCwd } from './file-path'

describe('resolveAgainstCwd', () => {
  it('keeps absolute paths', () => {
    expect(resolveAgainstCwd('/repo', '/repo/a.ts')).toBe('/repo/a.ts')
  })
  it('joins relative paths onto cwd', () => {
    expect(resolveAgainstCwd('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(resolveAgainstCwd('/repo/', './src/a.ts')).toBe('/repo/src/a.ts')
  })
})
