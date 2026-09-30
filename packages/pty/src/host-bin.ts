import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@podium/logger'
import { resolveInstallDir } from '@podium/runtime/config'

const log = createLogger('pty:host-bin')

/**
 * podium-host resolution for new spawns. The Rust host is the only podium-host
 * Podium spawns (POD-4986): the C host and abduco are gone from the tree, the
 * build and the release. A session an older daemon started on the C host is not
 * affected — an existing socket attaches directly to its running host, without
 * selecting a binary. Order:
 *   1. $PODIUM_HOST_BIN — explicit binary path; if it doesn't run or is not a
 *      podium-host at feature level {@link HOST_FEATURES}, resolution FAILS (no
 *      silent fallback past operator intent).
 *   2. The release payload's podium-host-rs beside podium-cli.
 *   3. A source checkout (a dev daemon run from the repository): the vendored
 *      crate built with cargo into a per-user cache keyed by the crate's source
 *      hash, so every worktree and state dir shares one build.
 *
 * When none of these yields a host, resolution fails loudly: the reason is
 * printed once and the daemon refuses every spawn with a machine diagnostic.
 * There is no PATH lookup and no fallback host.
 * Windows: unsupported (forkpty).
 */

/**
 * Feature level of the host, reported by `podium-host version` as `features=<n>`
 * and bumped when the protocol or command line gains something callers rely on.
 *
 * 1 — SPEC-6 protocol version 1 (the retired C host; still ADOPTED when running).
 * 2 — the Rust host's screen: WELCOME's features byte and PICTURE (POD-4909).
 */
export const HOST_FEATURES = 2
export const RUST_HOST_BINARY = 'podium-host-rs'

/** Why a spawn has no host; the resolver printed the details when it failed. */
export const HOST_UNAVAILABLE =
  'podium-host unavailable: no Rust podium-host binary could be found or built (see the daemon log)'

const VENDOR_CRATE = fileURLToPath(new URL('../vendor/podium-host-rs', import.meta.url))

/** Prebuilt Rust host shipped beside podium-cli; no customer Rust toolchain. */
export function bundledRustHostPath(): string {
  return join(resolveInstallDir(), RUST_HOST_BINARY)
}

export function hostSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

const VERSION_RE = /^podium-host \S+ features=(\d+)\s*$/m

/** The feature level `bin` reports, or 0 for anything that is not a podium-host. */
export function hostBinFeatures(bin: string): number {
  try {
    const r = spawnSync(bin, ['version'], { encoding: 'utf8' })
    if (r.status !== 0) return 0
    const m = VERSION_RE.exec(r.stdout ?? '')
    const n = m ? Number.parseInt(m[1] as string, 10) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

// ---- the source checkout's build ---------------------------------------------

/**
 * The home the build runs under. Read from the passwd entry, not `$HOME`: tests
 * run daemons under a temporary HOME, and neither the build cache nor cargo's
 * registry and toolchains should move with it.
 */
function buildHome(): string | undefined {
  try {
    return userInfo().homedir || process.env.HOME
  } catch {
    return process.env.HOME
  }
}

/**
 * Where source builds live: `$PODIUM_RUST_HOST_BUILD_DIR`, else
 * `<cache>/podium/podium-host-rs-src`. One cargo target dir for incremental
 * rebuilds plus one directory per source hash holding the published binary.
 */
export function sourceRustHostCacheDir(): string | undefined {
  const override = process.env.PODIUM_RUST_HOST_BUILD_DIR?.trim()
  if (override) return override
  const cache =
    process.env.XDG_CACHE_HOME || (buildHome() ? join(buildHome() as string, '.cache') : undefined)
  return cache ? join(cache, 'podium', 'podium-host-rs-src') : undefined
}

function crateFiles(crate: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
      .sort()
  return [
    ...['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.rs', '.cargo/config.toml']
      .map((name) => join(crate, name))
      .filter((path) => existsSync(path)),
    ...walk(join(crate, 'src')),
  ]
}

/** Hash of everything the binary is built from, or undefined outside a source checkout. */
export function vendoredRustHostSourceHash(crate: string = VENDOR_CRATE): string | undefined {
  if (!existsSync(join(crate, 'Cargo.toml'))) return undefined
  try {
    const h = createHash('sha256')
    for (const path of crateFiles(crate)) {
      h.update(`${relative(crate, path)}\n`)
      h.update(readFileSync(path))
    }
    return h.digest('hex')
  } catch {
    return undefined
  }
}

function toolchainChannel(crate: string): string | undefined {
  try {
    return /^\s*channel\s*=\s*"([^"]+)"/m.exec(
      readFileSync(join(crate, 'rust-toolchain.toml'), 'utf8'),
    )?.[1]
  } catch {
    return undefined
  }
}

function runsTool(tool: string, env: NodeJS.ProcessEnv): boolean {
  try {
    return spawnSync(tool, ['--version'], { stdio: 'ignore', env }).status === 0
  } catch {
    return false
  }
}

/** Why the last source build failed, for the resolver's loud failure. */
let lastSourceBuildError: string | undefined

/**
 * `cargo build --release --locked` of the vendored crate into the cache's target
 * dir, pinned to the crate's toolchain through rustup when rustup is there.
 * Returns the built binary, or undefined with {@link lastSourceBuildError} set.
 */
function cargoBuild(crate: string, targetDir: string): string | undefined {
  const home = buildHome()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    ...(home ? { HOME: home } : {}),
  }
  const channel = toolchainChannel(crate)
  const argv: [string, string[]] | undefined =
    channel && runsTool('rustup', env)
      ? ['rustup', ['run', channel, 'cargo', 'build', '--release', '--locked']]
      : runsTool('cargo', env)
        ? ['cargo', ['build', '--release', '--locked']]
        : undefined
  if (!argv) {
    lastSourceBuildError =
      'neither rustup nor cargo runs here (install the crate toolchain: mise install in packages/pty/vendor/podium-host-rs)'
    return undefined
  }
  try {
    execFileSync(argv[0], argv[1], { cwd: crate, env, stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string })?.stderr?.toString().trim()
    lastSourceBuildError = `${argv[0]} ${argv[1].join(' ')} failed${stderr ? `:\n${stderr.split('\n').slice(-20).join('\n')}` : ''}`
    return undefined
  }
  const out = join(targetDir, 'release', 'podium-host')
  if (hostBinFeatures(out) < HOST_FEATURES) {
    lastSourceBuildError = `${out} does not report podium-host feature level ${HOST_FEATURES}`
    return undefined
  }
  return out
}

const LOCK_STALE_MS = 15 * 60_000

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* bounded and rare */
    }
  }
}

function lockIsStale(lock: string): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) return true
    const pid = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10)
    if (!Number.isFinite(pid) || pid <= 0) return true
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  } catch {
    return false
  }
}

function acquireBuildLock(lock: string, timeoutMs = LOCK_STALE_MS): boolean {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      try {
        writeFileSync(fd, `${process.pid}\n`)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false
      if (lockIsStale(lock)) {
        rmSync(lock, { force: true })
        continue
      }
      if (Date.now() >= deadline) return false
      sleepSync(200)
    }
  }
}

function publishedSourceHost(root: string, hash: string): string | undefined {
  const bin = join(root, hash.slice(0, 16), RUST_HOST_BINARY)
  return existsSync(bin) && hostBinFeatures(bin) >= HOST_FEATURES ? bin : undefined
}

/**
 * The source checkout's Rust host, building it when the published one for the
 * current source hash is missing. `built` says whether THIS call built it (how
 * concurrent builders are shown to serialize). Undefined outside a source
 * checkout, or when the build fails ({@link lastSourceBuildError} says why).
 */
export function ensureSourceRustHost(
  crate: string = VENDOR_CRATE,
): { bin: string; built: boolean } | undefined {
  if (!hostSupported()) return undefined
  const hash = vendoredRustHostSourceHash(crate)
  const root = sourceRustHostCacheDir()
  if (!hash || !root) return undefined
  const ready = publishedSourceHost(root, hash)
  if (ready) return { bin: ready, built: false }
  try {
    mkdirSync(root, { recursive: true })
  } catch (e) {
    lastSourceBuildError = `cannot create ${root}: ${e instanceof Error ? e.message : String(e)}`
    return undefined
  }
  const lock = join(root, '.build.lock')
  if (!acquireBuildLock(lock)) {
    lastSourceBuildError = `could not take the build lock ${lock}`
    return undefined
  }
  const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const dir = join(root, hash.slice(0, 16))
  const staging = join(root, `.staging-${tag}`)
  try {
    const won = publishedSourceHost(root, hash)
    if (won) return { bin: won, built: false }
    log.warn('building the Rust podium-host from source (first use of this source)', { crate })
    const built = cargoBuild(crate, join(root, 'target'))
    if (!built) return undefined
    mkdirSync(staging, { recursive: true })
    copyFileSync(built, join(staging, RUST_HOST_BINARY))
    writeFileSync(
      join(staging, 'manifest.json'),
      `${JSON.stringify({ features: hostBinFeatures(built), sourceHash: hash, builtAt: new Date().toISOString() }, null, 2)}\n`,
    )
    rmSync(dir, { recursive: true, force: true })
    renameSync(staging, dir)
    return { bin: join(dir, RUST_HOST_BINARY), built: true }
  } catch (e) {
    lastSourceBuildError = `publishing the build failed: ${e instanceof Error ? e.message : String(e)}`
    return undefined
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(lock, { force: true })
  }
}

// ---- resolution --------------------------------------------------------------

let resolved: { bin: string | undefined } | undefined

/**
 * Resolve (and memoize) the podium-host binary per the order above. Returns
 * undefined when no Rust host can be obtained, after printing why; the daemon
 * then refuses every spawn.
 */
export function resolveHostBin(opts?: { fresh?: boolean }): string | undefined {
  if (opts?.fresh) resolved = undefined
  if (resolved) return resolved.bin
  resolved = { bin: locate() }
  return resolved.bin
}

function locate(): string | undefined {
  if (!hostSupported()) return undefined
  const explicit = process.env.PODIUM_HOST_BIN
  if (explicit) {
    if (hostBinFeatures(explicit) >= HOST_FEATURES) return explicit
    log.error(
      `PODIUM_HOST_BIN=${explicit} does not run as a podium-host at feature level ${HOST_FEATURES}. Refusing to fall back — unset it or point it at a Rust podium-host build.`,
    )
    return undefined
  }
  const payload = bundledRustHostPath()
  if (existsSync(payload) && hostBinFeatures(payload) >= HOST_FEATURES) return payload
  lastSourceBuildError = undefined
  const source = ensureSourceRustHost()
  if (source) return source.bin
  const payloadState = existsSync(payload)
    ? `${payload} does not run as a podium-host at feature level ${HOST_FEATURES}`
    : `${payload} does not exist`
  const sourceState = vendoredRustHostSourceHash()
    ? `the source build failed: ${lastSourceBuildError ?? 'unknown error'}`
    : 'this is not a source checkout, so there is nothing to build'
  log.error(
    `no podium-host: ${payloadState}, and ${sourceState}. This daemon refuses to start sessions until a Rust podium-host is available (reinstall Podium, or set PODIUM_HOST_BIN).`,
  )
  return undefined
}

export function isHostAvailable(): boolean {
  return resolveHostBin() !== undefined
}
