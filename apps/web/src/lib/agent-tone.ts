import type { AgentKind } from '@podium/model'

/**
 * Per-kind brand tone (POD-293) as TOTAL RESOLVERS over tables.
 *
 * Every value here used to be an inline `kind === 'claude-code' ? … : …` spread
 * across four view files. That is behavioral branching on harness identity in
 * the UI — the exact shape the harness axiom exists to delete (see the axiom in
 * `scripts/architecture-manifest.ts` and ADR 0008). A Record keyed BY harness is
 * not a comparison: the axiom permits icon/label/tone maps precisely because
 * adding a harness means adding a row, not finding every `if` (POD-1105).
 *
 * WHY FUNCTIONS AND NOT BARE RECORDS (POD-1105 review, blocker 2). The tables
 * are typed `Record<AgentKind, …>`, but `agentKind` arrives from the WIRE, and
 * the wire can carry a harness this build has never heard of — a newer machine
 * in the fleet, or a harness added after this client shipped. A bare
 * `TABLE[kind]` then yields `undefined` and the tile silently loses its border,
 * background and text tone, which is a REGRESSION against the ternaries this
 * replaced: `kind === 'claude-code'` was false for an unknown harness, so it
 * fell into the non-Claude branch and still rendered. Each resolver below is
 * total, and its fallback is exactly that old non-Claude branch. An unknown
 * harness must render like any other non-Claude one, never unstyled.
 *
 * Keep the class strings verbatim per kind — these are the concept's pixels, so
 * a "simplification" that collapses two rows changes the design.
 */

/** The tone an unrecognised harness gets: the old non-Claude branch, verbatim. */
const GLYPH_TONE_FALLBACK = 'text-foreground'
const CHIP_TINT_FALLBACK = 'border-border-strong bg-chip'
const FLEET_TILE_TINT_FALLBACK = 'border-border-strong bg-chip text-foreground'

const GLYPH_TONE: Record<AgentKind, string> = {
  'claude-code': 'text-claude',
  codex: GLYPH_TONE_FALLBACK,
  grok: GLYPH_TONE_FALLBACK,
  opencode: GLYPH_TONE_FALLBACK,
  cursor: GLYPH_TONE_FALLBACK,
  shell: GLYPH_TONE_FALLBACK,
}

const CHIP_TINT: Record<AgentKind, string> = {
  'claude-code': 'border-claude/50 bg-claude/12',
  codex: CHIP_TINT_FALLBACK,
  grok: CHIP_TINT_FALLBACK,
  opencode: CHIP_TINT_FALLBACK,
  cursor: CHIP_TINT_FALLBACK,
  shell: CHIP_TINT_FALLBACK,
}

const FLEET_TILE_TINT: Record<AgentKind, string> = {
  'claude-code': 'border-claude/50 bg-claude/12 text-claude',
  codex: FLEET_TILE_TINT_FALLBACK,
  grok: FLEET_TILE_TINT_FALLBACK,
  opencode: FLEET_TILE_TINT_FALLBACK,
  cursor: FLEET_TILE_TINT_FALLBACK,
  shell: FLEET_TILE_TINT_FALLBACK,
}

/**
 * Harnesses that carry a brand mark of their own. Only these get brand text or a
 * brand dot; everything else — including an unknown harness — inherits the
 * surrounding tone, which is what the old call sites did by appending nothing.
 */
const BRAND_TEXT: Partial<Record<AgentKind, string>> = { 'claude-code': 'text-claude' }
const BRAND_DOT: Partial<Record<AgentKind, string>> = { 'claude-code': 'bg-claude' }

/**
 * The wire's harness id as this module accepts it: a known kind, or any string a
 * newer peer might send. Widened on purpose — see the header.
 *
 * Local and unexported by design. POD-397 owns the real `HarnessId` (open,
 * branded) in @podium/protocol; this alias exists only so these five signatures
 * read clearly, and POD-398 can swap it for the real type without touching call
 * sites. It is NOT a second vocabulary.
 */
type WireHarnessKind = AgentKind | (string & {})

/** Glyph colour for an agent-kind icon at rest. Total. */
export function agentGlyphTone(kind: WireHarnessKind): string {
  return GLYPH_TONE[kind as AgentKind] ?? GLYPH_TONE_FALLBACK
}

/** 20px chip behind the glyph (work-list agent rows): Claude wears its clay,
 *  other harnesses a quiet navy — solid fills so a chip never ghosts through a
 *  neighbour. Total. */
export function agentChipTint(kind: WireHarnessKind): string {
  return CHIP_TINT[kind as AgentKind] ?? CHIP_TINT_FALLBACK
}

/** Stacked fleet-summary tile (sidebar issue rows) — carries its own text tone,
 *  which is why it is not the chip resolver above. Total. */
export function agentFleetTileTint(kind: WireHarnessKind): string {
  return FLEET_TILE_TINT[kind as AgentKind] ?? FLEET_TILE_TINT_FALLBACK
}

/**
 * Brand text tone APPENDED to an existing class list, or null for a harness that
 * inherits the surrounding tone.
 *
 * Deliberately not {@link agentGlyphTone}: these call sites used to append
 * nothing at all for non-Claude kinds, so returning `text-foreground` here would
 * override an inherited colour and change pixels.
 */
export function agentBrandText(kind: WireHarnessKind): string | null {
  return BRAND_TEXT[kind as AgentKind] ?? null
}

/** Brand dot shown beside the model token, or null for a harness with no brand
 *  mark of its own (the dot is omitted entirely, as before). */
export function agentBrandDot(kind: WireHarnessKind): string | null {
  return BRAND_DOT[kind as AgentKind] ?? null
}
