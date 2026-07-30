import { describe, expect, it } from 'vitest'
import { modelToken } from './AgentPanel'

// The header's model token [POD-121]: observed model beats the spawn selection,
// a spawn-time `auto` shows literally until observed [POD-158], effort renders
// compacted after a middle dot (alone if no model is known yet).
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

  it('falls back to the spawn selection, showing auto literally', () => {
    expect(modelToken({ model: 'opus' })).toBe('opus')
    expect(modelToken({ model: 'auto' })).toBe('auto')
    expect(modelToken({ model: 'auto', effort: 'medium' })).toBe('auto · med')
    expect(modelToken({})).toBeNull()
  })

  it('renders effort alone before any model is known', () => {
    expect(modelToken({ effort: 'high' })).toBe('high')
    expect(modelToken({ effort: 'auto' })).toBeNull()
  })

  it('observation replaces a spawn-time auto', () => {
    expect(modelToken({ observedModel: 'claude-fable-5', model: 'auto' })).toBe('fable 5')
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
