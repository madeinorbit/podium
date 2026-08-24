import { describe, expect, it } from 'vitest'
import { looksLikeChunkLoadFailure } from './chunk-load-failure'

describe('looksLikeChunkLoadFailure', () => {
  /** The three the sandbox actually produced, verbatim. */
  it.each([
    'Failed to fetch dynamically imported module: http://100.113.194.89:32772/assets/SettingsView-WmDcr0IH.js',
    'Failed to fetch dynamically imported module: http://100.113.194.89:32772/assets/switch-g4FTgYGp.js',
    'Failed to fetch dynamically imported module: http://100.113.194.89:32772/assets/MachinesPanel-loW998m3.js',
  ])('recognises %s', (message) => {
    expect(looksLikeChunkLoadFailure(message)).toBe(true)
  })

  it.each([
    ['Firefox', 'error loading dynamically imported module'],
    ['Safari', 'Importing a module script failed.'],
    ['Vite CSS preload', 'Unable to preload CSS for /assets/SpecsView-BU77C3xX.css'],
    ['webpack-era wording', 'Loading chunk 42 failed. (missing: /assets/x.js)'],
  ])('recognises the %s wording', (_engine, message) => {
    expect(looksLikeChunkLoadFailure(message)).toBe(true)
  })

  /**
   * EVERY ORDINARY CRASH STAYS AN ORDINARY CRASH. This is the gate in front of
   * "ask the server whether it swapped builds", and a false positive here spends
   * a request; a false positive further down would offer a reload for a bug that
   * a reload cannot fix.
   */
  it.each([
    'Cannot read properties of undefined (reading map)',
    'Maximum update depth exceeded',
    'No procedure found on path "discovery.scan"',
    'NetworkError when attempting to fetch resource.',
    'The user aborted a request.',
  ])('does not recognise %s', (message) => {
    expect(looksLikeChunkLoadFailure(message)).toBe(false)
  })

  it('says no to nothing at all', () => {
    expect(looksLikeChunkLoadFailure(null)).toBe(false)
    expect(looksLikeChunkLoadFailure(undefined)).toBe(false)
    expect(looksLikeChunkLoadFailure('')).toBe(false)
  })
})
