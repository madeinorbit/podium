import { describe, expect, it } from 'vitest'
import {
  ASCII_COLS as webCols,
  ASCII_COVERAGE as webCoverage,
  ASCII_ROWS as webRows,
} from '../../../web/src/features/setup/podium-ascii'
import { ASCII_COLS, ASCII_COVERAGE, ASCII_ROWS } from './podium-ascii'

/**
 * Mobile login / BootSplash must sample the same wordmark the web login does.
 * The last drift shipped as PODION on the phone (the pre-restore experimental
 * grid) while web already showed PODIUM.
 */
describe('mobile ASCII wordmark lockstep', () => {
  it('matches the web login coverage grid', () => {
    expect(ASCII_COLS).toBe(webCols)
    expect(ASCII_ROWS).toBe(webRows)
    expect(ASCII_COVERAGE).toEqual(webCoverage)
  })
})
