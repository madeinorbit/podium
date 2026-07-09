import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildVendoredAbduco, defaultAbducoCachePath, resolveAbducoBin } from './abduco-bin.js'

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    return spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
})

describe('abduco binary resolution', () => {
  const savedState = process.env.PODIUM_STATE_DIR
  const savedExplicit = process.env.PODIUM_ABDUCO
  afterEach(() => {
    if (savedState === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = savedState
    if (savedExplicit === undefined) delete process.env.PODIUM_ABDUCO
    else process.env.PODIUM_ABDUCO = savedExplicit
    resolveAbducoBin({ fresh: true }) // restore the memo for other suites
  })

  it('cache path follows PODIUM_STATE_DIR, else ~/.podium', () => {
    process.env.PODIUM_STATE_DIR = '/x/state'
    expect(defaultAbducoCachePath()).toBe('/x/state/bin/abduco')
    delete process.env.PODIUM_STATE_DIR
    expect(defaultAbducoCachePath()).toMatch(/\/\.podium\/bin\/abduco$/)
  })

  it('an explicit PODIUM_ABDUCO that does not run FAILS resolution (no silent fallback)', () => {
    process.env.PODIUM_ABDUCO = '/nonexistent/abduco'
    expect(resolveAbducoBin({ fresh: true })).toBeUndefined()
  })

  it('memoizes; { fresh: true } re-resolves', () => {
    const first = resolveAbducoBin({ fresh: true })
    process.env.PODIUM_ABDUCO = '/nonexistent/abduco'
    expect(resolveAbducoBin()).toBe(first) // memo ignores the env change
    expect(resolveAbducoBin({ fresh: true })).toBeUndefined()
  })
})

describe('abduco on Windows', () => {
  const realPlatform = process.platform
  const stubPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }
  afterEach(() => {
    stubPlatform(realPlatform)
    resolveAbducoBin({ fresh: true }) // restore the memo for other suites
  })

  it('resolveAbducoBin is undefined on win32 without probing anything', () => {
    stubPlatform('win32')
    // A PODIUM_ABDUCO override must not matter: abduco is POSIX-only (forkpty),
    // so even an explicit path can never be a working abduco on Windows.
    process.env.PODIUM_ABDUCO = '/bin/sh' // something that WOULD pass runs() elsewhere
    try {
      expect(resolveAbducoBin({ fresh: true })).toBeUndefined()
    } finally {
      delete process.env.PODIUM_ABDUCO
    }
  })

  it('buildVendoredAbduco refuses to build on win32', () => {
    stubPlatform('win32')
    const dir = mkdtempSync(join(tmpdir(), 'podium-abduco-win-'))
    try {
      expect(buildVendoredAbduco(join(dir, 'bin', 'abduco'))).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!hasCompiler)('vendored abduco build', () => {
  it('compiles the vendored source into a working binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-abduco-build-'))
    try {
      const out = buildVendoredAbduco(join(dir, 'bin', 'abduco'))
      expect(out).toBeDefined()
      const v = spawnSync(out as string, ['-v'], { encoding: 'utf8' })
      expect(v.status).toBe(0)
      expect(`${v.stdout}${v.stderr}`).toContain('abduco')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})
