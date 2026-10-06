/** Prebuilt Rust hosts for the four release platforms (SPEC v4 A2/H5).
 * Linux links static musl; both macOS builds link against zig's libSystem stubs
 * and are ad-hoc signed. Customer machines only execute the resulting payload.
 * The crate owns the Rust pin; root mise.toml owns zig and rcodesign.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HEADLESS_PLATFORMS,
  type HeadlessPlatform,
  isHeadlessPlatform,
} from '../packages/protocol/src/update/platforms'
import { hostBinaryName, RUST_HOST_BINARY } from '../packages/pty/src/host-bin.js'
import { sharedCacheDir } from './shared-cache-dir'
import { resolveRcodesign, resolveZig } from './tool-pins'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const RUST_HOST_CRATE = join(REPO_ROOT, 'packages/pty/vendor/podium-host')

export const RUST_HOST_TARGETS: Record<HeadlessPlatform, { rustTarget: string; darwin: boolean }> =
  {
    'linux-x86_64': { rustTarget: 'x86_64-unknown-linux-musl', darwin: false },
    'linux-aarch64': { rustTarget: 'aarch64-unknown-linux-musl', darwin: false },
    'darwin-aarch64': { rustTarget: 'aarch64-apple-darwin', darwin: true },
    'darwin-x86_64': { rustTarget: 'x86_64-apple-darwin', darwin: true },
  }

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? sourceFiles(path) : [path]
    })
    .sort()
}

/** Sources (including nested modules), dependencies, pins and build/sign flags. */
export function rustHostSourceHash(crate = RUST_HOST_CRATE, root = REPO_ROOT): string {
  const hash = createHash('sha256')
  for (const path of [
    join(crate, 'Cargo.toml'),
    join(crate, 'Cargo.lock'),
    join(crate, 'rust-toolchain.toml'),
    join(crate, 'mise.toml'),
    ...['build.rs', '.cargo/config.toml'].map((name) => join(crate, name)).filter(existsSync),
    ...sourceFiles(join(crate, 'src')),
  ]) {
    hash.update(`${relative(crate, path)}\n`)
    hash.update(readFileSync(path))
  }
  hash.update(readFileSync(join(root, 'mise.toml')))
  hash.update(readFileSync(fileURLToPath(import.meta.url)))
  return hash.digest('hex')
}

export function rustHostCacheDir(root = REPO_ROOT): string {
  const override = process.env.PODIUM_RUST_HOST_CACHE_DIR?.trim()
  return override ? resolve(root, override) : sharedCacheDir('podium-host', root)
}

export function rustHostCachePath(
  platform: HeadlessPlatform,
  sourceHash: string,
  root = REPO_ROOT,
): string {
  return join(rustHostCacheDir(root), `${platform}-${sourceHash.slice(0, 16)}`)
}

function rustChannel(crate: string): string {
  const channel = readFileSync(join(crate, 'rust-toolchain.toml'), 'utf8').match(
    /^channel\s*=\s*"([^"]+)"\s*$/m,
  )?.[1]
  if (!channel) throw new Error('rust-host-cross: missing crate Rust channel')
  return channel
}

function hasTool(binary: string): boolean {
  return spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0
}

export function crossBuildRustHost(
  platform: HeadlessPlatform,
  opts: { root?: string; crate?: string; force?: boolean } = {},
): string {
  const root = opts.root ?? REPO_ROOT
  const crate = opts.crate ?? RUST_HOST_CRATE
  const spec = RUST_HOST_TARGETS[platform]
  const out = rustHostCachePath(platform, rustHostSourceHash(crate, root), root)
  if (!opts.force && existsSync(out)) {
    console.log(`[rust-host-cross] ${platform}: cached ${out}`)
    return out
  }
  for (const binary of ['rustup', 'cargo-zigbuild']) {
    if (!hasTool(binary))
      throw new Error(`rust-host-cross: ${binary} is required; run mise install in ${crate}`)
  }
  const channel = rustChannel(crate)
  const zig = resolveZig()
  // Explicit toolchain selection survives mise's root RUSTUP_TOOLCHAIN override
  // (the tunnel uses another Rust channel). Run cargo from the crate itself.
  execFileSync('rustup', ['target', 'add', '--toolchain', channel, spec.rustTarget], {
    cwd: crate,
    stdio: 'inherit',
  })
  execFileSync(
    'rustup',
    ['run', channel, 'cargo', 'zigbuild', '--release', '--locked', '--target', spec.rustTarget],
    {
      cwd: crate,
      stdio: 'inherit',
      env: {
        ...process.env,
        CARGO_ZIGBUILD_ZIG_PATH: zig,
        CARGO_TARGET_DIR: join(crate, 'target'),
        // Keep inherited build flags from changing bytes behind a cache hit.
        CARGO_ENCODED_RUSTFLAGS: undefined,
        RUSTFLAGS: spec.darwin ? '-C link-arg=-Wl,-headerpad,0x8000' : undefined,
      },
    },
  )
  mkdirSync(rustHostCacheDir(root), { recursive: true })
  const staged = `${out}.new-${process.pid}`
  try {
    copyFileSync(join(crate, 'target', spec.rustTarget, 'release', 'podium-host'), staged)
    chmodSync(staged, 0o755)
    if (spec.darwin) {
      execFileSync(resolveRcodesign(), ['sign', '--binary-identifier', RUST_HOST_BINARY, staged], {
        stdio: 'inherit',
      })
    }
    renameSync(staged, out)
  } finally {
    rmSync(staged, { force: true })
  }
  console.log(`[rust-host-cross] ${platform}: ${out} (${readFileSync(out).length} bytes)`)
  return out
}

/**
 * The Rust host for a local (this-machine) bundle, built with this host's own cargo.
 * No fallback: the Rust host is the only durable process host a POSIX bundle has, so
 * a machine without the crate's toolchain cannot package one and says so.
 */
export function buildLocalRustHost(crate = RUST_HOST_CRATE): string {
  if (!hasTool('rustup')) {
    throw new Error(
      'rust-host-cross: rustup is required to build the Rust process host; ' +
        `run mise install in ${crate}`,
    )
  }
  execFileSync('rustup', ['run', rustChannel(crate), 'cargo', 'build', '--release', '--locked'], {
    cwd: crate,
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: join(crate, 'target') },
  })
  return join(crate, 'target', 'release', hostBinaryName())
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.includes('--print-cache-dir')) {
    console.log(rustHostCacheDir())
    return
  }
  const requested = args
    .filter((arg) => arg.startsWith('--platform='))
    .map((arg) => arg.slice('--platform='.length))
  for (const platform of requested) {
    if (!isHeadlessPlatform(platform))
      throw new Error(`rust-host-cross: unknown platform '${platform}'`)
  }
  for (const platform of (requested.length
    ? requested
    : HEADLESS_PLATFORMS) as HeadlessPlatform[]) {
    crossBuildRustHost(platform, { force: args.includes('--force') })
  }
}

if (import.meta.main) main()
