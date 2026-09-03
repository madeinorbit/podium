import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABDUCO_FEATURES,
  abducoBinFeatures,
  buildVendoredAbduco,
  defaultAbducoCachePath,
  ensureManagedAbduco,
  managedAbducoDir,
  resolveAbducoBin,
  vendoredAbducoSourceHash,
} from './abduco-bin.js'

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
// ---------------------------------------------------------------------------
// R1 — a managed binary that actually runs [spec:SP-6144]
//
// The point of the feature stamp is that podium's PATCHED abduco is what runs.
// On a machine with a distro abduco (or a cache from an older podium) the old
// order silently preferred the unpatched binary, so a patch could land and never
// execute. These tests pin the order that prevents that.
//
// PATH order MUST be exercised in a child process: under Bun, spawnSync resolves
// a bare name against the PATH the process STARTED with, so mutating
// process.env.PATH in-process makes `runs('abduco')` tests pass vacuously.
// ---------------------------------------------------------------------------

const MODULE_URL = new URL('./abduco-bin.ts', import.meta.url)
const MODULE_PATH = fileURLToPath(MODULE_URL)
const PKG_ROOT = dirname(dirname(MODULE_PATH))
// Children must sit inside the repo so `@podium/runtime/config` resolves.
const childRoot = (): string => mkdtempSync(join(PKG_ROOT, '.abduco-child-'))
const isBun = process.versions.bun !== undefined

/** An upstream (unpatched) abduco: runs, but has no --podium-features option. */
function fakeUpstreamAbduco(dir: string, name = 'abduco'): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(
    p,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  -v) echo "abduco-0.6 (c) 2013-2018"; exit 0;;',
      'esac',
      'echo "abduco: invalid option" >&2',
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(p, 0o755)
  return p
}

/** Run a snippet against the real module in a fresh process with a given env. */
function inChild(body: string, env: Record<string, string | undefined>): string {
  const dir = childRoot()
  try {
    const file = join(dir, 'child.ts')
    writeFileSync(file, `import * as A from ${JSON.stringify(MODULE_PATH)}\n${body}\n`)
    const r = spawnSync(process.execPath, [file], {
      encoding: 'utf8',
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    })
    if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`)
    return (r.stdout ?? '').trim().split('\n').pop() ?? ''
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!hasCompiler)('abduco feature stamp', () => {
  it('a podium build answers --podium-features; an upstream one does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-abduco-feat-'))
    try {
      const out = buildVendoredAbduco(join(dir, 'bin', 'abduco')) as string
      expect(out).toBeDefined()
      expect(abducoBinFeatures(out)).toBe(ABDUCO_FEATURES)
      expect(abducoBinFeatures(fakeUpstreamAbduco(join(dir, 'sys')))).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)
})

describe.skipIf(!hasCompiler)('managed abduco build', () => {
  let state: string
  const savedState = process.env.PODIUM_STATE_DIR
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'podium-abduco-state-'))
    process.env.PODIUM_STATE_DIR = state
  })
  afterEach(() => {
    if (savedState === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = savedState
    rmSync(state, { recursive: true, force: true })
    resolveAbducoBin({ fresh: true })
  })

  it('builds once, then reuses; a stale sourceHash rebuilds', () => {
    const first = ensureManagedAbduco()
    expect(first).toEqual({ bin: join(managedAbducoDir(), 'abduco'), built: true })
    expect(ensureManagedAbduco()?.built).toBe(false) // verified, not rebuilt

    const manifestPath = join(managedAbducoDir(), 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      features: number
      sourceHash: string
    }
    expect(manifest.features).toBe(ABDUCO_FEATURES)
    expect(manifest.sourceHash).toBe(vendoredAbducoSourceHash())

    writeFileSync(manifestPath, JSON.stringify({ ...manifest, sourceHash: 'stale' }))
    expect(ensureManagedAbduco()?.built).toBe(true) // the sources moved on
    expect(
      (JSON.parse(readFileSync(manifestPath, 'utf8')) as { sourceHash: string }).sourceHash,
    ).toBe(vendoredAbducoSourceHash())
  }, 90000)

  it('rebuilds when the managed binary itself lost the feature', () => {
    expect(ensureManagedAbduco()?.built).toBe(true)
    // A binary that no longer answers the probe cannot be trusted whatever its
    // manifest says — verification runs the binary on every selection.
    fakeUpstreamAbduco(managedAbducoDir())
    expect(ensureManagedAbduco()?.built).toBe(true)
    expect(abducoBinFeatures(join(managedAbducoDir(), 'abduco'))).toBe(ABDUCO_FEATURES)
  }, 90000)

  it('publishes binary + manifest together and leaves no partial state behind', () => {
    ensureManagedAbduco()
    // Rebuild over the live directory, the case where a half-publish would show.
    writeFileSync(
      join(managedAbducoDir(), 'manifest.json'),
      JSON.stringify({ features: 1, sourceHash: 'stale' }),
    )
    expect(ensureManagedAbduco()?.built).toBe(true)

    const dir = managedAbducoDir()
    expect(existsSync(join(dir, 'abduco'))).toBe(true)
    expect(
      (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { sourceHash: string })
        .sourceHash,
    ).toBe(vendoredAbducoSourceHash())
    // No staging dir, displaced dir, or lock survives a completed build.
    expect(readdirSync(join(state, 'bin')).filter((f) => f.startsWith('.'))).toEqual([])
  }, 90000)

  it('points the documented cache path at the managed build', () => {
    ensureManagedAbduco()
    expect(realpathSync(defaultAbducoCachePath())).toBe(
      realpathSync(join(managedAbducoDir(), 'abduco')),
    )
  }, 90000)

  it('concurrent builders serialize — exactly one compiles, both get the binary', async () => {
    const body = `const r = A.ensureManagedAbduco({ requireFeatures: A.ABDUCO_FEATURES }); console.log(JSON.stringify(r ?? null))`
    const dirs = [childRoot(), childRoot()]
    try {
      const results = await Promise.all(
        dirs.map(
          (dir) =>
            new Promise<{ bin: string; built: boolean } | null>((resolve, reject) => {
              const file = join(dir, 'child.ts')
              writeFileSync(file, `import * as A from ${JSON.stringify(MODULE_PATH)}\n${body}\n`)
              const p = spawn(process.execPath, [file], {
                env: { ...process.env, PODIUM_STATE_DIR: state } as NodeJS.ProcessEnv,
              })
              let out = ''
              let err = ''
              p.stdout.on('data', (d) => {
                out += d
              })
              p.stderr.on('data', (d) => {
                err += d
              })
              p.on('close', (code) =>
                code === 0
                  ? resolve(JSON.parse(out.trim().split('\n').pop() as string))
                  : reject(new Error(`child ${code}: ${err}`)),
              )
            }),
        ),
      )
      expect(results.every((r) => r?.bin === join(managedAbducoDir(), 'abduco'))).toBe(true)
      expect(results.filter((r) => r?.built === true)).toHaveLength(1)
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  }, 120000)
})

describe.skipIf(!hasCompiler)('selection when a feature is required', () => {
  let state: string
  let sys: string
  const savedState = process.env.PODIUM_STATE_DIR
  const savedExplicit = process.env.PODIUM_ABDUCO
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'podium-abduco-sel-'))
    sys = join(state, 'sysbin')
    fakeUpstreamAbduco(sys)
    process.env.PODIUM_STATE_DIR = state
  })
  afterEach(() => {
    // Never unset: the suite's hermetic guard refuses a ~/.podium fallback.
    if (savedState === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = savedState
    if (savedExplicit === undefined) delete process.env.PODIUM_ABDUCO
    else process.env.PODIUM_ABDUCO = savedExplicit
    rmSync(state, { recursive: true, force: true })
    resolveAbducoBin({ fresh: true })
  })

  it('an explicit PODIUM_ABDUCO without the feature FAILS LOUDLY (no silent fallback)', () => {
    const explicit = join(sys, 'abduco')
    const errs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.join(' '))
    })
    try {
      process.env.PODIUM_ABDUCO = explicit
      expect(resolveAbducoBin({ fresh: true, requireFeatures: 1 })).toBeUndefined()
      expect(errs.join('\n')).toContain(explicit)
      // Without a required feature the same override is honoured — today's order.
      expect(resolveAbducoBin({ fresh: true })).toBe(explicit)
    } finally {
      spy.mockRestore()
    }
  })

  it.skipIf(!isBun)(
    'a system abduco without the feature is skipped for the managed build',
    () => {
      // PATH must be set for the child at spawn time; see the note above.
      const env = {
        PATH: `${sys}:/usr/bin:/bin`,
        PODIUM_STATE_DIR: state,
        PODIUM_ABDUCO: undefined,
      }
      const required = inChild(
        `console.log(JSON.stringify(A.resolveAbducoBin({ fresh: true, requireFeatures: A.ABDUCO_FEATURES }) ?? null))`,
        env,
      )
      expect(JSON.parse(required)).toBe(join(state, 'bin', `abduco-v${ABDUCO_FEATURES}`, 'abduco'))

      // ...and with no feature required, that same system binary still wins.
      const plain = inChild(
        `console.log(JSON.stringify(A.resolveAbducoBin({ fresh: true }) ?? null))`,
        env,
      )
      expect(JSON.parse(plain)).toBe('abduco')
    },
    120000,
  )
})
