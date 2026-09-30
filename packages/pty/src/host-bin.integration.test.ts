import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureSourceRustHost,
  HOST_FEATURES,
  hostBinFeatures,
  resolveHostBin,
  RUST_HOST_BINARY,
  sourceRustHostCacheDir,
  vendoredRustHostSourceHash,
} from './host-bin.js'

/**
 * RUST HOST RESOLUTION (POD-4986). The Rust host is the only podium-host a new
 * spawn selects: an explicit PODIUM_HOST_BIN at feature level 2, the release
 * payload's podium-host-rs, or — in a source checkout — the vendored crate
 * built with cargo into a cache keyed by its source hash. Nothing else, and no
 * fallback: a C host (feature 1) is refused, and when nothing resolves the
 * resolver says why and returns undefined.
 *
 * The source-build machinery is driven here with a fake crate and a fake
 * `cargo` on PATH, so the build, publish, reuse and serialisation are proven
 * hermetically; the real crate build is the last suite.
 */

const MODULE_PATH = fileURLToPath(new URL('./host-bin.ts', import.meta.url))
const PKG_ROOT = dirname(dirname(MODULE_PATH))

function fakeHost(path: string, features: number): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho "podium-host test features=${features}"\n`)
  chmodSync(path, 0o755)
  return path
}

/** A runnable binary that is NOT a podium-host: answers nothing useful to `version`. */
function fakeForeign(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '#!/bin/sh\necho "something else 1.0"\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

const ENV_KEYS = [
  'PODIUM_STATE_DIR',
  'PODIUM_HOST_BIN',
  'PODIUM_HOME',
  'PODIUM_HOST_SOCKET_DIR',
  'PODIUM_NO_SCOPE',
  'PODIUM_RUST_HOST_BUILD_DIR',
  'PATH',
] as const

function useScratchEnv(): { root: () => string } {
  let root = ''
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ph-resolve-'))
    process.env.PODIUM_STATE_DIR = join(root, 'state')
    process.env.PODIUM_HOME = join(root, 'payload')
    process.env.PODIUM_HOST_SOCKET_DIR = join(root, 's')
    process.env.PODIUM_NO_SCOPE = '1'
    process.env.PODIUM_RUST_HOST_BUILD_DIR = join(root, 'build')
    delete process.env.PODIUM_HOST_BIN
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resolveHostBin({ fresh: true })
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })
  return { root: () => root }
}

/** Publish a fake host where the source rung looks for the vendored crate's build. */
function publishSourceHost(features: number): string {
  const hash = vendoredRustHostSourceHash() as string
  return fakeHost(join(sourceRustHostCacheDir() as string, hash.slice(0, 16), RUST_HOST_BINARY), features)
}

describe('Rust host resolution (POD-4986)', () => {
  const { root } = useScratchEnv()
  const payload = (): string => join(root(), 'payload', RUST_HOST_BINARY)

  it('requires feature level 2, the Rust screen host', () => {
    expect(HOST_FEATURES).toBe(2)
  })

  it('this checkout is a source checkout: the vendored crate hashes', () => {
    expect(vendoredRustHostSourceHash()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses the release payload host', () => {
    const rust = fakeHost(payload(), 2)
    publishSourceHost(2)
    expect(resolveHostBin({ fresh: true })).toBe(rust)
  })

  it('uses the source build when the payload has no host', () => {
    const built = publishSourceHost(2)
    expect(resolveHostBin({ fresh: true })).toBe(built)
  })

  it('never selects a C host (feature 1) from the payload; the source build wins', () => {
    fakeHost(payload(), 1)
    const built = publishSourceHost(2)
    expect(resolveHostBin({ fresh: true })).toBe(built)
  })

  it('refuses an explicit C host (feature 1) with no fallback', () => {
    fakeHost(payload(), 2)
    publishSourceHost(2)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.PODIUM_HOST_BIN = fakeHost(join(root(), 'explicit-c'), 1)
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
    expect(error.mock.calls.flat().join('\n')).toMatch(/feature level 2\. Refusing to fall back/)
  })

  it('honors an explicit Rust host', () => {
    process.env.PODIUM_HOST_BIN = fakeHost(join(root(), 'explicit-rust'), 2)
    expect(resolveHostBin({ fresh: true })).toBe(process.env.PODIUM_HOST_BIN)
  })

  it('does not hide an invalid explicit override behind the shipped host', () => {
    fakeHost(payload(), 2)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.PODIUM_HOST_BIN = join(root(), 'missing')
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
    process.env.PODIUM_HOST_BIN = fakeForeign(join(root(), 'foreign'))
    expect(hostBinFeatures(process.env.PODIUM_HOST_BIN)).toBe(0)
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
  })

  it('fails LOUDLY when there is no payload host and nothing can build one', () => {
    process.env.PATH = join(root(), 'empty-path')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
    const said = error.mock.calls.flat().join('\n')
    expect(said).toContain(`${payload()} does not exist`)
    expect(said).toMatch(/neither rustup nor cargo runs here/)
    expect(said).toMatch(/refuses to start sessions/)
  })

  it('fails loudly when the build cache cannot be created', () => {
    process.env.PODIUM_RUST_HOST_BUILD_DIR = '/proc/self/no-such-dir/build'
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
    expect(error.mock.calls.flat().join('\n')).toMatch(/cannot create \/proc\/self\/no-such-dir\/build/)
  })

  it('memoizes; { fresh: true } re-resolves', () => {
    const first = fakeHost(payload(), 2)
    expect(resolveHostBin({ fresh: true })).toBe(first)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.PODIUM_HOST_BIN = join(root(), 'missing')
    expect(resolveHostBin()).toBe(first)
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
  })
})

describe('the source build (fake crate, fake cargo)', () => {
  const { root } = useScratchEnv()

  /**
   * A crate with a Cargo.toml and a src/, and a `cargo` that "builds" it by
   * writing a feature-2 host into $CARGO_TARGET_DIR/release/podium-host. It
   * logs every invocation, and sleeps so two builders really overlap.
   */
  function fakeToolchain(): { crate: string; log: string } {
    const crate = join(root(), 'crate')
    mkdirSync(join(crate, 'src'), { recursive: true })
    writeFileSync(join(crate, 'Cargo.toml'), '[package]\nname = "podium-host"\n')
    writeFileSync(join(crate, 'src', 'main.rs'), 'fn main() {}\n')
    const bin = join(root(), 'bin')
    const log = join(root(), 'cargo.log')
    mkdirSync(bin, { recursive: true })
    writeFileSync(
      join(bin, 'cargo'),
      [
        '#!/bin/sh',
        '[ "$1" = "--version" ] && { echo "cargo fake"; exit 0; }',
        `echo "$*" >> ${JSON.stringify(log)}`,
        'sleep 1',
        'mkdir -p "$CARGO_TARGET_DIR/release"',
        'printf \'#!/bin/sh\\necho "podium-host fake features=2"\\n\' > "$CARGO_TARGET_DIR/release/podium-host"',
        'chmod 755 "$CARGO_TARGET_DIR/release/podium-host"',
        '',
      ].join('\n'),
    )
    chmodSync(join(bin, 'cargo'), 0o755)
    process.env.PATH = `${bin}:/usr/bin:/bin`
    return { crate, log }
  }

  const builds = (log: string): number =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0

  it('builds once, publishes by source hash, then reuses', () => {
    const { crate, log } = fakeToolchain()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hash = vendoredRustHostSourceHash(crate) as string
    const dir = join(root(), 'build', hash.slice(0, 16))
    expect(ensureSourceRustHost(crate)).toEqual({ bin: join(dir, RUST_HOST_BINARY), built: true })
    expect(readFileSync(log, 'utf8')).toContain('build --release --locked')
    expect(ensureSourceRustHost(crate)).toEqual({ bin: join(dir, RUST_HOST_BINARY), built: false })
    expect(builds(log)).toBe(1)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ features: 2, sourceHash: hash })
    // Nothing half-published is left beside the build.
    expect(readdirSync(join(root(), 'build')).filter((f) => f.startsWith('.'))).toEqual([])
  }, 30_000)

  it('a source change builds again, under the new hash', () => {
    const { crate, log } = fakeToolchain()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = ensureSourceRustHost(crate)
    writeFileSync(join(crate, 'src', 'main.rs'), 'fn main() { /* changed */ }\n')
    const second = ensureSourceRustHost(crate)
    expect(second?.built).toBe(true)
    expect(second?.bin).not.toBe(first?.bin)
    expect(builds(log)).toBe(2)
  }, 30_000)

  it('a published binary that is not a feature-2 host is rebuilt', () => {
    const { crate, log } = fakeToolchain()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = ensureSourceRustHost(crate)?.bin as string
    fakeForeign(first)
    expect(ensureSourceRustHost(crate)?.built).toBe(true)
    expect(hostBinFeatures(first)).toBe(2)
    expect(builds(log)).toBe(2)
  }, 30_000)

  it('concurrent builders serialize — exactly one builds, both get the binary', async () => {
    const { crate, log } = fakeToolchain()
    const body = `const r = A.ensureSourceRustHost(${JSON.stringify(crate)}); console.log(JSON.stringify(r ?? null))`
    const dirs = [mkdtempSync(join(PKG_ROOT, '.host-child-')), mkdtempSync(join(PKG_ROOT, '.host-child-'))]
    try {
      const results = await Promise.all(
        dirs.map(
          (dir) =>
            new Promise<{ bin: string; built: boolean } | null>((resolve, reject) => {
              const file = join(dir, 'child.ts')
              writeFileSync(file, `import * as A from ${JSON.stringify(MODULE_PATH)}\n${body}\n`)
              const p = spawn(process.execPath, [file], { env: { ...process.env } })
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
      const bin = join(root(), 'build', (vendoredRustHostSourceHash(crate) as string).slice(0, 16), RUST_HOST_BINARY)
      expect(results.every((r) => r?.bin === bin)).toBe(true)
      expect(results.filter((r) => r?.built === true)).toHaveLength(1)
      expect(builds(log)).toBe(1)
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  }, 60_000)

  it('a failing build says why and publishes nothing', () => {
    const { crate } = fakeToolchain()
    writeFileSync(join(root(), 'bin', 'cargo'), '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho "error[E0000]: boom" >&2\nexit 101\n')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ensureSourceRustHost(crate)).toBeUndefined()
    expect(existsSync(join(root(), 'build', (vendoredRustHostSourceHash(crate) as string).slice(0, 16)))).toBe(false)
    // resolveHostBin reports the vendored crate's failure the same way.
    process.env.PODIUM_RUST_HOST_BUILD_DIR = join(root(), 'build2')
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
    expect(error.mock.calls.flat().join('\n')).toMatch(/the source build failed: cargo build --release --locked failed:\nerror\[E0000\]: boom/)
  })
})

describe('podium-host on Windows', () => {
  const realPlatform = process.platform
  const stubPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }
  afterEach(() => {
    stubPlatform(realPlatform)
    delete process.env.PODIUM_HOST_BIN
    resolveHostBin({ fresh: true })
  })
  it('resolves to nothing and builds nothing', () => {
    stubPlatform('win32')
    process.env.PODIUM_HOST_BIN = '/nonexistent/podium-host'
    expect(resolveHostBin({ fresh: true })).toBeUndefined()
    delete process.env.PODIUM_HOST_BIN
    expect(ensureSourceRustHost()).toBeUndefined()
  })
})

describe('the vendored crate (real cargo)', () => {
  it('builds (or reuses) a host that reports feature level 2', () => {
    const r = ensureSourceRustHost()
    expect(r).toBeDefined()
    expect(hostBinFeatures(r?.bin as string)).toBe(HOST_FEATURES)
  }, 600_000)
})
