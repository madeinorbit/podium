import { describe, expect, it } from 'vitest'
import { parseArgs } from './args.js'

describe('parseArgs', () => {
  it('defaults to both, unlocked', () => {
    expect(parseArgs([])).toEqual({ mode: 'both', lock: false })
  })
  it('reads --mode and --lock', () => {
    expect(parseArgs(['--mode', 'raw'])).toEqual({ mode: 'raw', lock: false })
    expect(parseArgs(['--mode', 'ink', '--lock'])).toEqual({ mode: 'ink', lock: true })
  })
  it('rejects an unknown mode by falling back to both', () => {
    expect(parseArgs(['--mode', 'bogus']).mode).toBe('both')
  })
})
