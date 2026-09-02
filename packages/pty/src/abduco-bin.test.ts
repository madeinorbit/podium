import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * C9 — the resolution ORDER, executed (POD-3235, spec artifact SPEC-0b.md rev 2).
 *
 * `locate()` and `runs()` are private, so the order is exercised the way the
 * daemon meets it: real executables, a real cache under a temp
 * `PODIUM_STATE_DIR`, and a real `PATH`. No mocking of `node:child_process` — a
 * stubbed `spawnSync` would be a second implementation of the very predicate
 * under test.
 *
 * IN A CHILD PROCESS, and that is not ceremony. `runs()` calls `spawnSync(bin,
 * ['-v'])` with no explicit `env`, and under Bun that resolves a bare name
 * against the PATH the process was STARTED with — mutating `process.env.PATH`
 * in-process changes nothing. A same-process test would therefore have measured
 * this host's installed abduco no matter what it set, and passed vacuously.
 */
describe('C9: abduco resolution order', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const runtimeIsBun = (() => {
    try {
      const out = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' })
      return out.status === 0 && !/^v\d/.test((out.stdout ?? '').trim())
    } catch {
      return false
    }
  })()

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `podium-abduco-${prefix}-`))
    dirs.push(dir)
    return dir
  }
  /** A real, runnable stand-in that answers `-v` with whatever version we like. */
  function fakeAbduco(
    prefix: string,
    version: string,
  ): { bin: string; binDir: string; state: string } {
    const state = scratch(prefix)
    const binDir = join(state, 'bin')
    mkdirSync(binDir, { recursive: true })
    const bin = join(binDir, 'abduco')
    writeFileSync(bin, `#!/bin/sh\necho "${version}"\nexit 0\n`)
    chmodSync(bin, 0o755)
    return { bin, binDir, state }
  }

  /** Run the REAL resolveAbducoBin in a child with exactly this environment. */
  function resolveIn(env: Record<string, string | undefined>): string | null {
    const dir = scratch('probe')
    const probe = join(dir, 'probe.ts')
    const target = fileURLToPath(new URL('./abduco-bin.ts', import.meta.url))
    writeFileSync(
      probe,
      `import { resolveAbducoBin } from ${JSON.stringify(target)}\n` +
        "process.stdout.write('<<<' + JSON.stringify(resolveAbducoBin({ fresh: true }) ?? null) + '>>>')\n",
    )
    const clean: Record<string, string> = { HOME: join(dir, 'home') }
    for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value
    const out = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: clean })
    if (out.status !== 0) {
      throw new Error(`probe failed (${out.status}): ${out.stderr}`)
    }
    // The vendored-build path logs to stdout, so fence the answer rather than
    // parsing whatever else the resolution printed on the way.
    const fenced = /<<<([\s\S]*)>>>/.exec(out.stdout)
    if (!fenced) throw new Error(`probe printed no result: ${out.stdout}`)
    return JSON.parse(fenced[1] as string) as string | null
  }

  it.skipIf(!runtimeIsBun)('1. PODIUM_ABDUCO wins over both a PATH abduco and a cached one', () => {
    const explicit = fakeAbduco('explicit', 'abduco-explicit')
    const onPath = fakeAbduco('path', 'abduco-path')
    const cached = fakeAbduco('cache', 'abduco-cache')

    expect(
      resolveIn({
        PODIUM_ABDUCO: explicit.bin,
        PATH: onPath.binDir,
        PODIUM_STATE_DIR: cached.state,
      }),
    ).toBe(explicit.bin)
  })

  it.skipIf(!runtimeIsBun)(
    '2. without PODIUM_ABDUCO, PATH wins over the cache — and resolves to the bare name',
    () => {
      const onPath = fakeAbduco('path', 'abduco-path')
      const cached = fakeAbduco('cache', 'abduco-cache')

      // The bare name, not a resolved path: PATH resolution stays the OS's job.
      expect(resolveIn({ PATH: onPath.binDir, PODIUM_STATE_DIR: cached.state })).toBe('abduco')
    },
  )

  it.skipIf(!runtimeIsBun)('3. with nothing on PATH, the cached binary is used', () => {
    const cached = fakeAbduco('cache', 'abduco-cache')
    expect(resolveIn({ PATH: scratch('empty'), PODIUM_STATE_DIR: cached.state })).toBe(cached.bin)
  })

  it.skipIf(!runtimeIsBun)(
    '4. there is NO version check — any binary that answers `-v` with status 0 is accepted',
    () => {
      // Nonsense in two directions, taken without inspecting what was printed:
      // an incompatible system abduco is adopted silently. Stage 2 (POD-3238)
      // has to reckon with that before relying on behaviour older builds lack.
      const ancient = fakeAbduco('ancient', 'abduco 0.1-ancient')
      expect(resolveIn({ PATH: scratch('empty'), PODIUM_STATE_DIR: ancient.state })).toBe(
        ancient.bin,
      )

      const nonsense = fakeAbduco('nonsense', 'this is not abduco at all')
      expect(resolveIn({ PODIUM_ABDUCO: nonsense.bin, PATH: scratch('empty') })).toBe(nonsense.bin)
    },
  )

  it.skipIf(!runtimeIsBun)(
    '5. an explicit PODIUM_ABDUCO that does not run fails outright — no fallthrough to PATH',
    () => {
      const onPath = fakeAbduco('path', 'abduco-path')
      const missing = join(scratch('gone'), 'not-here')

      expect(resolveIn({ PODIUM_ABDUCO: missing, PATH: onPath.binDir })).toBeNull()
      // ARMING CHECK: with the explicit override gone, the same PATH resolves.
      expect(resolveIn({ PATH: onPath.binDir })).toBe('abduco')
    },
  )

  it.skipIf(!runtimeIsBun || !hasCompiler)(
    '6. with nothing to find, the vendored source is built into the cache path',
    () => {
      const state = scratch('build')
      const resolved = resolveIn({
        PATH: `${scratch('empty')}:/usr/bin:/bin`, // no abduco, but a C compiler
        PODIUM_STATE_DIR: state,
      })
      expect(resolved).toBe(join(state, 'bin', 'abduco'))
      expect(existsSync(resolved as string)).toBe(true)
    },
    120_000,
  )
})
