import { ISSUE_COLOR_HEX, ISSUE_COLOR_SLATE, type IssueColorSlot } from '@podium/domain'
import { mix } from './mix'

/**
 * The issue-accent "colour flow" for native surfaces. [spec:SP-b4d1]
 *
 * Palette slots and hexes come from @podium/domain (the same source the web
 * shell uses); this module adds the native-side derivations the web gets from
 * CSS `color-mix()` — see ./mix.ts. Tint percentages mirror the web's
 * issue-mix-* utilities so a surface recipe produces identical pixels on both
 * renderers.
 *
 * RESERVED COLOURS — never pickable, never reused as issue accents, never used
 * for status: Superade Yellow #f5c518 (attention/signal), terracotta #d97757
 * (Claude), Accent Blue #2f6bff (working). Slate #94a3b8 is the default
 * no-colour flow accent — a state, not a choice.
 */

/** The neutral no-colour flow slate — same value as the web --flow token. */
export const FLOW_SLATE = ISSUE_COLOR_SLATE

/** Slot name → hex; undefined for unknown/absent names (= no colour assigned). */
export function issueColorHex(name: string | null | undefined): string | undefined {
  if (!name) return undefined
  return ISSUE_COLOR_HEX[name as IssueColorSlot]
}

/** The minimal issue shape colour resolution needs. */
export interface ColorCarrier {
  color?: string | null
  parentId?: string | null
}

/**
 * The colour an issue FLOWS downstream: its own palette colour, else the
 * nearest coloured ancestor's, else undefined = the neutral slate flow.
 * Identity surfaces (the ID square itself) use {@link issueColorHex} so an
 * uncoloured child still reads as uncoloured.
 */
export function effectiveIssueColorHex(
  issue: ColorCarrier | undefined,
  byId: (id: string) => ColorCarrier | undefined,
): string | undefined {
  const seen = new Set<string>()
  let current = issue
  while (current) {
    const own = issueColorHex(current.color)
    if (own) return own
    const parentId = current.parentId
    if (!parentId || seen.has(parentId)) return undefined
    seen.add(parentId)
    current = byId(parentId)
  }
  return undefined
}

/** Text on a solid issue-colour fill (ID squares): 30% mix into black. */
export function issueSquareFg(hex: string): string {
  return mix(hex, 30, '#000000')
}

/**
 * The per-surface tint recipes of the colour flow (colour-flow spec §2 — the
 * same percentages the web's issue-mix utilities use). `c` is the flowing
 * colour; pass {@link FLOW_SLATE} when the issue has none.
 */
export const flow = {
  /** Workspace pane behind content: 10% over the app bg. */
  paneBg: (c: string) => mix(c, 10, '#0a0f1c'),
  /** Tinted chrome bar (session header): 16% over the card surface. */
  headerBg: (c: string) => mix(c, 16, '#121b30'),
  /** Stronger pane-chrome bar: 24% over the app bg. */
  paneHeaderBg: (c: string) => mix(c, 24, '#0a0f1c'),
  /** Unselected coloured list row: ~12% over the card surface. */
  rowBg: (c: string) => mix(c, 12, '#121b30'),
  /** Selected list row: 28% over the card surface (+ .8-alpha border). */
  rowSelectedBg: (c: string) => mix(c, 28, '#121b30'),
  /** Active row inside a panel menu: 18% over the card surface. */
  rowActiveBg: (c: string) => mix(c, 18, '#121b30'),
  /** Near-white tinted title text (ctxText). */
  text: (c: string) => mix(c, 8, '#f3f3f8'),
  /** Tinted body text. */
  body: (c: string) => mix(c, 22, '#d7d7e0'),
  /** Tinted muted text (ctxMuted). */
  muted: (c: string) => mix(c, 18, '#9a9aa8'),
} as const
