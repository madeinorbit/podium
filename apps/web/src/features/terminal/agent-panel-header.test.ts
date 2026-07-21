import { describe, expect, it } from 'vitest'
import { modelToken } from './AgentPanel'

// The header's model token [POD-121]: observed model beats the spawn selection,
// `auto` never shows, effort renders compacted after a middle dot.
describe('modelToken', () => {
  it('compacts an observed model id with effort', () => {
    expect(modelToken({ observedModel: 'claude-fable-5', effort: 'medium' })).toBe('fable 5 · med')
  })

  it('joins consecutive numeric parts as a dotted version', () => {
    expect(modelToken({ observedModel: 'claude-opus-4-8' })).toBe('opus 4.8')
    expect(modelToken({ observedModel: 'claude-haiku-4-5-20251001' })).toBe('haiku 4.5')
    expect(modelToken({ observedModel: 'claude-sonnet-5' })).toBe('sonnet 5')
  })

  it('resolves observed over the spawn selection', () => {
    expect(modelToken({ observedModel: 'claude-fable-5', model: 'opus' })).toBe('fable 5')
  })

  it('falls back to a concrete spawn selection, never to auto', () => {
    expect(modelToken({ model: 'opus' })).toBe('opus')
    expect(modelToken({ model: 'auto' })).toBeNull()
    expect(modelToken({})).toBeNull()
  })

  it('hides an auto effort and passes unknown efforts through', () => {
    expect(modelToken({ observedModel: 'claude-fable-5', effort: 'auto' })).toBe('fable 5')
    expect(modelToken({ observedModel: 'claude-fable-5', effort: 'ultra' })).toBe('fable 5 · ultra')
  })

  it('prefers the observed effort over the spawn request', () => {
    expect(
      modelToken({ observedModel: 'claude-fable-5', observedEffort: 'high', effort: 'medium' }),
    ).toBe('fable 5 · high')
    expect(modelToken({ observedModel: 'claude-fable-5', observedEffort: 'medium' })).toBe(
      'fable 5 · med',
    )
  })
})
