import { describe, expect, it } from 'vitest'
import { didYouMean, jaro, jaroWinkler, similarityScore } from './similarity'

describe('jaro / jaroWinkler', () => {
  it('scores identical strings 1 and disjoint strings 0', () => {
    expect(jaro('claude', 'claude')).toBe(1)
    expect(jaroWinkler('claude', 'claude')).toBe(1)
    expect(jaro('abc', 'xyz')).toBe(0)
    expect(jaroWinkler('abc', 'xyz')).toBe(0)
  })

  it('rewards a shared prefix over plain Jaro', () => {
    // Same edit distance, but the prefix bonus lifts Jaro-Winkler above Jaro.
    expect(jaroWinkler('gpt-5.6', 'gpt-5.6-sol')).toBeGreaterThan(jaro('gpt-5.6', 'gpt-5.6-sol'))
  })

  it('scores a one-character slip high', () => {
    expect(jaroWinkler('claude-opus-4-8', 'claude-opus-4.8')).toBeGreaterThan(0.9)
  })
})

describe('similarityScore', () => {
  it('is case-insensitive', () => {
    expect(similarityScore('CLAUDE-OPUS-4-8', 'claude-opus-4-8')).toBe(1)
  })

  it('floors a substring match at 0.9', () => {
    // "opus" shares no long prefix with the full slug, so raw Jaro-Winkler is low,
    // but containment guarantees it clears the suggestion threshold.
    expect(jaroWinkler('opus', 'claude-opus-4-8')).toBeLessThan(0.85)
    expect(similarityScore('opus', 'claude-opus-4-8')).toBeGreaterThanOrEqual(0.9)
  })
})

describe('didYouMean', () => {
  const models = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5.6-sol']

  it('returns [] for an empty query or no match over threshold', () => {
    expect(didYouMean('', models)).toEqual([])
    expect(didYouMean('completely-different', ['xyz', 'qrs'])).toEqual([])
  })

  it('suggests the closest slug for a typo', () => {
    expect(didYouMean('claude-opus-4.8', models)[0]).toBe('claude-opus-4-8')
  })

  it('caps at three results and orders by score', () => {
    const many = ['high', 'higher', 'highest', 'highish', 'highs']
    const out = didYouMean('hihg', many)
    expect(out.length).toBeLessThanOrEqual(3)
    expect(out[0]).toBe('high')
  })

  it('honors a custom limit and threshold', () => {
    expect(didYouMean('claude', models, { limit: 1 }).length).toBeLessThanOrEqual(1)
    expect(didYouMean('zzz', models, { threshold: 0.99 })).toEqual([])
  })
})
