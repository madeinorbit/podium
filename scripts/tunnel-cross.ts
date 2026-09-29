/**
 * Build podium-tunnel (native/podium-tunnel, Rust) for every headless release
 * platform, from one Linux box (POD-4640).
 *
 * The same shape as scripts/host-cross.ts, for the same reasons: one runner builds
 * all four targets, the output is content-addressed on the source so a restored
 * cache is either exactly right or invisible, and Darwin binaries get the same
 * rcodesign ad-hoc signature (Apple Silicon refuses to execute an unsigned Mach-O).
 *
 * THE LINKER IS ZIG, THROUGH cargo-zigbuild. Rust's own toolchain supplies the
 * compiler and standard library for every target, and for Linux musl it could link
 * alone. macOS is the reason for zig: linking a Mach-O needs Apple's libSystem stubs,
 * which rustup does not ship and zig does — so no Apple SDK and no Mac runner. rustc
 * prints a warning that it could not ask `xcrun` for an SDK; that is expected, and
 * the link succeeds against zig's stubs. Linux links static musl, so the binary has
 * no glibc floor, like the C helpers.
 *
 * Toolchain: `rust` and cargo-zigbuild are pinned in mise.toml; the Rust channel is
 * also named in native/podium-tunnel/rust-toolchain.toml, and each build adds its
 * target with `rustup target add`.
 *
 *   bun scripts/tunnel-cross.ts                       # all four, into the cache
 *   bun scripts/tunnel-cross.ts --platform=linux-aarch64 --force
 *   bun scripts/tunnel-cross.ts --print-cache-dir
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HEADLESS_PLATFORMS,
  type HeadlessPlatform,
  isHeadlessPlatform,
} from '../packages/protocol/src/update/platforms'
import { sharedCacheDir } from './shared-cache-dir'
import { resolveRcodesign, resolveZig } from './tool-pins'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const TUNNEL_CRATE = join(REPO_ROOT, 'native/podium-tunnel')
export const TUNNEL_BINARY = 'podium-tunnel'

export type TunnelTargetSpec = {
  /** Rust target triple. */
  rustTarget: string
  darwin: boolean
}

export const TUNNEL_TARGETS: Record<HeadlessPlatform, TunnelTargetSpec> = {
  'linux-x86_64': { rustTarget: 'x86_64-unknown-linux-musl', darwin: false },
  'linux-aarch64': { rustTarget: 'aarch64-unknown-linux-musl', darwin: false },
  'darwin-aarch64': { rustTarget: 'aarch64-apple-darwin', darwin: true },
  'darwin-x86_64': { rustTarget: 'x86_64-apple-darwin', darwin: true },
}

/** Every input that changes the binary: manifest, lockfile, toolchain pin, sources. */
function tunnelInputs(crate: string): string[] {
  const src = join(crate, 'src')
  return [
    join(crate, 'Cargo.toml'),
    join(crate, 'Cargo.lock'),
    join(crate, 'rust-toolchain.toml'),
    ...readdirSync(src)
      .filter((name) => name.endsWith('.rs'))
      .sort()
      .map((name) => join(src, name)),
  ]
}

export function tunnelSourceHash(crate: string = TUNNEL_CRATE): string {
  const h = createHash('sha256')
  for (const file of tunnelInputs(crate)) {
    h.update(`${file.slice(crate.length)}\n`)
    h.update(readFileSync(file))
  }
  return h.digest('hex')
}

/** `PODIUM_TUNNEL_CACHE_DIR` overrides it, as PODIUM_HOST_CACHE_DIR does for podium-host. */
export function tunnelCacheDir(root: string = REPO_ROOT): string {
  const override = process.env.PODIUM_TUNNEL_CACHE_DIR?.trim()
  if (override) return resolve(root, override)
  return sharedCacheDir('podium-tunnel', root)
}

export function tunnelCachePath(
  platform: HeadlessPlatform,
  sourceHash: string,
  root: string = REPO_ROOT,
): string {
  return join(tunnelCacheDir(root), `${platform}-${sourceHash.slice(0, 16)}`)
}

function requireTool(binary: string, why: string): void {
  if (spawnSync(binary, ['--version'], { stdio: 'ignore' }).status !== 0) {
    throw new Error(
      `tunnel-cross: ${binary} is required ${why} but was not found. Run \`mise install\`.`,
    )
  }
}

/** Build (or reuse) podium-tunnel for one platform and return its path. */
export function crossBuildTunnel(
  platform: HeadlessPlatform,
  opts: { root?: string; force?: boolean; crate?: string } = {},
): string {
  const root = opts.root ?? REPO_ROOT
  const crate = opts.crate ?? TUNNEL_CRATE
  const spec = TUNNEL_TARGETS[platform]
  const out = tunnelCachePath(platform, tunnelSourceHash(crate), root)
  if (!opts.force && existsSync(out)) {
    console.log(`[tunnel-cross] ${platform}: cached ${out}`)
    return out
  }
  requireTool('cargo', 'to build podium-tunnel')
  requireTool('cargo-zigbuild', 'to cross-link podium-tunnel')
  requireTool('rustup', 'to add the target standard library')
  const zig = resolveZig()
  // Idempotent and quick once installed. Explicit rather than listed in the crate's
  // rust-toolchain.toml, which would make every local `cargo test` fetch all four.
  execFileSync('rustup', ['target', 'add', spec.rustTarget], { cwd: crate, stdio: 'inherit' })
  mkdirSync(tunnelCacheDir(root), { recursive: true })
  console.log(`[tunnel-cross] ${platform}: cargo zigbuild --target ${spec.rustTarget}`)
  execFileSync(
    'cargo',
    [
      'zigbuild',
      '--release',
      '--locked',
      '--target',
      spec.rustTarget,
      '--manifest-path',
      join(crate, 'Cargo.toml'),
    ],
    {
      // From the crate, so rustup reads its rust-toolchain.toml.
      cwd: crate,
      stdio: 'inherit',
      env: {
        ...process.env,
        // cargo-zigbuild finds zig here; the pinned one, never whatever is on PATH.
        CARGO_ZIGBUILD_ZIG_PATH: zig,
        // Room in the Mach-O header for the signature rcodesign writes below; without
        // it x86_64 fails with "insufficient room to write code signature load
        // command". The same pad host-cross.ts gives the C helper.
        ...(spec.darwin ? { RUSTFLAGS: '-C link-arg=-Wl,-headerpad,0x8000' } : {}),
      },
    },
  )
  const built = join(crate, 'target', spec.rustTarget, 'release', TUNNEL_BINARY)
  const staged = `${out}.new-${process.pid}`
  execFileSync('cp', ['-f', built, staged])
  chmodSync(staged, 0o755)
  if (spec.darwin) {
    console.log(`[tunnel-cross] ${platform}: rcodesign ad-hoc sign`)
    execFileSync(resolveRcodesign(), ['sign', '--binary-identifier', TUNNEL_BINARY, staged], {
      stdio: 'inherit',
    })
    chmodSync(staged, 0o755)
  }
  execFileSync('mv', ['-f', staged, out])
  console.log(`[tunnel-cross] ${platform}: ${out} (${readFileSync(out).length} bytes)`)
  return out
}

/**
 * A local (non-release) build: the host's own target with plain `cargo build`.
 * Returns undefined when this machine has no Rust toolchain, so a developer
 * without cargo still gets a bundle — just one whose `podium tunnel enable`
 * explains that podium-tunnel is missing.
 */
export function buildLocalTunnel(crate: string = TUNNEL_CRATE): string | undefined {
  if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) return undefined
  execFileSync(
    'cargo',
    ['build', '--release', '--locked', '--manifest-path', join(crate, 'Cargo.toml')],
    {
      cwd: crate,
      stdio: 'inherit',
    },
  )
  return join(crate, 'target', 'release', TUNNEL_BINARY)
}

function main(): void {
  const argv = process.argv.slice(2)
  if (argv.includes('--print-cache-dir')) {
    console.log(tunnelCacheDir())
    return
  }
  const force = argv.includes('--force')
  const requested = argv
    .filter((a) => a.startsWith('--platform='))
    .map((a) => a.slice('--platform='.length))
  for (const value of requested) {
    if (!isHeadlessPlatform(value)) {
      throw new Error(
        `tunnel-cross: unknown platform '${value}' (want ${HEADLESS_PLATFORMS.join(' | ')})`,
      )
    }
  }
  const platforms = (requested.length > 0 ? requested : HEADLESS_PLATFORMS) as HeadlessPlatform[]
  console.log(`[tunnel-cross] source sha256 ${tunnelSourceHash()}`)
  for (const platform of platforms) crossBuildTunnel(platform, { force })
}

if (import.meta.main) main()
