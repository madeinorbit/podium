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
