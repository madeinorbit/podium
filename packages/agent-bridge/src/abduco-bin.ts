import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * abduco binary resolution — podium ships abduco rather than demanding a system
 * install. Order:
 *   1. $PODIUM_ABDUCO — explicit binary path; if it doesn't run, resolution FAILS
 *      (no silent fallback past operator intent).
 *   2. `abduco` on PATH (distro package).
 *   3. A previously built binary cached at $PODIUM_STATE_DIR/bin/abduco
 *      (else ~/.podium/bin/abduco).
 *   4. Build the vendored ISC-licensed source (vendor/abduco, single translation
 *      unit, ~1s) into that cache with the system C compiler. node-pty already
 *      makes a working toolchain a hard install requirement, so cc is a fair bet.
 *
 * On Windows resolution is always undefined — abduco is POSIX-only (forkpty), so
 * there is nothing to probe or build; the daemon runs sessions on the ConPTY PTY
 * backend without a durable host [spec:SP-7f2c].
 */

// Works from both src/ (tsx, @podium/source condition) and dist/ — vendor sits
// next to either at the package root.
const VENDOR_ABDUCO_C = fileURLToPath(new URL('../vendor/abduco/abduco.c', import.meta.url))

export function defaultAbducoCachePath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
  return join(base, 'bin', 'abduco')
}

function runs(bin: string): boolean {
  try {
    return spawnSync(bin, ['-v'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
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
export function buildVendoredAbduco(out: string): string | undefined {
  if (process.platform === 'win32') return undefined // POSIX-only source (forkpty)
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
    VENDOR_ABDUCO_C,
    '-o',
    out,
  ]
  // Capture stderr so a genuine compile/link failure is diagnosable — the daemon's
  // "neither abduco nor tmux found" otherwise hides the real cc error.
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

let resolved: string | undefined
let resolvedOnce = false

/**
 * Resolve (and memoize) the abduco binary per the order above, building the
 * vendored source on first use when nothing is installed. Returns undefined when
 * abduco can't be obtained at all (the daemon then falls back to tmux/bare).
 */
export function resolveAbducoBin(opts?: { fresh?: boolean }): string | undefined {
  if (resolvedOnce && !opts?.fresh) return resolved
  resolvedOnce = true
  resolved = locate()
  return resolved
}

function locate(): string | undefined {
  // abduco cannot exist on Windows (POSIX forkpty), so don't probe PATH, the
  // cache, or a compiler — even an explicit PODIUM_ABDUCO can't be honored.
  if (process.platform === 'win32') return undefined
  const explicit = process.env.PODIUM_ABDUCO
  if (explicit) return runs(explicit) ? explicit : undefined
  if (runs('abduco')) return 'abduco'
  const cache = defaultAbducoCachePath()
  if (existsSync(cache) && runs(cache)) return cache
  if (!existsSync(VENDOR_ABDUCO_C)) return undefined
  console.log(`[podium] abduco not found — building the vendored copy into ${cache}`)
  return buildVendoredAbduco(cache)
}
