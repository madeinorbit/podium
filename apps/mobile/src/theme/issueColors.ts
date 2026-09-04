import { ISSUE_COLOR_HEX, type IssueColorSlot } from '@podium/model'
import { mix } from './mix'
import { adaptiveColor, appearancePalette, color } from './theme'

/**
 * The issue-accent "colour flow" for native surfaces. [spec:SP-b4d1]
 *
 * Palette slots and hexes come from @podium/model (the same source the web
 * shell uses); this module adds the native-side derivations the web gets from
 * CSS `color-mix()` — see ./mix.ts. Tint percentages mirror the web's
 * issue-mix-* utilities while each iOS appearance mixes over its own semantic
 * surface base.
 *
 * RESERVED COLOURS — never pickable, never reused as issue accents, never used
 * for status: bisque #d9b477 (the brand accent, and the attention signal it
 * also carries), terracotta #d97757 (Claude), blue #6f9dff/#2a62f0
 * (working/settled). The whole warm accent band is absent from the palette —
 * which covers the retired Superade Yellow #f5c518 as well as bisque — so an
 * issue colour can never be misread as a status. The neutral grey below is the
 * default no-colour flow accent — a state, not a choice.
 */

/**
 * The neutral no-colour flow, as a hex the native mixer can read — the `flow`
 * token, not @podium/model's slate. A flow that reads as "no colour chosen"
 * has to match its ground, and on Dark Ink's neutral chassis the palette's
 * blue-grey slate reads as a blue somebody picked (web: FLOW_CSS/`--flow`).
 */
export const FLOW_HEX = color.flow

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
 * colour; pass {@link FLOW_HEX} when the issue has none.
 *
 * A DOSE IS CAPPED BY THE NEXT SURFACE UP (POD-748, and POD-784 is where it bit
 * here). A mix always walks toward a lighter colour, so a tint that carries its
 * surface past the one above it inverts the ramp. That was survivable on navy,
 * where the ground was #0a0f1c and everything had room above it; Dark Ink lifts
 * the ground to #16171a and leaves only ~10 L-points for the whole eight-tier
 * stack, so the SURFACES UNDER CONTENT — the pane the cards sit on and its
 * chrome bars — are re-dosed to stay under the card tier. Verbatim 10/24/16
 * would put the pane at #232428, level with the #23262d card on top of it, and
 * the cards would simply disappear.
 *
 * The row recipes below keep the handoff's numbers: a row is SUPPOSED to lift
 * off the card it sits on, and that is measured against the card, not the
 * ground.
 */
export const flow = {
  /** Workspace pane behind content — must stay under the tab-strip tier so a
   *  card still reads above it: 4% over the app bg (was the handoff's 10). */
  paneBg: (c: string) => adaptiveMix(c, 4, appearancePalette.light.bg, appearancePalette.dark.bg),
  /** Tinted chrome bar (session header), capped at the raised-cell tier:
   *  8% over the card surface (was 16). */
  headerBg: (c: string) =>
    adaptiveMix(c, 8, appearancePalette.light.surface, appearancePalette.dark.surface),
  /** Stronger pane-chrome bar, capped at the tab-strip tier: 6% over the app
   *  bg (was 24). The cap is set by the BRIGHTEST palette slot rather than by
   *  the neutral flow — lime is the one that reaches the sheet first (it clears
   *  it at 8% while slate is still clear), and a bar may not out-rank the sheet
   *  for SOME issues and not others. */
  paneHeaderBg: (c: string) =>
    adaptiveMix(c, 6, appearancePalette.light.bg, appearancePalette.dark.bg),
  /** Unselected coloured list row: ~12% over the card surface. */
  rowBg: (c: string) =>
    adaptiveMix(c, 12, appearancePalette.light.surface, appearancePalette.dark.surface),
  /** Selected list row: 28% over the card surface (+ .8-alpha border). */
  rowSelectedBg: (c: string) =>
    adaptiveMix(c, 28, appearancePalette.light.surface, appearancePalette.dark.surface),
  /** Active row inside a panel menu: 18% over the card surface. */
  rowActiveBg: (c: string) =>
    adaptiveMix(c, 18, appearancePalette.light.surface, appearancePalette.dark.surface),
  /** Near-white tinted title text (ctxText). */
  text: (c: string) => adaptiveMix(c, 8, appearancePalette.light.text, appearancePalette.dark.text),
  /** Tinted body text. */
  body: (c: string) =>
    adaptiveMix(c, 22, appearancePalette.light.body, appearancePalette.dark.body),
  /** Tinted muted text (ctxMuted). */
  muted: (c: string) => adaptiveMix(c, 18, appearancePalette.light.dim, appearancePalette.dark.dim),
} as const

function adaptiveMix(colour: string, percent: number, lightBase: string, darkBase: string): string {
  return adaptiveColor(mix(colour, percent, lightBase), mix(colour, percent, darkBase))
}
