import { describe, expect, it } from 'vitest'
import {
  isComplexFlightDeckMission,
  nextFlightDeckDisplayForSessionPick,
  readFlightDeckDisplay,
} from './flight-deck-display'

describe('Flight Deck display contract', () => {
  it('defaults complex epics to expanded and ordinary work to compact', () => {
    expect(isComplexFlightDeckMission({ type: 'epic', childCount: 2 })).toBe(true)
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
})
