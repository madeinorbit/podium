import { describe, expect, it } from 'vitest'
import { developmentSourceVersion } from './source-version'

describe('developmentSourceVersion', () => {
  it('uses the seven-character git identity shared by development targets', () => {
    expect(developmentSourceVersion('/repo', () => 'ABCDEF012345\n')).toBe('dev+abcdef0')
  })

  it.each([
    ['a non-SHA response', () => 'HEAD'],
    [
      'an unavailable checkout',
      () => {
        throw new Error('not a repository')
      },
    ],
  ])('falls back to dev for %s', (_name, readHead) => {
    expect(developmentSourceVersion('/repo', readHead)).toBe('dev')
  })
})
