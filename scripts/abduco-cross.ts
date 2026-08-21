/**
 * Cross-compile the vendored abduco helper for every headless release platform,
 * from one Linux box.
 *
 * WHY THIS EXISTS. The compiled headless binary embeds abduco (see
 * scripts/embedded-abduco.ts) because a `bun build --compile` executable has no
 * abduco.c on disk to compile at runtime. Embedding a NATIVE build is what forced
 * one release runner per architecture: the helper had to be produced on the
 * machine that would run it. `zig cc` removes that constraint — it carries its
 * own libc headers and linker for every target we ship, so all four helpers come
 * off the same Linux runner [spec:SP-6144 §8b].
 *
 * NOT CHECKED IN, BUILT FROM THE VENDORED SOURCE. The repository holds no
 * binaries and this does not become the first: every helper is compiled here from
 * `packages/pty/vendor/abduco/abduco.c`, so the shipped helper cannot drift from
 * the source that is under review. The cost of rebuilding is paid once and then
 * cached — the cache key IS the source hash (see {@link abducoCachePath}), so a
 * touched abduco.c invalidates every platform at once and a restored CI cache can
 * never serve a helper built from different source.
 *
 * Regenerating by hand (Linux, `zig` and `rcodesign` on PATH):
 *
 *   bun scripts/abduco-cross.ts            # all four, into dist-bun/abduco-cache
 *   bun scripts/abduco-cross.ts --platform darwin-aarch64 --force
 *
 * See docs/internal/headless-cross-compilation.md for the full provenance note.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root, from this file's location (works under bun run and bun --compile alike). */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The single vendored translation unit every platform's helper is compiled from. */
export const ABDUCO_SOURCE = join(REPO_ROOT, 'packages/pty/vendor/abduco/abduco.c')

/**
 * The platform target strings are the ones the updater already speaks — the Tauri
 * updater triple prefix that `developmentPlatformTarget()` and the CLI's
 * `hostUpdateTarget()` derive from os/arch. Keeping ONE vocabulary means a
 * manifest key, a release asset and an abduco cache entry can never disagree
 * about which machine they are for.
 */
export const HEADLESS_PLATFORMS = [
  'linux-x86_64',
  'linux-aarch64',
  'darwin-aarch64',
  'darwin-x86_64',
] as const

export type HeadlessPlatform = (typeof HEADLESS_PLATFORMS)[number]

export function isHeadlessPlatform(value: string): value is HeadlessPlatform {
  return (HEADLESS_PLATFORMS as readonly string[]).includes(value)
}

export type AbducoTargetSpec = {
  /** `zig cc -target` triple. */
  zigTarget: string
  /** Whether the output is Mach-O and therefore needs an ad-hoc code signature. */
  darwin: boolean
}

/**
 * LINUX HELPERS LINK MUSL, STATICALLY. The native leg built against the runner's
 * glibc, which silently made the runner's glibc version the floor for every
 * machine that took the bundle. A static musl helper has no libc floor at all, so
 * the cross-built bundle is portable in a way the native one was not — the one
 * deliberate behavioural difference the arm64 A/B check exists to confirm.
 *
 * DARWIN HELPERS TARGET `-none` (no minimum OS version pinned). abduco calls only
 * POSIX plus forkpty, all of which have been in libSystem since well before any
 * macOS we would meet.
 */
export const ABDUCO_TARGETS: Record<HeadlessPlatform, AbducoTargetSpec> = {
  'linux-x86_64': { zigTarget: 'x86_64-linux-musl', darwin: false },
  'linux-aarch64': { zigTarget: 'aarch64-linux-musl', darwin: false },
  'darwin-aarch64': { zigTarget: 'aarch64-macos-none', darwin: true },
  'darwin-x86_64': { zigTarget: 'x86_64-macos-none', darwin: true },
}

/**
 * zig's bundled Darwin libc headers omit `<util.h>`; forkpty/openpty/login_tty are
 * nonetheless exported from libSystem, so declaring them is enough to link. Written
 * to a temp include dir rather than committed: it is a property of the toolchain we
 * work around, not of Podium.
 */
const DARWIN_UTIL_H = `/* Darwin <util.h> shim for zig cc cross-compiles (scripts/abduco-cross.ts).
 * The macOS SDK provides this header; zig's bundled libc headers do not.
 * forkpty/openpty/login_tty are exported from libSystem, so a declaration links. */
#ifndef PODIUM_CROSS_DARWIN_UTIL_H
#define PODIUM_CROSS_DARWIN_UTIL_H

#include <sys/types.h>
#include <termios.h>
#include <sys/ioctl.h> /* struct winsize */

pid_t forkpty(int *amaster, char *name, struct termios *termp, struct winsize *winp);
int openpty(int *amaster, int *aslave, char *name, struct termios *termp, struct winsize *winp);
int login_tty(int fd);

#endif
`

/** Mirrors the vendored Makefile's single-TU build; `-Os -s` keeps the embedded helper ~70-95 KB. */
export function abducoCompileFlags(spec: AbducoTargetSpec, includeDir: string): string[] {
  return [
    '-target',
    spec.zigTarget,
    '-std=c99',
    '-D_POSIX_C_SOURCE=200809L',
    '-D_XOPEN_SOURCE=700',
    // macOS hides its BSD extensions (SIGWINCH, VLNEXT) behind the strict macros
    // above; a no-op on musl, so it needs no platform guard. Same flag the native
    // build in packages/pty/src/abduco-bin.ts passes, for the same reason.
    '-D_DARWIN_C_SOURCE',
    '-DNDEBUG',
    '-DVERSION="0.6-podium"',
    '-Os',
    '-s',
    ...(spec.darwin
      ? [
          '-I',
          includeDir,
          // rcodesign writes an LC_CODE_SIGNATURE load command into the Mach-O
          // header. Without reserved headroom the x86_64 link leaves no room for
          // it and signing fails.
          '-Wl,-headerpad,0x8000',
        ]
      : []),
  ]
}

/** sha256 of the vendored source — the cache key, so a source edit invalidates all four. */
export function abducoSourceHash(source: string = ABDUCO_SOURCE): string {
  return createHash('sha256').update(readFileSync(source)).digest('hex')
}

export function abducoCacheDir(root: string = REPO_ROOT): string {
  return join(root, 'dist-bun', 'abduco-cache')
}

/**
 * Content-addressed: `<platform>-<source hash prefix>`. A CI cache restored from a
 * different commit is therefore either exactly right or invisible — there is no
 * state in which a stale helper is served under a current name.
 */
export function abducoCachePath(
  platform: HeadlessPlatform,
  sourceHash: string,
  root: string = REPO_ROOT,
): string {
  return join(abducoCacheDir(root), `${platform}-${sourceHash.slice(0, 16)}`)
}

function findTool(envName: string, binary: string, fallbacks: string[]): string {
  const configured = process.env[envName]?.trim()
  if (configured) return configured
  if (spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0) return binary
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `abduco-cross: ${binary} is required to cross-compile the abduco helper but was not found. ` +
      `Install it, put it on PATH, or set ${envName} to its path.`,
  )
}

export function resolveZig(): string {
  return findTool('PODIUM_ZIG', 'zig', [join(homedir(), '.local/bin/zig')])
}

export function resolveRcodesign(): string {
  return findTool('PODIUM_RCODESIGN', 'rcodesign', [join(homedir(), '.cargo/bin/rcodesign')])
}

/**
 * Build (or reuse) the abduco helper for one platform and return its path.
 *
 * Cache hits are silent and free; that is what keeps a four-platform release job
 * from paying for four C compiles on every run.
 */
export function crossBuildAbduco(
  platform: HeadlessPlatform,
  opts: { root?: string; force?: boolean; source?: string } = {},
): string {
  const root = opts.root ?? REPO_ROOT
  const source = opts.source ?? ABDUCO_SOURCE
  if (!existsSync(source)) throw new Error(`abduco-cross: vendored source missing at ${source}`)
  const spec = ABDUCO_TARGETS[platform]
  const hash = abducoSourceHash(source)
  const out = abducoCachePath(platform, hash, root)
  if (!opts.force && existsSync(out)) {
    console.log(`[abduco-cross] ${platform}: cached ${out}`)
    return out
  }

  mkdirSync(abducoCacheDir(root), { recursive: true })
  const includeDir = join(abducoCacheDir(root), 'include')
  if (spec.darwin) {
    mkdirSync(includeDir, { recursive: true })
    writeFileSync(join(includeDir, 'util.h'), DARWIN_UTIL_H)
  }

  // Compile to a pid-suffixed staging path and rename: two builds racing on the
  // same cache entry then never see a half-written helper get embedded.
  const staged = `${out}.new-${process.pid}`
  console.log(`[abduco-cross] ${platform}: zig cc -target ${spec.zigTarget}`)
  execFileSync(
    resolveZig(),
    ['cc', ...abducoCompileFlags(spec, includeDir), source, '-o', staged],
    {
      stdio: 'inherit',
    },
  )
  chmodSync(staged, 0o755)
  if (spec.darwin) {
    // Ad-hoc, from Linux. Apple Silicon refuses to execute an unsigned Mach-O, so
    // this is not cosmetic — it is what makes the helper runnable at all.
    console.log(`[abduco-cross] ${platform}: rcodesign ad-hoc sign`)
    execFileSync(resolveRcodesign(), ['sign', '--binary-identifier', 'abduco', staged], {
      stdio: 'inherit',
    })
    chmodSync(staged, 0o755)
  }
  // renameSync would be ideal, but the staged path and `out` are the same dir so a
  // plain rename is already atomic on every filesystem we run on.
  execFileSync('mv', ['-f', staged, out])
  console.log(`[abduco-cross] ${platform}: ${out} (${readFileSync(out).length} bytes)`)
  return out
}

function main(): void {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const requested = argv
    .filter((a) => a.startsWith('--platform='))
    .map((a) => a.slice('--platform='.length))
  for (const value of requested) {
    if (!isHeadlessPlatform(value)) {
      throw new Error(
        `abduco-cross: unknown platform '${value}' (want ${HEADLESS_PLATFORMS.join(' | ')})`,
      )
    }
  }
  const platforms = (requested.length > 0 ? requested : HEADLESS_PLATFORMS) as HeadlessPlatform[]
  console.log(`[abduco-cross] source ${ABDUCO_SOURCE}`)
  console.log(`[abduco-cross] source sha256 ${abducoSourceHash()}`)
  for (const platform of platforms) crossBuildAbduco(platform, { force })
}

if (import.meta.main) main()
