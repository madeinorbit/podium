import { describe, expect, it } from 'vitest'
import { normalizeOriginUrl } from './git'

describe('normalizeOriginUrl', () => {
  it('matches scp-style and https forms of the same repo', () => {
    const a = normalizeOriginUrl('git@github.com:me/proj.git')
    const b = normalizeOriginUrl('https://github.com/me/proj')
    expect(a).toBe('github.com/me/proj')
    expect(a).toBe(b)
  })
  it('lowercases host but not path, strips .git and trailing slash', () => {
    expect(normalizeOriginUrl('https://GitHub.com/Me/Proj.git/')).toBe('github.com/Me/Proj')
  })
  it('handles ssh:// and a port', () => {
    expect(normalizeOriginUrl('ssh://git@github.com:22/me/proj.git')).toBe('github.com/me/proj')
  })
  it('returns empty string for missing/garbage input', () => {
    expect(normalizeOriginUrl(undefined)).toBe('')
    expect(normalizeOriginUrl('')).toBe('')
    expect(normalizeOriginUrl('not a url')).toBe('not a url')
  })
})
