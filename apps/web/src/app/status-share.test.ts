import { describe, expect, it } from 'vitest'
import { shareAgentConcurrency, shareShipRate, shareTokenBurn } from './status-share'

describe('status-strip X share copy', () => {
  it('names @podium_ade in every intent', () => {
    const posts = [
      shareAgentConcurrency(0),
      shareAgentConcurrency(1),
      shareAgentConcurrency(4),
      shareTokenBurn(0),
      shareTokenBurn(4.99),
      shareTokenBurn(12.4),
      shareShipRate(0),
      shareShipRate(1),
      shareShipRate(12),
    ]
    for (const post of posts) {
      expect(post).toContain('@podium_ade')
      expect(post).not.toMatch(/#\w/)
    }
  })

  it('treats a live fleet as a dispatch, not a product sentence', () => {
    expect(shareAgentConcurrency(1)).toContain('1 agent is mid-session in @podium_ade')
    expect(shareAgentConcurrency(4)).toContain('4 agents are mid-session in @podium_ade')
    expect(shareAgentConcurrency(0)).toContain('0 agents working in @podium_ade')
    expect(shareAgentConcurrency(0)).toContain('rare quiet')
  })

  it('puts the operator, not the product, on the burning end', () => {
    expect(shareTokenBurn(12.4)).toBe(
      'I am burning $12.4/hr in tokens with @podium_ade.\n\nI used to think that number would scare me.',
    )
  })

  it('swaps the closer when the hourly burn is small', () => {
    expect(shareTokenBurn(4.99)).toBe(
      'I am running @podium_ade on $4.99/hr in tokens.\n\na rounding error with commit access.',
    )
    expect(shareTokenBurn(0)).toContain('$0/hr')
    expect(shareTokenBurn(0)).toContain('rounding error')
    // The boundary is the flex: $5.00 is a burn, $4.99 is a rounding error.
    expect(shareTokenBurn(5)).toContain('I am burning')
  })

  it('flexes the day of ships and has a dry empty runway', () => {
    expect(shareShipRate(1)).toContain('1 issue shipped on @podium_ade in the last 24h')
    expect(shareShipRate(12)).toContain('12 issues shipped on @podium_ade in the last 24h')
    expect(shareShipRate(0)).toContain('0 ships in 24 hours on @podium_ade')
    expect(shareShipRate(0)).toContain('the runway is empty')
  })
})
