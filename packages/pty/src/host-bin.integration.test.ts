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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildVendoredHost,
  defaultHostCachePath,
  ensureManagedHost,
  HOST_FEATURES,
  hostBinFeatures,
  managedHostDir,
  resolveHostBin,
  vendoredHostSourceHash,
} from './host-bin.js'

/**
 * SPEC-6 item 15: the managed podium-host build — builds when missing or stale,
 * publishes atomically, serialises concurrent builders, and an explicit
 * PODIUM_HOST_BIN override that does not run fails loudly. Mirrors the R1 and C9
 * suites of abduco-bin.test.ts.
 */

const hasCompiler = ['cc', 'gcc', 'clang'].some((c) => {
  try {
    return spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
})

const MODULE_PATH = fileURLToPath(new URL('./host-bin.ts', import.meta.url))
const PKG_ROOT = dirname(dirname(MODULE_PATH))
const childRoot = (): string => mkdtempSync(join(PKG_ROOT, '.host-child-'))

/** A runnable binary that is NOT a podium-host: answers nothing useful to `version`. */
function fakeForeign(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'podium-host')
  writeFileSync(p, '#!/bin/sh\necho "something else 1.0"\nexit 0\n')
  chmodSync(p, 0o755)
  return p
}

describe('podium-host binary resolution', () => {
  const savedState = process.env.PODIUM_STATE_DIR
  const savedExplicit = process.env.PODIUM_HOST_BIN
  afterEach(() => {
    if (savedState === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = savedState
    if (savedExplicit === undefined) delete process.env.PODIUM_HOST_BIN
    else process.env.PODIUM_HOST_BIN = savedExplicit
    resolveHostBin({ fresh: true })
  })

  it('cache and managed paths follow PODIUM_STATE_DIR', () => {
    process.env.PODIUM_STATE_DIR = '/x/state'
    expect(defaultHostCachePath()).toBe('/x/state/bin/podium-host')
    expect(managedHostDir()).toBe(`/x/state/bin/podium-host-v${HOST_FEATURES}`)
  })

  it('an explicit PODIUM_HOST_BIN that does not run FAILS resolution (no silent fallback)', () => {
    process.env.PODIUM_HOST_BIN = '/nonexistent/podium-host'
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
  })

  it('an explicit PODIUM_HOST_BIN that runs but is not a podium-host FAILS resolution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-host-foreign-'))
    try {
      process.env.PODIUM_HOST_BIN = fakeForeign(dir)
      expect(hostBinFeatures(process.env.PODIUM_HOST_BIN)).toBe(0)
      expect(resolveHostBin({ fresh: true })).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('memoizes; { fresh: true } re-resolves', () => {
    process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-host-memo-'))
    const first = resolveHostBin({ fresh: true })
    process.env.PODIUM_HOST_BIN = '/nonexistent/podium-host'
    expect(resolveHostBin()).toBe(first)
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
    rmSync(process.env.PODIUM_STATE_DIR, { recursive: true, force: true })
  }, 60000)
})

describe('podium-host on Windows', () => {
  const realPlatform = process.platform
  const stubPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }
  afterEach(() => {
    stubPlatform(realPlatform)
    resolveHostBin({ fresh: true })
  })
  it('resolves to nothing and refuses to build', () => {
    stubPlatform('win32')
    process.env.PODIUM_HOST_BIN = '/nonexistent/podium-host'
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
    delete process.env.PODIUM_HOST_BIN
    expect(buildVendoredHost(join(tmpdir(), 'never-built'))).toBeUndefined()
  })
})

describe.skipIf(!hasCompiler)('vendored podium-host build', () => {
  it('compiles into a working binary that reports its feature level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-host-build-'))
    try {
      const out = buildVendoredHost(join(dir, 'bin', 'podium-host'))
      expect(out).toBeDefined()
      expect(hostBinFeatures(out as string)).toBe(HOST_FEATURES)
      const r = spawnSync(out as string, ['version'], { encoding: 'utf8' })
      expect(r.stdout.trim()).toBe(`podium-host ${HOST_FEATURES}-podium features=${HOST_FEATURES}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)
})

describe.skipIf(!hasCompiler)('managed podium-host build', () => {
  let state: string
  const savedState = process.env.PODIUM_STATE_DIR
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'podium-host-state-'))
    process.env.PODIUM_STATE_DIR = state
  })
  afterEach(() => {
    if (savedState === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = savedState
    rmSync(state, { recursive: true, force: true })
    resolveHostBin({ fresh: true })
  })

  it('builds once, then reuses; a stale sourceHash rebuilds', () => {
    const first = ensureManagedHost()
    expect(first).toEqual({ bin: join(managedHostDir(), 'podium-host'), built: true })
    expect(ensureManagedHost()?.built).toBe(false)

    const manifestPath = join(managedHostDir(), 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      features: number
      sourceHash: string
    }
    expect(manifest.features).toBe(HOST_FEATURES)
    expect(manifest.sourceHash).toBe(vendoredHostSourceHash())

    writeFileSync(manifestPath, JSON.stringify({ ...manifest, sourceHash: 'stale' }))
    expect(ensureManagedHost()?.built).toBe(true)
    expect(
      (JSON.parse(readFileSync(manifestPath, 'utf8')) as { sourceHash: string }).sourceHash,
    ).toBe(vendoredHostSourceHash())
  }, 90000)

  it('rebuilds when the managed binary itself is not a podium-host any more', () => {
    expect(ensureManagedHost()?.built).toBe(true)
    fakeForeign(managedHostDir())
    expect(ensureManagedHost()?.built).toBe(true)
    expect(hostBinFeatures(join(managedHostDir(), 'podium-host'))).toBe(HOST_FEATURES)
  }, 90000)

  it('publishes binary + manifest together and leaves no partial state behind', () => {
    ensureManagedHost()
    writeFileSync(
      join(managedHostDir(), 'manifest.json'),
      JSON.stringify({ features: 1, sourceHash: 'stale' }),
    )
    expect(ensureManagedHost()?.built).toBe(true)
    const dir = managedHostDir()
    expect(existsSync(join(dir, 'podium-host'))).toBe(true)
    expect(
      (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { sourceHash: string })
        .sourceHash,
    ).toBe(vendoredHostSourceHash())
    expect(readdirSync(join(state, 'bin')).filter((f) => f.startsWith('.'))).toEqual([])
  }, 90000)

  it('points the documented cache path at the managed build, and resolveHostBin finds it', () => {
    ensureManagedHost()
    expect(realpathSync(defaultHostCachePath())).toBe(
      realpathSync(join(managedHostDir(), 'podium-host')),
    )
    expect(resolveHostBin({ fresh: true })).toBe(join(managedHostDir(), 'podium-host'))
  }, 90000)

  it('resolveHostBin builds the managed host when nothing is on disk', () => {
    expect(existsSync(managedHostDir())).toBe(false)
    expect(resolveHostBin({ fresh: true })).toBe(join(managedHostDir(), 'podium-host'))
    expect(existsSync(join(managedHostDir(), 'manifest.json'))).toBe(true)
  }, 90000)

  it('concurrent builders serialize — exactly one compiles, both get the binary', async () => {
    const body = `const r = A.ensureManagedHost(); console.log(JSON.stringify(r ?? null))`
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
      expect(results.every((r) => r?.bin === join(managedHostDir(), 'podium-host'))).toBe(true)
      expect(results.filter((r) => r?.built === true)).toHaveLength(1)
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  }, 120000)
})
