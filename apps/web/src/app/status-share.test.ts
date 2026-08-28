import { describe, expect, it } from 'vitest'
import { shareAgentConcurrency, shareTokenBurn } from './status-share'

describe('status-strip X share copy', () => {
  it('names @podium_ade in every intent', () => {
    const posts = [
      shareAgentConcurrency(0),
      shareAgentConcurrency(1),
      shareAgentConcurrency(4),
      shareTokenBurn(0),
      shareTokenBurn(4.99),
      shareTokenBurn(12.4),
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
    expect(shareTokenBurn(12.4, 12)).toBe(
      "My agents' 12-minute token usage in @podium_ade works out to $12.4/hr at API list prices.\n\nI used to think that number would scare me.",
    )
  })

  it('swaps the closer when the hourly burn is small', () => {
    expect(shareTokenBurn(4.99)).toBe(
      "My agents' 15-minute token usage in @podium_ade works out to $4.99/hr at API list prices.\n\na rounding error with commit access.",
    )
    expect(shareTokenBurn(0)).toContain('$0/hr')
    expect(shareTokenBurn(0)).toContain('rounding error')
    // The boundary changes the closer, not the factual description of the rate.
    expect(shareTokenBurn(5)).toContain('I used to think that number would scare me')
  })
})
