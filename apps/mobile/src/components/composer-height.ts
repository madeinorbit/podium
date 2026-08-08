import { font, leading } from '../theme/theme'

/**
 * Composer field geometry [POD-502].
 *
 * The field is height-controlled rather than free-flowing: react-native-web
 * renders `multiline` as a `<textarea>`, which never grows with its content, so
 * a long prompt used to wrap inside a permanently 45px box. Both targets now
 * report the content height (native through `onContentSizeChange`, web through
 * ./composer-measure.web) and the number lands here to be clamped.
 *
 * Every function takes the CURRENT line height rather than reading the token,
 * because Dynamic Type moves it. A fixed six-line cap computed from the default
 * leading shows four lines at the largest accessibility sizes — the operators
 * who can least afford a keyhole get the smallest one.
 */

/** One typed line at body size and the default text size. */
export const COMPOSER_LINE = leading(font.body)

/** How far the field grows before it stops and scrolls inside itself. */
export const COMPOSER_MAX_LINES = 6

export const COMPOSER_MIN_HEIGHT = COMPOSER_LINE

export function composerMaxHeight(line: number = COMPOSER_LINE): number {
  return composerLine(line) * COMPOSER_MAX_LINES
}

/**
 * The field height for a measured content height.
 *
 * An unmeasured field rests at one line rather than collapsing: a measurement
 * is missing before the first layout, and on web it reads 0 in environments
 * with no layout engine at all.
 */
export function composerFieldHeight(
  measured: number | null | undefined,
  line: number = COMPOSER_LINE,
): number {
  const min = composerLine(line)
  if (measured == null || !Number.isFinite(measured) || measured <= 0) return min
  return Math.min(Math.max(Math.round(measured), min), composerMaxHeight(line))
}

/** Whether the content has passed the cap and the field now scrolls internally. */
export function composerScrolls(
  measured: number | null | undefined,
  line: number = COMPOSER_LINE,
): boolean {
  return composerFieldHeight(measured, line) >= composerMaxHeight(line)
}

/**
 * A measured line height, or the token when the measurement is missing or
 * absurd — a zero would collapse the composer and a runaway would uncap it.
 */
function composerLine(line: number): number {
  if (!Number.isFinite(line) || line < COMPOSER_LINE) return COMPOSER_LINE
  return Math.min(line, COMPOSER_LINE * 3)
}
