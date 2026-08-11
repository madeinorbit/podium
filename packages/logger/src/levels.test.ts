import { describe, expect, it } from 'vitest'
import { isLevel, LEVELS, meetsThreshold, moreVerbose, parseLevel } from './levels'

describe('levels', () => {
  it('orders the five levels from most to least severe', () => {
    expect(LEVELS).toEqual(['error', 'warn', 'info', 'debug', 'trace'])
  })

  it('admits a record at or above the threshold', () => {
    expect(meetsThreshold('error', 'info')).toBe(true)
    expect(meetsThreshold('info', 'info')).toBe(true)
  })

  it('rejects a record below the threshold', () => {
    expect(meetsThreshold('debug', 'info')).toBe(false)
    expect(meetsThreshold('trace', 'error')).toBe(false)
  })

  it('picks the more verbose of two thresholds', () => {
    expect(moreVerbose('warn', 'trace')).toBe('trace')
    expect(moreVerbose('debug', 'error')).toBe('debug')
    expect(moreVerbose('info', 'info')).toBe('info')
  })

  it('parses a level name case-insensitively and ignores surrounding space', () => {
    expect(parseLevel('  DEBUG ')).toBe('debug')
  })

  it('returns null for a string that is not a level', () => {
    expect(parseLevel('verbose')).toBeNull()
    expect(parseLevel(undefined)).toBeNull()
  })

  it('narrows an unknown string with isLevel', () => {
    expect(isLevel('trace')).toBe(true)
    expect(isLevel('TRACE')).toBe(false)
  })
})
