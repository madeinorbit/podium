/**
 * Issue colour palette [spec:SP-b4d1] — the 10 user-pickable colour SLOTS.
 *
 * An issue stores the slot NAME (e.g. 'violet'), never a hex: the palette maps
 * each slot to a full colouring scheme (row tints, glows, chrome mixes — see
 * .design/specs/colour-flow.md), so schemes can be retuned without touching
 * stored data. Unset = no colour = the neutral slate flow.
 *
 * Spectrum order is frozen design data (.design/podium-handoff.html 4b). The
 * amber/orange band is deliberately absent (amber #f59e0b = "waiting on you",
 * #D97757 = Claude, #6f9dff = working (calm blue, POD-166) — an issue colour must never be
 * confusable with a status); red is folded into rose; slate #94a3b8 is the
 * no-colour flow, not a pickable slot.
 *
 * Structural on purpose (no @podium/protocol import: domain is a zero-dependency
 * leaf). The wire enum in @podium/protocol mirrors this list; a drift test in
 * apps/server pins the two.
 */

export const ISSUE_COLOR_SLOTS = [
  'rose',
  'pink',
  'fuchsia',
  'violet',
  'indigo',
  'blue',
  'cyan',
  'teal',
  'green',
  'lime',
] as const

export type IssueColorSlot = (typeof ISSUE_COLOR_SLOTS)[number]

/** Each slot's base hex — the `C` every colouring-scheme mix derives from. */
export const ISSUE_COLOR_HEX: Record<IssueColorSlot, string> = {
  rose: '#f43f5e',
  pink: '#ec4899',
  fuchsia: '#d946ef',
  violet: '#8b5cf6',
  indigo: '#6366f1',
  blue: '#3b82f6',
  cyan: '#06b6d4',
  teal: '#14b8a6',
  green: '#22c55e',
  lime: '#84cc16',
}

/** The no-colour flow's neutral base (not a pickable slot). */
export const ISSUE_COLOR_SLATE = '#94a3b8'

export function isIssueColorSlot(v: unknown): v is IssueColorSlot {
  return typeof v === 'string' && (ISSUE_COLOR_SLOTS as readonly string[]).includes(v)
}
