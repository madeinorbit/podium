import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stateDir } from '@podium/runtime/config'

/**
 * podium-host binary resolution — the managed build of our own durable process
 * host (vendor/podium-host/host.c, SPEC-6). Mirrors abduco-bin.ts one for one so
 * the two adapters are operated the same way. Order:
 *   1. $PODIUM_HOST_BIN — explicit binary path; if it doesn't run or is not a
 *      podium-host at the required feature level, resolution FAILS (no silent
 *      fallback past operator intent).
 *   2. The managed build at $PODIUM_STATE_DIR/bin/podium-host-v<features>/,
 *      verified against the vendored source hash on every selection.
 *   3. A materialized binary at $PODIUM_STATE_DIR/bin/podium-host (what a
 *      `bun build --compile` distribution unpacks, where there is no source).
 *   4. Build the vendored source now (single translation unit, well under a
 *      second) into the managed directory.
 *
 * There is no PATH lookup: nobody installs a podium-host from a distro.
 * Windows: unsupported (forkpty), same as abduco.
 */

const VENDOR_DIR = fileURLToPath(new URL('../vendor/podium-host', import.meta.url))
const VENDOR_HOST_C = join(VENDOR_DIR, 'host.c')

/**
 * Feature level of the vendored host: bumped when the protocol or command line
 * gains something callers rely on. Reported by `podium-host version` as
 * `features=<n>`.
 *
 * 1 — SPEC-6 protocol version 1.
 */
export const HOST_FEATURES = 1

export type HostManifest = { features: number; sourceHash: string; builtAt?: string }

export function hostSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

function binDir(): string {
  return join(stateDir(), 'bin')
}

/** Where a compiled distribution materializes its embedded host, and our pointer. */
export function defaultHostCachePath(): string {
  return join(binDir(), 'podium-host')
}

export function managedHostDir(features: number = HOST_FEATURES): string {
  return join(binDir(), `podium-host-v${features}`)
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

function runs(bin: string): boolean {
  return hostBinFeatures(bin) > 0
}

export function vendoredHostSourceHash(): string | undefined {
  try {
    const h = createHash('sha256')
    h.update(`features=${HOST_FEATURES}\n`)
    h.update('host.c\n')
    h.update(readFileSync(VENDOR_HOST_C))
    return h.digest('hex')
  } catch {
    return undefined // no vendored source here (a bun --compile binary)
  }
}

function findCompiler(): string | undefined {
  return ['cc', 'gcc', 'clang'].find((c) => {
    try {
      return spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0
    } catch {
      return false
    }
  })
}

/**
 * Compile the vendored host into `out`. `-lutil` is required on glibc Linux
 * (forkpty) and absent on macOS/musl, so a failed link is retried without it.
 */
export function buildVendoredHost(out: string): string | undefined {
  if (!hostSupported()) return undefined
  const cc = findCompiler()
  if (!cc) return undefined
  mkdirSync(dirname(out), { recursive: true })
  const base = [
    '-std=c11',
    '-D_POSIX_C_SOURCE=200809L',
    '-D_XOPEN_SOURCE=700',
    '-D_DARWIN_C_SOURCE',
    '-DNDEBUG',
    `-DVERSION="${HOST_FEATURES}-podium"`,
    VENDOR_HOST_C,
    '-o',
    out,
  ]
  let lastErr = ''
  for (const link of [['-lutil'], []]) {
    try {
      execFileSync(cc, [...base, ...link], { stdio: ['ignore', 'ignore', 'pipe'] })
      if (runs(out)) return out
    } catch (e) {
      lastErr = (e as { stderr?: Buffer | string })?.stderr?.toString() ?? String(e)
    }
  }
  if (lastErr) console.warn(`[podium] podium-host build failed (${cc}):\n${lastErr.trim()}`)
  return undefined
}

function readManifest(dir: string): HostManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as HostManifest
    return typeof m?.features === 'number' && typeof m?.sourceHash === 'string' ? m : undefined
  } catch {
    return undefined
  }
}

function verifyManaged(required: number): string | undefined {
  const dir = managedHostDir()
  const m = readManifest(dir)
  if (!m || m.features < required) return undefined
  const want = vendoredHostSourceHash()
  if (!want || m.sourceHash !== want) return undefined
  const bin = join(dir, 'podium-host')
  if (!existsSync(bin)) return undefined
  return hostBinFeatures(bin) === m.features ? bin : undefined
}

const LOCK_STALE_MS = 120_000

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

function acquireBuildLock(lock: string, timeoutMs = 180_000): boolean {
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
      sleepSync(100)
    }
  }
}

function publishPointer(tag: string): void {
  const ptr = defaultHostCachePath()
  const tmp = `${ptr}.ptr-${tag}`
  try {
    rmSync(tmp, { force: true })
    symlinkSync(join(`podium-host-v${HOST_FEATURES}`, 'podium-host'), tmp)
    renameSync(tmp, ptr)
  } catch {
    rmSync(tmp, { force: true })
  }
}

function isManagedPointer(path: string): boolean {
  try {
    return realpathSync(path).startsWith(`${managedHostDir()}/`)
  } catch {
    return false
  }
}

/** Build into staging and publish binary + manifest with ONE rename. Caller holds the lock. */
function buildManagedHost(): string | undefined {
  const dir = managedHostDir()
  const hash = vendoredHostSourceHash()
  if (!hash) return undefined
  const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const staging = join(binDir(), `.podium-host-v${HOST_FEATURES}.staging-${tag}`)
  const trash = join(binDir(), `.podium-host-v${HOST_FEATURES}.old-${tag}`)
  try {
    mkdirSync(staging, { recursive: true })
    const bin = buildVendoredHost(join(staging, 'podium-host'))
    if (!bin) return undefined
    const got = hostBinFeatures(bin)
    if (got !== HOST_FEATURES) {
      console.warn(`[podium] built podium-host reports feature level ${got}, expected ${HOST_FEATURES}`)
      return undefined
    }
    writeFileSync(
      join(staging, 'manifest.json'),
      `${JSON.stringify({ features: HOST_FEATURES, sourceHash: hash, builtAt: new Date().toISOString() } satisfies HostManifest, null, 2)}\n`,
    )
    let displaced = false
    if (existsSync(dir)) {
      renameSync(dir, trash)
      displaced = true
    }
    renameSync(staging, dir)
    if (displaced) rmSync(trash, { recursive: true, force: true })
    publishPointer(tag)
    return join(dir, 'podium-host')
  } catch (e) {
    console.warn(`[podium] podium-host managed build failed: ${e instanceof Error ? e.message : e}`)
    return undefined
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(trash, { recursive: true, force: true })
  }
}

/**
 * The managed host, building it if the one on disk is missing or stale. `built`
 * says whether THIS call compiled it (how concurrent builders are shown to serialize).
 */
export function ensureManagedHost(opts?: {
  requireFeatures?: number
}): { bin: string; built: boolean } | undefined {
  if (!hostSupported()) return undefined
  const required = opts?.requireFeatures ?? HOST_FEATURES
  if (HOST_FEATURES < required) return undefined
  const ready = verifyManaged(required)
  if (ready) return { bin: ready, built: false }
  if (!existsSync(VENDOR_HOST_C)) return undefined
  mkdirSync(binDir(), { recursive: true })
  const lock = join(binDir(), `.podium-host-v${HOST_FEATURES}.lock`)
  if (!acquireBuildLock(lock)) return undefined
  try {
    const won = verifyManaged(required)
    if (won) return { bin: won, built: false }
    const bin = buildManagedHost()
    return bin ? { bin, built: true } : undefined
  } finally {
    rmSync(lock, { force: true })
  }
}

let resolved: { bin: string | undefined } | undefined

/**
 * Resolve (and memoize) the podium-host binary per the order above. Returns
 * undefined when no host can be obtained (the daemon then falls back to abduco,
 * then to a bare PTY).
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
    console.error(
      `[podium] PODIUM_HOST_BIN=${explicit} does not run as a podium-host at feature level ${HOST_FEATURES}. Refusing to fall back — unset it or point it at a podium-host build.`,
    )
    return undefined
  }
  const managed = verifyManaged(HOST_FEATURES)
  if (managed) return managed
  const cache = defaultHostCachePath()
  // A materialized binary (compiled distribution: no source to hash) counts when
  // it carries the feature; our own pointer is covered by the managed path.
  if (!isManagedPointer(cache) && existsSync(cache) && hostBinFeatures(cache) >= HOST_FEATURES) {
    return cache
  }
  return ensureManagedHost()?.bin
}

export function isHostAvailable(): boolean {
  return resolveHostBin() !== undefined
}
