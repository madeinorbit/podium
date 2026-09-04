import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
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
 * abduco binary resolution — podium ships abduco rather than demanding a system
 * install. Order:
 *   1. $PODIUM_ABDUCO — explicit binary path; if it doesn't run, resolution FAILS
 *      (no silent fallback past operator intent).
 *   2. `abduco` on PATH (distro package).
 *   3. A previously built binary cached at $PODIUM_STATE_DIR/bin/abduco
 *      (else ~/.podium/bin/abduco).
 *   4. Build the vendored ISC-licensed source (vendor/abduco, single translation
 *      unit, ~1s) into that cache with the system C compiler. Podium already
 *      makes a working toolchain a hard install requirement, so cc is a fair bet.
 *
 * podium patches the vendored source, so several call sites need the patched
 * binary and not merely *an* abduco. They say so with `requireFeatures`, and the
 * order above then grows teeth: every candidate is probed with
 * `--podium-features` (an upstream abduco exits non-zero — it has no such
 * option), an explicit override that lacks the feature FAILS LOUDLY rather than
 * falling through, a system binary that lacks it is skipped, and the managed
 * build is verified against the vendored sources' hash on every selection and
 * rebuilt when they differ. Without a required feature the order above stands
 * unchanged [spec:SP-6144].
 *
 * On Windows resolution is always undefined — abduco is POSIX-only (forkpty), so
 * there is nothing to probe or build; the daemon runs sessions on the ConPTY PTY
 * backend without a durable host [spec:SP-7f2c].
 */

// Works from both src/ (tsx, @podium/source condition) and dist/ — vendor sits
// next to either at the package root.
const VENDOR_DIR = fileURLToPath(new URL('../vendor/abduco', import.meta.url))
const VENDOR_ABDUCO_C = join(VENDOR_DIR, 'abduco.c')

/**
 * Feature level of the vendored source: bumped whenever podium's patches change
 * what callers may rely on. Stamped into the binary at build time
 * (`-DPODIUM_ABDUCO_FEATURES`) and reported by `abduco --podium-features`, which
 * is the only way to tell a patched binary from an upstream one.
 *
 * 1 — the feature probe itself.
 * 2 — `-N`: attach without announcing a size (attach never resizes or SIGWINCHes
 *     the running program; only a later SIGWINCH on the attach pty does).
 */
export const ABDUCO_FEATURES = 2

/** What a managed build records beside its binary. */
export type AbducoManifest = { features: number; sourceHash: string; builtAt?: string }

/**
 * Whether abduco can exist on this platform at all — it is POSIX-only (forkpty).
 * The ONE place the platform rule lives: resolution, the vendored build, and the
 * compiled binary's materialization all consult it, so they can never disagree.
 */
export function abducoSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

function binDir(): string {
  return join(stateDir(), 'bin')
}

export function defaultAbducoCachePath(): string {
  return join(binDir(), 'abduco')
}

/**
 * The one versioned directory a managed build publishes into: binary + manifest,
 * switched into place together by a single rename.
 */
export function managedAbducoDir(features: number = ABDUCO_FEATURES): string {
  return join(binDir(), `abduco-v${features}`)
}

function runs(bin: string): boolean {
  try {
    return spawnSync(bin, ['-v'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/**
 * The feature level `bin` reports, or 0 for any binary that cannot answer —
 * an upstream abduco rejects `--podium-features` as an invalid option and exits
 * non-zero, which is exactly the signal we want.
 */
export function abducoBinFeatures(bin: string): number {
  try {
    const r = spawnSync(bin, ['--podium-features'], { encoding: 'utf8' })
    if (r.status !== 0) return 0
    const n = Number.parseInt((r.stdout ?? '').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/**
 * Hash of everything that goes into a build: the vendored translation units and
 * the feature level they are stamped with. A managed binary whose manifest
 * disagrees with this is stale and gets rebuilt.
 */
export function vendoredAbducoSourceHash(): string | undefined {
  try {
    const h = createHash('sha256')
    h.update(`features=${ABDUCO_FEATURES}\n`)
    for (const name of readdirSync(VENDOR_DIR)
      .filter((f) => /\.[ch]$/.test(f))
      .sort()) {
      h.update(`${name}\n`)
      h.update(readFileSync(join(VENDOR_DIR, name)))
    }
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
 * Compile the vendored abduco into `out`. Mirrors the upstream Makefile's single-TU
 * build. `-lutil` is required on glibc Linux (forkpty) but absent on macOS/musl,
 * so a failed link is retried without it. Returns the path, or undefined when no
 * compiler is available or the build fails.
 */
export function buildVendoredAbduco(out: string, opts?: { features?: number }): string | undefined {
  if (!abducoSupported()) return undefined // POSIX-only source (forkpty)
  // A lower `features` builds the same source with podium's newer patches
  // compiled out — how the compatibility matrix gets an "old" abduco to test
  // against without vendoring a second copy of upstream.
  const features = opts?.features ?? ABDUCO_FEATURES
  const cc = findCompiler()
  if (!cc) return undefined
  mkdirSync(dirname(out), { recursive: true })
  const base = [
    '-std=c99',
    '-D_POSIX_C_SOURCE=200809L',
    '-D_XOPEN_SOURCE=700',
    // macOS hides its BSD extensions (SIGWINCH, VLNEXT) under the strict POSIX/XOPEN
    // macros above; _DARWIN_C_SOURCE re-exposes them so the single-TU compile succeeds.
    // A no-op on glibc/musl, so it needs no platform guard.
    '-D_DARWIN_C_SOURCE',
    '-DNDEBUG',
    '-DVERSION="0.6-podium"',
    // Stamps the binary so `--podium-features` can identify a podium build.
    `-DPODIUM_ABDUCO_FEATURES=${features}`,
    VENDOR_ABDUCO_C,
    '-o',
    out,
  ]
  // Capture stderr so a genuine compile/link failure is diagnosable — the daemon's
  // "abduco not found" otherwise hides the real cc error.
  let lastErr = ''
  for (const link of [['-lutil'], []]) {
    try {
      execFileSync(cc, [...base, ...link], { stdio: ['ignore', 'ignore', 'pipe'] })
      if (runs(out)) return out
    } catch (e) {
      lastErr = (e as { stderr?: Buffer | string })?.stderr?.toString() ?? String(e)
    }
  }
  if (lastErr) console.warn(`[podium] abduco build failed (${cc}):\n${lastErr.trim()}`)
  return undefined
}

function readManifest(dir: string): AbducoManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as AbducoManifest
    return typeof m?.features === 'number' && typeof m?.sourceHash === 'string' ? m : undefined
  } catch {
    return undefined
  }
}

/**
 * The managed binary, if the one on disk is still the one we would build: the
 * manifest must carry the required feature and the current source hash, and the
 * binary itself must run and report the feature the manifest claims. Checked on
 * every selection — a half-published or hand-edited directory is simply not
 * usable and gets rebuilt.
 */
function verifyManaged(required: number): string | undefined {
  const dir = managedAbducoDir()
  const m = readManifest(dir)
  if (!m || m.features < required) return undefined
  const want = vendoredAbducoSourceHash()
  if (!want || m.sourceHash !== want) return undefined
  const bin = join(dir, 'abduco')
  if (!existsSync(bin) || !runs(bin)) return undefined
  return abducoBinFeatures(bin) === m.features ? bin : undefined
}

const LOCK_STALE_MS = 120_000

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* no sync sleep available; the wait is bounded and rare */
    }
  }
}

/** A lock whose owner is gone, or that nobody has touched for two minutes. */
function lockIsStale(lock: string): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) return true
    const pid = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10)
    if (!Number.isFinite(pid) || pid <= 0) return true
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true // owner died holding it
    }
  } catch {
    return false // vanished under us: whoever removed it released it
  }
}

/** Exclusive-create lock file, so two podium processes never compile at once. */
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

/**
 * Point $PODIUM_STATE_DIR/bin/abduco at the managed build, by renaming a fresh
 * symlink over whatever is there. Keeps the documented cache path working (and
 * keeps callers that never ask for a feature on the patched binary too).
 */
function publishPointer(tag: string): void {
  const ptr = defaultAbducoCachePath()
  const tmp = `${ptr}.ptr-${tag}`
  try {
    rmSync(tmp, { force: true })
    symlinkSync(join(`abduco-v${ABDUCO_FEATURES}`, 'abduco'), tmp)
    renameSync(tmp, ptr)
  } catch {
    rmSync(tmp, { force: true }) // a pointer is a convenience, not the contract
  }
}

/** Whether `bin/abduco` is our own pointer rather than a foreign cached binary. */
function isManagedPointer(path: string): boolean {
  try {
    return realpathSync(path).startsWith(`${managedAbducoDir()}/`)
  } catch {
    return false
  }
}

/**
 * Build into a staging directory and publish binary + manifest with ONE rename,
 * so a concurrent reader sees either the old build or the new one, never a
 * binary without its manifest. Caller holds the build lock.
 */
function buildManagedAbduco(): string | undefined {
  const dir = managedAbducoDir()
  const hash = vendoredAbducoSourceHash()
  if (!hash) return undefined
  const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const staging = join(binDir(), `.abduco-v${ABDUCO_FEATURES}.staging-${tag}`)
  const trash = join(binDir(), `.abduco-v${ABDUCO_FEATURES}.old-${tag}`)
  try {
    mkdirSync(staging, { recursive: true })
    const bin = buildVendoredAbduco(join(staging, 'abduco'))
    if (!bin) return undefined
    const got = abducoBinFeatures(bin)
    if (got !== ABDUCO_FEATURES) {
      console.warn(
        `[podium] built abduco reports feature level ${got}, expected ${ABDUCO_FEATURES}`,
      )
      return undefined
    }
    writeFileSync(
      join(staging, 'manifest.json'),
      `${JSON.stringify({ features: ABDUCO_FEATURES, sourceHash: hash, builtAt: new Date().toISOString() } satisfies AbducoManifest, null, 2)}\n`,
    )
    let displaced = false
    if (existsSync(dir)) {
      renameSync(dir, trash)
      displaced = true
    }
    renameSync(staging, dir)
    if (displaced) rmSync(trash, { recursive: true, force: true })
    publishPointer(tag)
    return join(dir, 'abduco')
  } catch (e) {
    console.warn(`[podium] abduco managed build failed: ${e instanceof Error ? e.message : e}`)
    return undefined
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(trash, { recursive: true, force: true })
  }
}

/**
 * The managed (podium-built, feature-stamped) abduco, building it if the one on
 * disk is missing or stale. `built` says whether THIS call compiled it, which is
 * how concurrent builders can be shown to serialize.
 */
export function ensureManagedAbduco(opts?: {
  requireFeatures?: number
}): { bin: string; built: boolean } | undefined {
  if (!abducoSupported()) return undefined
  const required = opts?.requireFeatures ?? ABDUCO_FEATURES
  if (ABDUCO_FEATURES < required) return undefined // vendored source predates the ask
  const ready = verifyManaged(required)
  if (ready) return { bin: ready, built: false }
  if (!existsSync(VENDOR_ABDUCO_C)) return undefined
  mkdirSync(binDir(), { recursive: true })
  const lock = join(binDir(), `.abduco-v${ABDUCO_FEATURES}.lock`)
  if (!acquireBuildLock(lock)) return undefined
  try {
    // Whoever held the lock may have just built exactly what we wanted.
    const won = verifyManaged(required)
    if (won) return { bin: won, built: false }
    const bin = buildManagedAbduco()
    return bin ? { bin, built: true } : undefined
  } finally {
    rmSync(lock, { force: true })
  }
}

const resolvedByLevel = new Map<number, string | undefined>()

/**
 * Resolve (and memoize) the abduco binary per the order above, building the
 * vendored source on first use when nothing is installed. Returns undefined when
 * abduco can't be obtained at all (the daemon then falls back to a bare PTY).
 *
 * `requireFeatures` demands a podium-patched binary at that feature level or
 * better; the default (0) accepts any working abduco.
 */
export function resolveAbducoBin(opts?: {
  fresh?: boolean
  requireFeatures?: number
}): string | undefined {
  const required = Math.max(0, opts?.requireFeatures ?? 0)
  if (opts?.fresh) resolvedByLevel.clear()
  else if (resolvedByLevel.has(required)) return resolvedByLevel.get(required)
  const bin = locate(required)
  resolvedByLevel.set(required, bin)
  return bin
}

function locate(required: number): string | undefined {
  // abduco cannot exist on Windows (POSIX forkpty), so don't probe PATH, the
  // cache, or a compiler — even an explicit PODIUM_ABDUCO can't be honored.
  if (!abducoSupported()) return undefined
  const explicit = process.env.PODIUM_ABDUCO
  if (explicit) {
    if (!runs(explicit)) return undefined
    if (required > 0 && abducoBinFeatures(explicit) < required) {
      // Operator intent, honoured by failing rather than quietly using something else.
      console.error(
        `[podium] PODIUM_ABDUCO=${explicit} is not a podium abduco build at feature level ${required} (no --podium-features). Refusing to fall back — unset it or point it at a podium build.`,
      )
      return undefined
    }
    return explicit
  }
  if (runs('abduco') && (required === 0 || abducoBinFeatures('abduco') >= required)) return 'abduco'
  const cache = defaultAbducoCachePath()
  if (required > 0) {
    // A foreign cached binary (e.g. the one a bun --compile build materializes,
    // where there is no vendored source to build from) still counts if it carries
    // the feature; our own pointer is checked by the managed path, which also
    // verifies the source hash.
    if (
      !isManagedPointer(cache) &&
      existsSync(cache) &&
      runs(cache) &&
      abducoBinFeatures(cache) >= required
    ) {
      return cache
    }
    return ensureManagedAbduco({ requireFeatures: required })?.bin
  }
  if (existsSync(cache) && runs(cache)) return cache
  if (!existsSync(VENDOR_ABDUCO_C)) return undefined
  console.log(`[podium] abduco not found — building the vendored copy into ${cache}`)
  return buildVendoredAbduco(cache)
}
