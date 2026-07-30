import { describe, expect, it } from 'vitest'
import { AgentKind } from '@podium/model'
import {
  AGENT_CAPABILITIES,
  agentCapabilitiesFor,
  agentShowsPromptModeHints,
  agentSupportsHandoff,
} from './terminal'

/**
 * POD-1105 moved two harness decisions out of view code and into the capability
 * table (the harness axiom: behavior keyed on a harness may not be an `if` in a
 * component). These tests pin the new flags to the EXACT sets the deleted
 * branches matched, so the relocation is provably behaviour-preserving rather
 * than merely no longer detected — and so a future harness row cannot silently
 * widen a UI affordance.
 */
describe('capabilities relocated from view code (POD-1105)', () => {
  it('handoff is exactly the pair the handoff call sites used to name', () => {
    // Was: `agentKind === 'claude-code' || agentKind === 'codex'` in
    // apps/web/src/features/issues/issue-context-menu.ts.
    const kinds = AgentKind.options.filter((k) => agentSupportsHandoff(k))
    expect(kinds).toEqual(['claude-code', 'codex'])
  })

  it('prompt-mode hints are claude-code only', () => {
    // Was: `session?.agentKind === 'claude-code'` gating the prompt-chrome hint
    // row in apps/web/src/features/terminal/AgentPanel.tsx. Only a CLI that
    // really honours shift+tab cycling and `?` help may advertise them.
    const kinds = AgentKind.options.filter((k) => agentShowsPromptModeHints(k))
    expect(kinds).toEqual(['claude-code'])
  })

  it('answers for an UNKNOWN harness instead of throwing (review blocker 1)', () => {
    // The wire is not closed: a newer machine can name a harness this build has
    // never heard of. The comparisons these helpers replaced returned false for
    // such an id; indexing the closed table would throw instead. An unknown
    // harness must degrade to "no special affordance", not crash the view.
    const unknown = 'future-harness'
    expect(() => agentShowsPromptModeHints(unknown)).not.toThrow()
    expect(() => agentSupportsHandoff(unknown)).not.toThrow()
    expect(agentShowsPromptModeHints(unknown)).toBe(false)
    expect(agentSupportsHandoff(unknown)).toBe(false)
    expect(agentCapabilitiesFor(unknown)).toBeUndefined()
  })

  it('still resolves a real row for a known harness', () => {
    expect(agentCapabilitiesFor('codex')?.handoff).toBe(true)
    expect(agentCapabilitiesFor('claude-code')?.promptModeHints).toBe(true)
  })

  it('every harness kind carries a row for both new flags', () => {
    // The table is the manifest: a missing row is how a new harness ends up
    // silently defaulting into (or out of) an affordance.
    for (const kind of AgentKind.options) {
      expect(typeof AGENT_CAPABILITIES[kind].handoff).toBe('boolean')
      expect(typeof AGENT_CAPABILITIES[kind].promptModeHints).toBe('boolean')
    }
  })
})
