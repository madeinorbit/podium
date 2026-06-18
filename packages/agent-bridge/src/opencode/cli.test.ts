import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isOpencodeCliAvailable, resolveOpencodeBin, validateOpencodeCliHelp } from './cli.js'

describe('opencode CLI detection', () => {
  it('detects the installed opencode binary', () => {
    expect(isOpencodeCliAvailable()).toBe(true)
    expect(validateOpencodeCliHelp()).toBe(true)
  })

  it('prefers ~/.opencode/bin over bare opencode on PATH', () => {
    const home = process.env.HOME ?? homedir()
    expect(resolveOpencodeBin(home)).toBe(join(home, '.opencode', 'bin', 'opencode'))
  })
})
