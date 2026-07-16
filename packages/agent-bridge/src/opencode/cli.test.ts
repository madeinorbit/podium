import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isOpencodeCliAvailable, resolveOpencodeBin, validateOpencodeCliHelp } from './cli.js'

// Real-binary detection tests: self-skip when opencode isn't installed (clean CI
// runners), mirroring cursor/cli.test.ts. The skip condition is the code under
// test, so a broken resolver still fails loudly on any machine that HAS opencode.
const home = process.env.HOME ?? homedir()
const homeInstall = join(home, '.opencode', 'bin', 'opencode')

describe('opencode CLI detection', () => {
  it.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !isOpencodeCliAvailable())('detects the installed opencode binary', () => {
    expect(isOpencodeCliAvailable()).toBe(true)
    expect(validateOpencodeCliHelp()).toBe(true)
  })

  it.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !existsSync(homeInstall))('prefers ~/.opencode/bin over bare opencode on PATH', () => {
    expect(resolveOpencodeBin(home)).toBe(homeInstall)
  })
})
