import type { AgentKind } from '@podium/protocol'

/**
 * Per-kind brand tone (POD-293) as TABLES rather than comparisons.
 *
 * Every value here used to be an inline `kind === 'claude-code' ? … : …` spread
 * across four view files. That is behavioral branching on harness identity in
 * the UI — the exact shape the harness axiom exists to delete (see the axiom in
 * `scripts/architecture-manifest.ts` and ADR 0008). A Record keyed BY harness is
 * not a comparison: the axiom permits icon/label/tone maps precisely because
 * adding a harness means adding a row, not finding every `if` (POD-1105).
 *
 * Keep the class strings verbatim per kind — these are the concept's pixels, so
 * a "simplification" that collapses two rows changes the design.
 */

/** Glyph colour for an agent-kind icon at rest. */
export const AGENT_GLYPH_TONE: Record<AgentKind, string> = {
  'claude-code': 'text-claude',
  codex: 'text-foreground',
  grok: 'text-foreground',
  opencode: 'text-foreground',
  cursor: 'text-foreground',
  shell: 'text-foreground',
}

/** 20px chip behind the glyph (work-list agent rows): Claude wears its clay,
 *  other harnesses a quiet navy — solid fills so a chip never ghosts through a
 *  neighbour. */
export const AGENT_CHIP_TINT: Record<AgentKind, string> = {
  'claude-code': 'border-[#d97757]/50 bg-[#2a1a14]',
  codex: 'border-[#33456e] bg-[#182338]',
  grok: 'border-[#33456e] bg-[#182338]',
  opencode: 'border-[#33456e] bg-[#182338]',
  cursor: 'border-[#33456e] bg-[#182338]',
  shell: 'border-[#33456e] bg-[#182338]',
}

/** Stacked fleet-summary tile (sidebar issue rows) — carries its own text tone,
 *  which is why it is not the chip table above. */
export const AGENT_FLEET_TILE_TINT: Record<AgentKind, string> = {
  'claude-code': 'border-[#d97757]/50 bg-[#2a1a14] text-claude',
  codex: 'border-[#33456e] bg-[#182338] text-[#c3cbe0]',
  grok: 'border-[#33456e] bg-[#182338] text-[#c3cbe0]',
  opencode: 'border-[#33456e] bg-[#182338] text-[#c3cbe0]',
  cursor: 'border-[#33456e] bg-[#182338] text-[#c3cbe0]',
  shell: 'border-[#33456e] bg-[#182338] text-[#c3cbe0]',
}

/**
 * Brand text tone APPENDED to an existing class list, or null for a kind that
 * inherits the surrounding tone.
 *
 * Deliberately not {@link AGENT_GLYPH_TONE}: these call sites used to append
 * nothing at all for non-Claude kinds, so a table that returned
 * `text-foreground` here would override an inherited colour and change pixels.
 */
export const AGENT_BRAND_TEXT: Record<AgentKind, string | null> = {
  'claude-code': 'text-claude',
  codex: null,
  grok: null,
  opencode: null,
  cursor: null,
  shell: null,
}

/** Brand dot shown beside the model token, or null for a kind with no brand
 *  mark of its own (the dot is omitted entirely, as before). */
export const AGENT_BRAND_DOT: Record<AgentKind, string | null> = {
  'claude-code': 'bg-claude',
  codex: null,
  grok: null,
  opencode: null,
  cursor: null,
  shell: null,
}
