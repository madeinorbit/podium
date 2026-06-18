import { describe, expect, it } from 'vitest'
import { isOpencodeCliAvailable, validateOpencodeCliHelp } from './cli.js'

describe('opencode CLI detection', () => {
  it('detects the installed opencode binary', () => {
    expect(isOpencodeCliAvailable()).toBe(true)
    expect(validateOpencodeCliHelp()).toBe(true)
  })
})
