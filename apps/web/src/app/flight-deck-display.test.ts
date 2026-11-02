import {
  FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY,
  FLIGHT_DECK_FULL_DISPLAY_KEY,
  FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY,
  FLIGHT_DECK_FULL_WIDTH_KEY,
} from '@podium/client-core/ui-state'
import { describe, expect, it } from 'vitest'
import {
  FLIGHT_DECK_SIZING,
  isComplexFlightDeckMission,
  readFlightDeckWidth,
} from './flight-deck-display'

const store =
  (values: Record<string, string>) =>
  (key: string): string | null =>
    values[key] ?? null

describe('Flight Deck width contract', () => {
  it('has one range spanning the old compact and wide ones', () => {
    expect(FLIGHT_DECK_SIZING).toMatchObject({ min: 300, defaultWidth: 366 })
    expect(FLIGHT_DECK_SIZING.max).toBeGreaterThanOrEqual(1120)
    expect(FLIGHT_DECK_SIZING.storageKey).toBe(FLIGHT_DECK_FULL_WIDTH_KEY)
  })

  it.each([300, 366, 620, 621, 860, 1120, 1600])('keeps a saved width of %i', (width) => {
    expect(readFlightDeckWidth(store({ [FLIGHT_DECK_FULL_WIDTH_KEY]: String(width) }))).toBe(width)
  })

  it.each([
    null,
    '',
    ' ',
    'NaN',
    'Infinity',
    '-1',
    '299',
    '1601',
  ])('falls back from an invalid saved width %s', (raw) => {
    const values: Record<string, string> = raw === null ? {} : { [FLIGHT_DECK_FULL_WIDTH_KEY]: raw }
    expect(readFlightDeckWidth(store(values))).toBe(366)
  })

  it('seeds the single width from the mode the user last used', () => {
    const old = {
      [FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY]: '340',
      [FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY]: '940',
    }
    expect(readFlightDeckWidth(store(old))).toBe(340)
    expect(readFlightDeckWidth(store({ ...old, [FLIGHT_DECK_FULL_DISPLAY_KEY]: 'expanded' }))).toBe(
      940,
    )
    expect(readFlightDeckWidth(store({ ...old, [FLIGHT_DECK_FULL_WIDTH_KEY]: '700' }))).toBe(700)
  })

  it('calls a mission with six or more children complex', () => {
    expect(isComplexFlightDeckMission({ type: 'task', childCount: 6 })).toBe(true)
    expect(isComplexFlightDeckMission({ type: 'task', childCount: 2 })).toBe(false)
  })
})
