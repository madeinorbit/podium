import { describe, expect, it } from 'vitest'
import {
  AGENT_CAPABILITIES,
  AgentKind,
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

  it('every harness kind carries a row for both new flags', () => {
    // The table is the manifest: a missing row is how a new harness ends up
    // silently defaulting into (or out of) an affordance.
    for (const kind of AgentKind.options) {
      expect(typeof AGENT_CAPABILITIES[kind].handoff).toBe('boolean')
      expect(typeof AGENT_CAPABILITIES[kind].promptModeHints).toBe('boolean')
    }
  })
})
