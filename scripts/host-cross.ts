/**
 * Cross-compile the vendored podium-host helper for every headless release platform,
 * from one Linux box.
 *
 * WHY THIS EXISTS. The compiled headless binary embeds podium-host (see
 * scripts/embedded-host.ts) because a `bun build --compile` executable has no
 * host.c on disk to compile at runtime. Embedding a NATIVE build is what forced
 * one release runner per architecture: the helper had to be produced on the
 * machine that would run it. `zig cc` removes that constraint — it carries its
 * own libc headers and linker for every target we ship, so all four helpers come
 * off the same Linux runner [spec:SP-6144 §8b].
 *
 * This mirrors scripts/abduco-cross.ts one for one: the same four `zig cc`
 * targets, the same content-addressed cache keyed on the vendored source hash,
 * the same staging-then-rename publish, the same static musl Linux link and the
 * same ad-hoc rcodesign signature on Darwin. The two helpers are operated the
 * same way because the daemon falls back from one to the other.
 *
 * NOT CHECKED IN, BUILT FROM THE VENDORED SOURCE. The repository holds no
 * binaries and this does not become the first: every helper is compiled here from
 * `packages/pty/vendor/podium-host/host.c`, so the shipped helper cannot drift from
 * the source that is under review. The cost of rebuilding is paid once and then
 * cached — the cache key IS the source hash (see {@link hostCachePath}), so a
 * touched host.c invalidates every platform at once and a restored CI cache can
 * never serve a helper built from different source.
 *
 * Regenerating by hand (Linux, `zig` and `rcodesign` on PATH):
 *
 *   bun scripts/host-cross.ts            # all four, into the durable cache
 *   bun scripts/host-cross.ts --print-cache-dir   # where that is
 *   bun scripts/host-cross.ts --platform darwin-aarch64 --force
 *
 * See docs/internal/headless-cross-compilation.md for the full provenance note.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_FEATURES } from '../packages/pty/src/host-bin.js'
import { sharedCacheDir } from './shared-cache-dir'
import { readToolPins } from './tool-pins'

/** Repo root, from this file's location (works under bun run and bun --compile alike). */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The single vendored translation unit every platform's helper is compiled from. */
export const HOST_SOURCE = join(REPO_ROOT, 'packages/pty/vendor/podium-host/host.c')

/**
 * The platform vocabulary is the protocol's, not this script's: a manifest key, a
 * release asset and a host cache entry all name the same thing, and they can only
 * be guaranteed to agree if there is one definition. Re-exported so build scripts can
 * keep importing it from here.
 */
export {
  HEADLESS_PLATFORMS,
  type HeadlessPlatform,
  isHeadlessPlatform,
} from '../packages/protocol/src/update/platforms'

import {
  HEADLESS_PLATFORMS,
  type HeadlessPlatform,
  isHeadlessPlatform,
} from '../packages/protocol/src/update/platforms'

export type HostTargetSpec = {
  /** `zig cc -target` triple. */
  zigTarget: string
  /** Whether the output is Mach-O and therefore needs an ad-hoc code signature. */
  darwin: boolean
}

/**
 * LINUX HELPERS LINK MUSL, STATICALLY. The native leg built against the runner's
 * glibc, which silently made the runner's glibc version the floor for every
 * machine that took the bundle. A static musl helper has no libc floor at all, so
 * the cross-built bundle is portable in a way the native one was not — the same
 * reason the abduco helper links musl (scripts/abduco-cross.ts).
 *
 * DARWIN HELPERS TARGET `-none` (no minimum OS version pinned). podium-host calls only
 * POSIX plus forkpty, all of which have been in libSystem since well before any
 * macOS we would meet.
 */
export const HOST_TARGETS: Record<HeadlessPlatform, HostTargetSpec> = {
  'linux-x86_64': { zigTarget: 'x86_64-linux-musl', darwin: false },
  'linux-aarch64': { zigTarget: 'aarch64-linux-musl', darwin: false },
  'darwin-aarch64': { zigTarget: 'aarch64-macos-none', darwin: true },
  'darwin-x86_64': { zigTarget: 'x86_64-macos-none', darwin: true },
}

/**
 * zig's bundled Darwin libc headers omit `<util.h>`; forkpty/openpty/login_tty are
 * nonetheless exported from libSystem, so declaring them is enough to link. Written
 * to a temp include dir rather than committed: it is a property of the toolchain we
 * work around, not of Podium. Same shim as scripts/abduco-cross.ts — both helpers
 * need forkpty on Darwin.
 */
const DARWIN_UTIL_H = `/* Darwin <util.h> shim for zig cc cross-compiles (scripts/host-cross.ts).
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

/**
 * Mirrors the native single-TU build in packages/pty/src/host-bin.ts
 * (`buildVendoredHost`); `-Os -s` keeps the embedded helper small, matching the
 * abduco cross build.
 */
export function hostCompileFlags(spec: HostTargetSpec, includeDir: string): string[] {
  return [
    '-target',
    spec.zigTarget,
    '-std=c11',
    '-D_POSIX_C_SOURCE=200809L',
    '-D_XOPEN_SOURCE=700',
    // macOS hides its BSD extensions behind the strict macros above; a no-op on
    // musl, so it needs no platform guard. Same flag the native build passes.
    '-D_DARWIN_C_SOURCE',
    '-DNDEBUG',
    `-DVERSION="${HOST_FEATURES}-podium"`,
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

/**
 * sha256 of everything the native build hashes — the feature level stamped via
 * `-DVERSION` plus the vendored source — so the cross cache key IS the same
 * identity `vendoredHostSourceHash()` (packages/pty/src/host-bin.ts) verifies a
 * managed build against. A source edit or a feature bump invalidates all four.
 */
export function hostSourceHash(source: string = HOST_SOURCE): string {
  const h = createHash('sha256')
  h.update(`features=${HOST_FEATURES}\n`)
  h.update('host.c\n')
  h.update(readFileSync(source))
  return h.digest('hex')
}

/**
 * Where the compiled helpers live.
 *
 * DURABLE, NOT IN THE CHECKOUT — the same reason the abduco cache moved out
 * (POD-3162). A release packages from a fresh detached worktree in /tmp, where
 * `dist-bun/` is gitignored and therefore created empty, so an in-checkout cache
 * never hits for the one build that needs it most. The default is the same
 * per-host, per-repository path the Turbo cache uses — keyed on the COMMON GIT
 * DIR, so a detached worktree shares its parent repository's entries. The KEY is
 * unchanged: still `<platform>-<source hash prefix>`, so relocating it cannot
 * widen what a hit means.
 *
 * `PODIUM_HOST_CACHE_DIR` overrides it (CI pins the in-checkout path so
 * actions/cache can still archive a fixed directory); `root` still selects the
 * repository whose cache to use, which is what lets a test point at a temp dir.
 */
export function hostCacheDir(root: string = REPO_ROOT): string {
  const override = process.env.PODIUM_HOST_CACHE_DIR?.trim()
  if (override) return resolve(root, override)
  return sharedCacheDir('podium-host', root)
}

/**
 * Content-addressed: `<platform>-<source hash prefix>`. A CI cache restored from a
 * different commit is therefore either exactly right or invisible — there is no
 * state in which a stale helper is served under a current name.
 */
export function hostCachePath(
  platform: HeadlessPlatform,
  sourceHash: string,
  root: string = REPO_ROOT,
): string {
  return join(hostCacheDir(root), `${platform}-${sourceHash.slice(0, 16)}`)
}

function findTool(envName: string, binary: string, fallbacks: string[]): string {
  const configured = process.env[envName]?.trim()
  if (configured) return configured
  if (spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0) return binary
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `host-cross: ${binary} is required to cross-compile the podium-host helper but was not found. ` +
      `Install it, put it on PATH, or set ${envName} to its path.`,
  )
}

/**
 * The found tool must MATCH the mise.toml pin [POD-3187]. Both tools change the bytes a
 * release ships (zig compiles the embedded helper, rcodesign writes the Darwin signature),
 * so a drifted local install must fail here, loudly, rather than produce a bundle that
 * differs from what CI would have built. `PODIUM_SKIP_TOOL_PIN_CHECK=1` waives it for
 * deliberate experiments. Memoized per (tool, path): one probe per process, not per call.
 */
const pinChecked = new Set<string>()
function assertPinnedVersion(tool: string, path: string, args: string[], pinned: string): string {
  if (process.env.PODIUM_SKIP_TOOL_PIN_CHECK === '1') return path
  const key = `${tool}\0${path}`
  if (pinChecked.has(key)) return path
  const printed = spawnSync(path, args, { encoding: 'utf8' }).stdout?.trim() ?? ''
  if (!printed.split(/\s+/).includes(pinned)) {
    throw new Error(
      `host-cross: ${tool} at ${path} reports "${printed}" but mise.toml pins ${pinned}. ` +
        `Run \`mise install\` (or install ${tool} ${pinned}), or set PODIUM_SKIP_TOOL_PIN_CHECK=1 ` +
        `to build with an off-pin toolchain deliberately.`,
    )
  }
  pinChecked.add(key)
  return path
}

export function resolveZig(): string {
  const zig = findTool('PODIUM_ZIG', 'zig', [join(homedir(), '.local/bin/zig')])
  return assertPinnedVersion('zig', zig, ['version'], readToolPins().zig)
}

export function resolveRcodesign(): string {
  const rcodesign = findTool('PODIUM_RCODESIGN', 'rcodesign', [
    join(homedir(), '.cargo/bin/rcodesign'),
  ])
  return assertPinnedVersion('rcodesign', rcodesign, ['--version'], readToolPins().rcodesign)
}

/**
 * Build (or reuse) the podium-host helper for one platform and return its path.
 *
 * Cache hits are silent and free; that is what keeps a four-platform release job
 * from paying for four C compiles on every run.
 */
export function crossBuildHost(
  platform: HeadlessPlatform,
  opts: { root?: string; force?: boolean; source?: string } = {},
): string {
  const root = opts.root ?? REPO_ROOT
  const source = opts.source ?? HOST_SOURCE
  if (!existsSync(source)) throw new Error(`host-cross: vendored source missing at ${source}`)
  const spec = HOST_TARGETS[platform]
  const hash = hostSourceHash(source)
  const out = hostCachePath(platform, hash, root)
  if (!opts.force && existsSync(out)) {
    console.log(`[host-cross] ${platform}: cached ${out}`)
    return out
  }

  mkdirSync(hostCacheDir(root), { recursive: true })
  const includeDir = join(hostCacheDir(root), 'include')
  if (spec.darwin) {
    mkdirSync(includeDir, { recursive: true })
    writeFileSync(join(includeDir, 'util.h'), DARWIN_UTIL_H)
  }

  // Compile to a pid-suffixed staging path and rename: two builds racing on the
  // same cache entry then never see a half-written helper get embedded.
  const staged = `${out}.new-${process.pid}`
  console.log(`[host-cross] ${platform}: zig cc -target ${spec.zigTarget}`)
  execFileSync(
    resolveZig(),
    ['cc', ...hostCompileFlags(spec, includeDir), source, '-o', staged],
    {
      stdio: 'inherit',
    },
  )
  chmodSync(staged, 0o755)
  if (spec.darwin) {
    // Ad-hoc, from Linux. Apple Silicon refuses to execute an unsigned Mach-O, so
    // this is not cosmetic — it is what makes the helper runnable at all.
    console.log(`[host-cross] ${platform}: rcodesign ad-hoc sign`)
    execFileSync(resolveRcodesign(), ['sign', '--binary-identifier', 'podium-host', staged], {
      stdio: 'inherit',
    })
    chmodSync(staged, 0o755)
  }
  // renameSync would be ideal, but the staged path and `out` are the same dir so a
  // plain rename is already atomic on every filesystem we run on.
  execFileSync('mv', ['-f', staged, out])
  console.log(`[host-cross] ${platform}: ${out} (${readFileSync(out).length} bytes)`)
  return out
}

function main(): void {
  const argv = process.argv.slice(2)
  // Shell callers need the path too, and must never re-derive it from a literal.
  if (argv.includes('--print-cache-dir')) {
    console.log(hostCacheDir())
    return
  }
  const force = argv.includes('--force')
  const requested = argv
    .filter((a) => a.startsWith('--platform='))
    .map((a) => a.slice('--platform='.length))
  for (const value of requested) {
    if (!isHeadlessPlatform(value)) {
      throw new Error(
        `host-cross: unknown platform '${value}' (want ${HEADLESS_PLATFORMS.join(' | ')})`,
      )
    }
  }
  const platforms = (requested.length > 0 ? requested : HEADLESS_PLATFORMS) as HeadlessPlatform[]
  console.log(`[host-cross] source ${HOST_SOURCE}`)
  console.log(`[host-cross] source sha256 ${hostSourceHash()}`)
  for (const platform of platforms) crossBuildHost(platform, { force })
}

if (import.meta.main) main()
