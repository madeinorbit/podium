import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_PLATFORMS } from '../packages/protocol/src/update/platforms'
import {
  crossBuildRustHost,
  RUST_HOST_TARGETS,
  rustHostCachePath,
  rustHostSourceHash,
} from './rust-host-cross'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock('./tool-pins', () => ({
  resolveZig: () => '/tools/zig',
  resolveRcodesign: () => '/tools/rcodesign',
}))

describe('Rust host release cross-builds', () => {
  let root: string
  let crate: string
  const savedCache = process.env.PODIUM_RUST_HOST_CACHE_DIR
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ph-cross-'))
    crate = join(root, 'crate')
    mkdirSync(join(crate, 'src', 'nested'), { recursive: true })
    writeFileSync(join(root, 'mise.toml'), '[tools]\nzig = "0.16.0"\n')
    writeFileSync(join(crate, 'Cargo.toml'), '[package]\nname = "podium-host"\n')
    writeFileSync(join(crate, 'Cargo.lock'), '# locked dependencies\n')
    writeFileSync(join(crate, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.98.1"\n')
    writeFileSync(join(crate, 'mise.toml'), '[tools]\nrust = { version = "1.98.1" }\n')
    writeFileSync(join(crate, 'src', 'main.rs'), 'fn main() {}\n')
    writeFileSync(join(crate, 'src', 'nested', 'screen.rs'), '// screen\n')
    process.env.PODIUM_RUST_HOST_CACHE_DIR = join(root, 'cache')
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
    vi.mocked(execFileSync).mockImplementation((file, args, opts) => {
      if (file === 'rustup' && args?.includes('zigbuild')) {
        const target = args[args.indexOf('--target') + 1] as string
        const out = join(crate, 'target', target, 'release', 'podium-host')
        mkdirSync(join(crate, 'target', target, 'release'), { recursive: true })
        writeFileSync(out, `host for ${target}`)
        expect(opts?.cwd).toBe(crate)
      }
      return Buffer.alloc(0)
    })
  })
  afterEach(() => {
    if (savedCache === undefined) delete process.env.PODIUM_RUST_HOST_CACHE_DIR
    else process.env.PODIUM_RUST_HOST_CACHE_DIR = savedCache
    rmSync(root, { recursive: true, force: true })
    vi.resetAllMocks()
  })

  it('cross-builds all four release targets with the crate Rust pin and signs both Macs', () => {
    expect(RUST_HOST_TARGETS).toEqual({
      'linux-x86_64': { rustTarget: 'x86_64-unknown-linux-musl', darwin: false },
      'linux-aarch64': { rustTarget: 'aarch64-unknown-linux-musl', darwin: false },
      'darwin-aarch64': { rustTarget: 'aarch64-apple-darwin', darwin: true },
      'darwin-x86_64': { rustTarget: 'x86_64-apple-darwin', darwin: true },
    })
    for (const platform of HEADLESS_PLATFORMS) {
      const spec = RUST_HOST_TARGETS[platform]
      const path = crossBuildRustHost(platform, { root, crate })
      expect(readFileSync(path, 'utf8')).toBe(`host for ${spec.rustTarget}`)
      expect(execFileSync).toHaveBeenCalledWith(
        'rustup',
        ['target', 'add', '--toolchain', '1.98.1', spec.rustTarget],
        expect.objectContaining({ cwd: crate }),
      )
      expect(execFileSync).toHaveBeenCalledWith(
        'rustup',
        [
          'run',
          '1.98.1',
          'cargo',
          'zigbuild',
          '--release',
          '--locked',
          '--target',
          spec.rustTarget,
        ],
        expect.objectContaining({
          cwd: crate,
          env: expect.objectContaining({
            CARGO_ZIGBUILD_ZIG_PATH: '/tools/zig',
            ...(spec.darwin ? { RUSTFLAGS: expect.stringContaining('-headerpad,0x8000') } : {}),
          }),
        }),
      )
    }
    const signatures = vi
      .mocked(execFileSync)
      .mock.calls.filter(([file]) => file === '/tools/rcodesign')
    expect(signatures).toHaveLength(2)
    for (const [, args] of signatures) {
      expect(args?.slice(0, 3)).toEqual(['sign', '--binary-identifier', 'podium-host'])
    }
  })

  it('invalidates cached binaries for dependency, nested source and toolchain changes', () => {
    let hash = rustHostSourceHash(crate, root)
    for (const path of [
      join(crate, 'Cargo.toml'),
      join(crate, 'Cargo.lock'),
      join(crate, 'src', 'nested', 'screen.rs'),
      join(crate, 'rust-toolchain.toml'),
      join(crate, 'mise.toml'),
      join(root, 'mise.toml'),
    ]) {
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n# changed\n`)
      const next = rustHostSourceHash(crate, root)
      expect(next).not.toBe(hash)
      hash = next
    }
  })

  it('reuses a content-addressed binary without requiring a toolchain', () => {
    const path = rustHostCachePath('linux-aarch64', rustHostSourceHash(crate, root), root)
    mkdirSync(join(root, 'cache'), { recursive: true })
    writeFileSync(path, 'cached host')
    expect(crossBuildRustHost('linux-aarch64', { root, crate })).toBe(path)
    expect(spawnSync).not.toHaveBeenCalled()
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('leaves no published binary when a build fails', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('link failed')
    })
    expect(() => crossBuildRustHost('linux-x86_64', { root, crate })).toThrow('link failed')
    expect(
      existsSync(rustHostCachePath('linux-x86_64', rustHostSourceHash(crate, root), root)),
    ).toBe(false)
  })
})
