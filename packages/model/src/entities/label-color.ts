/** Stored label color names. Labels retain their own optional palette. */
export const LABEL_COLOR_SLOTS = [
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

export type LabelColorSlot = (typeof LABEL_COLOR_SLOTS)[number]

export function isLabelColorSlot(value: unknown): value is LabelColorSlot {
  return typeof value === 'string' && (LABEL_COLOR_SLOTS as readonly string[]).includes(value)
}
