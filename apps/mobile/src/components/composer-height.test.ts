import { describe, expect, it } from 'vitest'
import {
  COMPOSER_LINE,
  COMPOSER_MAX_LINES,
  COMPOSER_MIN_HEIGHT,
  composerFieldHeight,
  composerMaxHeight,
  composerScrolls,
} from './composer-height'

describe('composer field height', () => {
  it('rests at one line before anything has been measured', () => {
    for (const unmeasured of [null, undefined, 0, Number.NaN]) {
      expect(composerFieldHeight(unmeasured)).toBe(COMPOSER_MIN_HEIGHT)
    }
    expect(COMPOSER_MIN_HEIGHT).toBe(COMPOSER_LINE)
  })

  it('follows the measured content through six lines', () => {
    for (let lines = 1; lines <= COMPOSER_MAX_LINES; lines++) {
      expect(composerFieldHeight(COMPOSER_LINE * lines)).toBe(COMPOSER_LINE * lines)
    }
  })

  it('caps at six lines and scrolls instead of growing', () => {
    expect(composerScrolls(COMPOSER_LINE * 5)).toBe(false)
    expect(composerFieldHeight(COMPOSER_LINE * 12)).toBe(composerMaxHeight())
    expect(composerScrolls(COMPOSER_LINE * 12)).toBe(true)
  })

  it('never returns a sub-line height for a partial measurement', () => {
    expect(composerFieldHeight(3)).toBe(COMPOSER_MIN_HEIGHT)
    expect(composerFieldHeight(COMPOSER_LINE * 2.4)).toBe(Math.round(COMPOSER_LINE * 2.4))
  })
})

describe('composer cap under Dynamic Type', () => {
  it('still shows six lines when the operator enlarges their text', () => {
    // A fixed cap computed from the default leading would keyhole this down to
    // three lines at the largest accessibility sizes.
    const large = COMPOSER_LINE * 2
    expect(composerMaxHeight(large)).toBe(large * COMPOSER_MAX_LINES)
    expect(composerFieldHeight(large * 4, large)).toBe(large * 4)
    expect(composerScrolls(large * 4, large)).toBe(false)
    expect(composerScrolls(large * 7, large)).toBe(true)
  })

  it('ignores a measured line that is missing, smaller than the token, or absurd', () => {
    for (const bogus of [0, Number.NaN, COMPOSER_LINE - 5]) {
      expect(composerMaxHeight(bogus)).toBe(COMPOSER_LINE * COMPOSER_MAX_LINES)
    }
    expect(composerMaxHeight(COMPOSER_LINE * 40)).toBe(COMPOSER_LINE * 3 * COMPOSER_MAX_LINES)
  })
})
