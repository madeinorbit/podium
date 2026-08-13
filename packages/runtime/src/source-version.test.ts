import { describe, expect, it } from 'vitest'
import {
  developmentLogVersion,
  developmentSourceSha,
  developmentSourceVersion,
  repositorySourceRoot,
} from './source-version'

describe('developmentSourceVersion', () => {
  it('uses the seven-character git identity shared by development targets', () => {
    expect(developmentSourceSha('/repo', () => 'ABCDEF012345\n')).toBe('abcdef0')
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
    expect(developmentSourceSha('/repo', readHead)).toBeUndefined()
    expect(developmentSourceVersion('/repo', readHead)).toBe('dev')
  })
})

/**
 * POD-1965. Every server, daemon and janitor record logged `v: 'dev'` — present,
 * so nothing looked broken, and constant, so it could not distinguish the build
 * carrying a fix from the build predating it. These pin the narrowing.
 */
describe('developmentLogVersion', () => {
  const clean = () => ''
  const head = () => 'abc1234def\n'

  it('names the commit the source came from', () => {
    expect(developmentLogVersion('/repo', { readHead: head, readStatus: clean })).toBe(
      'dev+abc1234',
    )
  })

  it('says when the tree does not match that commit, because then the sha is a half-truth', () => {
    expect(
      developmentLogVersion('/repo', {
        readHead: head,
        readStatus: () => 'M  apps/server/src/server.ts\0',
      }),
    ).toBe('dev+abc1234-dirty')
  })

  it('distinguishes two commits — the property `dev` did not have', () => {
    const first = developmentLogVersion('/repo', { readHead: () => '1111111', readStatus: clean })
    const second = developmentLogVersion('/repo', { readHead: () => '2222222', readStatus: clean })
    expect(first).not.toBe(second)
  })

  it('falls back to a bare dev when there is no checkout to ask', () => {
    expect(
      developmentLogVersion('/repo', {
        readHead: () => {
          throw new Error('not a repository')
        },
        readStatus: clean,
      }),
    ).toBe('dev')
  })

  it('keeps the sha when the tree is unreadable rather than losing the identity too', () => {
    expect(
      developmentLogVersion('/repo', {
        readHead: head,
        readStatus: () => {
          throw new Error('git status failed')
        },
      }),
    ).toBe('dev+abc1234')
  })

  it('reads this very checkout when asked for nothing in particular', () => {
    expect(developmentLogVersion(repositorySourceRoot())).toMatch(/^dev\+[0-9a-f]{7}(-dirty)?$/)
  })
})
