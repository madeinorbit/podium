/**
 * The 10-colour issue palette. [spec:SP-b4d1]
 *
 * Issues carry an optional user-assigned colour, picked from these 10 slots via
 * the ID-square colour-picker popover. Persist and transmit the SLOT NAME, not
 * the hex — the palette maps a slot to a full colouring scheme, so hues can be
 * retuned centrally without touching stored data.
 *
 * RESERVED COLOURS — never pickable, never to be reused as issue accents, and
 * conversely never to be used for status:
 *   - amber   #f59e0b (--attention): "waiting on you"
 *   - terracotta #d97757 (--claude): the Claude brand
 *   - green   #10b981 (--live): "agent working"
 *   - slate   #94a3b8 (--flow): the default no-colour flow accent — a state,
 *     not a choice, so it is absent from the picker.
 * The yellow/orange/amber band is deliberately missing from the palette and red
 * is folded into rose so an issue colour can never be misread as a status.
 * Blue (#3b82f6) and green (#22c55e) palette slots exist alongside the --info /
 * --success status hues — status UI must use the tokens, never these literals.
 *
 * Issue-coloured SURFACES are always color-mix tints over a base surface, never
 * flat fills — see the issue-mix-* / issue-hairline-* / issue-ring / issue-glow
 * utilities in index.css. The one flat use is the solid ID square itself, whose
 * text colour comes from {@link issueSquareFg}.
 */

export interface IssuePaletteEntry {
  /** Stable slot key — this is what gets persisted on the issue. */
  name: IssueColorName
  hex: string
}

export type IssueColorName =
  | 'rose'
  | 'pink'
  | 'fuchsia'
  | 'violet'
  | 'indigo'
  | 'blue'
  | 'cyan'
  | 'teal'
  | 'green'
  | 'lime'

/** Spectrum-ordered — this is also the colour-picker's display order (5×2 grid). */
export const ISSUE_PALETTE: readonly IssuePaletteEntry[] = [
  { name: 'rose', hex: '#f43f5e' },
  { name: 'pink', hex: '#ec4899' },
  { name: 'fuchsia', hex: '#d946ef' },
  { name: 'violet', hex: '#8b5cf6' },
  { name: 'indigo', hex: '#6366f1' },
  { name: 'blue', hex: '#3b82f6' },
  { name: 'cyan', hex: '#06b6d4' },
  { name: 'teal', hex: '#14b8a6' },
  { name: 'green', hex: '#22c55e' },
  { name: 'lime', hex: '#84cc16' },
] as const

/** Slot name → hex; undefined for unknown/absent names (= no colour assigned). */
export function issueColorHex(name: string | null | undefined): string | undefined {
  if (!name) return undefined
  return ISSUE_PALETTE.find((c) => c.name === name)?.hex
}

/**
 * Text colour on a solid issue-colour fill (ID squares, solid chips): the
 * handoff's formula is a 30% mix of the colour into black. Returns a CSS
 * color-mix() expression — usable anywhere a CSS <color> is accepted.
 */
export function issueSquareFg(hex: string): string {
  return `color-mix(in srgb, ${hex} 30%, #000)`
}

/** The neutral no-colour flow slate — same value as the --flow token. */
export const FLOW_SLATE = '#94a3b8'

/** The minimal issue shape colour resolution needs. */
export interface ColorCarrier {
  color?: string | null
  parentId?: string | null
}

/**
 * The colour an issue FLOWS downstream: its own palette colour, else the
 * nearest coloured ancestor's (handoff 1a — POD-129/130 tray cards flow
 * POD-128's violet), else undefined = the neutral slate flow. Inheritance is
 * for the flow surfaces only (shell scope, tray cards, terminal tint);
 * identity surfaces — the ID square, the issue's own sidebar row — keep
 * {@link issueColorHex} so an uncoloured child still reads as uncoloured.
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
