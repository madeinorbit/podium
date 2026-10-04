/** Braille-cell geometry shared by the native and web marks. */
export const WORKING_MARK_DOTS: readonly (readonly [number, number])[] = [
  [17, 18],
  [49, 18],
  [17, 39],
  [49, 39],
  [17, 61],
  [49, 61],
  [17, 82],
  [49, 82],
]

export function workingMarkRadius(size: number): number {
  return size >= 18 ? 9.5 : size >= 14 ? 10.5 : 11
}

export interface WorkingMarkProps {
  /** Cell height in px; width follows the 66:100 cell. */
  size?: number
  tint?: string
  /** Set null where adjacent text already announces the working state. */
  label?: string | null
}
