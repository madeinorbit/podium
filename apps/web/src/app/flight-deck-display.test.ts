import { describe, expect, it } from 'vitest'
import {
  flightDeckSizing,
  isComplexFlightDeckMission,
  nextFlightDeckDisplayForSessionPick,
  readFlightDeckDisplay,
  readFlightDeckWidth,
} from './flight-deck-display'

describe('Flight Deck display contract', () => {
  it('defaults large missions to expanded and ordinary work to compact', () => {
    expect(isComplexFlightDeckMission({ type: 'task', childCount: 6 })).toBe(true)
    expect(isComplexFlightDeckMission({ type: 'task', childCount: 12 })).toBe(true)
    expect(isComplexFlightDeckMission({ type: 'task', childCount: 2 })).toBe(false)
    expect(readFlightDeckDisplay(null, true)).toBe('expanded')
    expect(readFlightDeckDisplay(null, false)).toBe('compact')
  })

  it('honors an explicit persisted choice', () => {
    expect(readFlightDeckDisplay('compact', true)).toBe('compact')
    expect(readFlightDeckDisplay('expanded', false)).toBe('expanded')
  })

  it('contracts an overview pick and expands a repeated compact pick', () => {
    expect(nextFlightDeckDisplayForSessionPick('expanded', 's1', 's1', false)).toBe('compact')
    expect(nextFlightDeckDisplayForSessionPick('compact', 's1', 's1', false)).toBe('expanded')
  })

  it('keeps a different preview and every promotion compact', () => {
    expect(nextFlightDeckDisplayForSessionPick('compact', 's1', 's2', false)).toBe('compact')
    expect(nextFlightDeckDisplayForSessionPick('expanded', 's1', 's2', true)).toBe('compact')
  })

  it('makes Full wide reachable and keeps compact and expanded stores apart', () => {
    const expanded = flightDeckSizing('expanded')
    const compact = flightDeckSizing('compact')
    expect(expanded.defaultWidth).toBeGreaterThanOrEqual(860)
    expect(expanded.max).toBe(1120)
    expect(compact).toMatchObject({ min: 300, max: 620, defaultWidth: 366 })
    expect(compact.storageKey).not.toBe(expanded.storageKey)
  })

  it.each([
    300, 320, 359, 360, 439, 440, 559, 560, 620,
  ])('preserves a valid compact width of %i', (width) => {
    expect(readFlightDeckWidth(String(width), 'compact')).toBe(width)
  })

  it.each([
    540, 559, 560, 680, 760, 859, 860, 900, 1120,
  ])('preserves Full expanded width %i through reopen', (width) => {
    expect(readFlightDeckWidth(String(width), 'expanded')).toBe(width)
  })

  it.each([
    null,
    '',
    'NaN',
    'Infinity',
    '-1',
    '299',
    '1121',
  ])('rejects invalid saved widths %s', (raw) => {
    expect(readFlightDeckWidth(raw, 'expanded')).toBe(900)
  })

  it('caps the compact width', () => {
    expect(readFlightDeckWidth('620', 'compact')).toBe(620)
    expect(readFlightDeckWidth('621', 'compact')).toBe(366)
  })
})
