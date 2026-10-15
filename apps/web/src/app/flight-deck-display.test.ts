import { describe, expect, it } from 'vitest'
import {
  isComplexFlightDeckMission,
  nextFlightDeckDisplayForSessionPick,
  readFlightDeckDisplay,
  flightDeckSizing,
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

  it('makes Full wide reachable while keeping development view geometry and stores independent', () => {
    const full = flightDeckSizing(true, 'expanded')
    const waterfall = flightDeckSizing(false, 'expanded')
    expect(full.defaultWidth).toBeGreaterThanOrEqual(860)
    expect(full.max).toBe(1120)
    expect(waterfall).toMatchObject({ min: 540, max: 760, defaultWidth: 680 })
    expect(full.storageKey).not.toBe(waterfall.storageKey)
    expect(flightDeckSizing(true, 'compact').storageKey).not.toBe(flightDeckSizing(false, 'compact').storageKey)
    expect(flightDeckSizing(false, 'compact')).toMatchObject({ storageKey: 'podium:superagent:width', min: 300, max: 620, defaultWidth: 366 })
  })

  it.each([300, 320, 359, 360, 439, 440, 559, 560, 620])('preserves a valid compact width of %i', width => {
    expect(readFlightDeckWidth(String(width), true, 'compact')).toBe(width)
    expect(readFlightDeckWidth(String(width), false, 'compact')).toBe(width)
  })

  it.each([540, 559, 560, 680, 760, 859, 860, 900, 1120])('preserves Full expanded width %i through reopen', width => {
    expect(readFlightDeckWidth(String(width), true, 'expanded')).toBe(width)
  })

  it.each([null, '', 'NaN', 'Infinity', '-1', '299', '1121'])('rejects invalid saved widths %s', raw => {
    expect(readFlightDeckWidth(raw, true, 'expanded')).toBe(900)
    expect(readFlightDeckWidth(raw, false, 'expanded')).toBe(680)
  })

  it('does not impose Full expansion on Waterfall or Timeline widths', () => {
    expect(readFlightDeckWidth('900', false, 'expanded')).toBe(680)
    expect(readFlightDeckWidth('760', false, 'expanded')).toBe(760)
    expect(readFlightDeckWidth('620', true, 'compact')).toBe(620)
    expect(readFlightDeckWidth('621', true, 'compact')).toBe(366)
  })
})
