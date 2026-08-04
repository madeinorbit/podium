import { AgentKind } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  agentBrandDot,
  agentBrandText,
  agentChipTint,
  agentFleetTileTint,
  agentGlyphTone,
} from './agent-tone'

/**
 * POD-1105 review, blocker 2. These resolvers replaced inline
 * `kind === 'claude-code' ? … : …` ternaries. The ternaries were TOTAL by
 * construction — an unknown harness id off the wire compared false and rendered
 * as a non-Claude harness — so a bare `TABLE[kind]` lookup would have been a
 * regression: `undefined` classes mean a tile with no border, background or text
 * tone at all. These tests pin totality over every built-in AND an unknown id.
 */

/** A harness this build has never heard of, as a newer peer might send it. */
const UNKNOWN = 'future-harness'

const TONE_RESOLVERS = [
  ['agentGlyphTone', agentGlyphTone],
  ['agentChipTint', agentChipTint],
  ['agentFleetTileTint', agentFleetTileTint],
] as const

describe('agent tone resolvers are total', () => {
  for (const [name, resolve] of TONE_RESOLVERS) {
    it(`${name} returns a non-empty class for every built-in kind`, () => {
      for (const kind of AgentKind.options) {
        expect(resolve(kind), `${name}(${kind})`).toBeTruthy()
      }
    })

    it(`${name} falls back to the non-Claude tone for an unknown harness`, () => {
      // The fallback must equal what a known non-Claude harness gets — that is
      // precisely the branch the old ternary took for an unrecognised id.
      expect(resolve(UNKNOWN)).toBe(resolve('codex'))
      expect(resolve(UNKNOWN)).not.toBe(resolve('claude-code'))
    })
  }

  it('the fleet tile keeps border, background and text tone for an unknown harness', () => {
    // The specific regression: an undefined lookup rendered an unstyled tile.
    const tint = agentFleetTileTint(UNKNOWN)
    expect(tint).toMatch(/border-/)
    expect(tint).toMatch(/bg-/)
    expect(tint).toMatch(/text-/)
  })

  it('keeps the built-in pixels the old ternaries produced', () => {
    expect(agentGlyphTone('claude-code')).toBe('text-claude')
    expect(agentGlyphTone('shell')).toBe('text-foreground')
    expect(agentChipTint('claude-code')).toBe('border-claude/50 bg-claude/12')
    expect(agentChipTint('grok')).toBe('border-border-strong bg-chip')
    expect(agentFleetTileTint('claude-code')).toBe('border-claude/50 bg-claude/12 text-claude')
    expect(agentFleetTileTint('cursor')).toBe('border-border-strong bg-chip text-foreground')
  })
})

describe('brand-mark resolvers append nothing rather than overriding', () => {
  it('give Claude its mark and everyone else null', () => {
    expect(agentBrandText('claude-code')).toBe('text-claude')
    expect(agentBrandDot('claude-code')).toBe('bg-claude')
    for (const kind of AgentKind.options.filter((k) => k !== 'claude-code')) {
      expect(agentBrandText(kind), `agentBrandText(${kind})`).toBeNull()
      expect(agentBrandDot(kind), `agentBrandDot(${kind})`).toBeNull()
    }
  })

  it('return null for an unknown harness instead of throwing', () => {
    // null (not '' or undefined) so `cn()` and `&&` behave as they did before.
    expect(agentBrandText(UNKNOWN)).toBeNull()
    expect(agentBrandDot(UNKNOWN)).toBeNull()
  })
})
