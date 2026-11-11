/** The approved root header transition is reversible opacity only, over 44pt. */
export function rootHeaderProgress(offset: number): number {
  'worklet'
  return Math.max(0, Math.min(1, offset / 44))
}
