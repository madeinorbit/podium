import { describe, expect, it } from 'vitest'
import { availableDriverIds } from './registry'

describe('availableDriverIds — grok-acp selection', () => {
  it('lists grok-acp only where the gate admitted the binary', () => {
    expect(availableDriverIds({ opencodeDrivable: false, grokDrivable: true })).toContain(
      'grok-acp',
    )
  })
})
