/**
 * The 10-colour issue palette. [spec:SP-b4d1]
 *
 * Issues carry an optional user-assigned colour, picked from these 10 slots via
 * the ID-square colour-picker popover. Persist and transmit the SLOT NAME, not
 * the hex — the palette maps a slot to a full colouring scheme, so hues can be
 * retuned centrally without touching stored data.
 *
 * TOP-LEVEL ONLY (POD-697). The colour names a MISSION: it is what tells the
 * sidebar's rows apart, and everything downstream — flight deck, terminal tint,
 * rail notch — is that one mission's colour flowing. A sub-issue therefore has
 * no slot of its own; it runs under its mission's by inheritance (see
 * {@link effectiveIssueColorHex}). The server enforces it — a sub-issue create
 * drops the field, an update is refused, and gaining a parent clears it — so
 * the pickers are simply not offered below the top level.
 *
 * RESERVED COLOURS — never pickable, never to be reused as issue accents, and
 * conversely never to be used for status:
 *   - amber   #f59e0b (--attention): "waiting on you"
 *   - terracotta #d97757 (--claude): the Claude brand
 *   - calm blue #6f9dff (--live / --motion-working): "agent working" (POD-166
 *     R10 — was green #10b981, which stays retired from the palette too)
 *   - slate   #94a3b8 (--flow): the default no-colour flow accent — a state,
 *     not a choice, so it is absent from the picker.
 * The yellow/orange/amber band is deliberately missing from the palette and red
 * is folded into rose so an issue colour can never be misread as a status.
 * Blue (#3b82f6) and green (#22c55e) palette slots exist alongside the --info /
 * --success status hues — status UI must use the tokens, never these literals.
 *
 * Issue-coloured SURFACES are always color-mix tints over a base surface, never
 * flat fills — see the issue-mix-* / issue-hairline-* / issue-ring utilities in
 * index.css. The one flat use is the solid ID square itself, whose
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

/** The neutral no-colour flow, as a literal hex — for JS colour MATH only
 *  (mixHex and friends, which cannot resolve a custom property). It is the
 *  --flow token of the podium/shadcn dark presets; each Superade variant now
 *  carries its own, because a flow that reads as "no colour chosen" has to
 *  match its ground — a warm taupe on Paper's stone (a blue-grey there is what
 *  makes that palette look broken) and a true grey on Dark Ink's neutral, where
 *  this slate would read as a blue somebody picked. Every CALL SITE should use
 *  FLOW_CSS below; this hex is the last-resort value for a JS mixer, and the
 *  one place it survives (terminal appearance) mixes it at 9%. */
export const FLOW_SLATE = '#94a3b8'

/** The same flow, as a CSS <color> that follows the active theme. Use this
 *  ANYWHERE the value lands in CSS — a `style` value, a color-mix() string, a
 *  custom-property assignment — so the no-colour flow stays warm on paper and
 *  neutral on ink. Only fall back to FLOW_SLATE when the value must be a real
 *  hex a JS mixer can read. */
export const FLOW_CSS = 'var(--flow)'

/** The minimal issue shape colour resolution needs. */
export interface ColorCarrier {
  color?: string | null
  parentId?: string | null
}

/**
 * The colour an issue FLOWS downstream: its own palette colour, else the
 * nearest coloured ancestor's (handoff 1a — POD-129/130 child rows flow
 * POD-128's violet), else undefined = the neutral slate flow. Inheritance is
 * for the flow surfaces only (shell scope, attention rows, terminal tint);
 * identity surfaces — the ID square, the issue's own sidebar row — keep
 * {@link issueColorHex} so an uncoloured child still reads as uncoloured.
 *
 * Since POD-697 only a top-level issue can hold a slot, so in practice the walk
 * always lands on the mission root. The own-colour branch is kept because this
 * function must stay correct against a wire that still carries a legacy slot on
 * a sub-issue, and because promoting a sub-issue to top level makes its own
 * colour meaningful again the moment it is set.
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
