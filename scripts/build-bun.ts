/**
 * Build the single-file `bun build --compile` binaries.
 *
 *   1. Prebuild the vendored abduco (cc → dist-bun/abduco.bin) so the daemon can embed
 *      it — the compiled binary has no abduco.c on disk to compile at runtime.
 *   2. Compile the server (relay + bun:sqlite; no PTY, no abduco).
 *   3. Compile the daemon via scripts/daemon-compiled.ts (embeds + materializes abduco).
 *
 * Run with: bun run package:headless                            (this machine's platform)
 *           bun scripts/package-headless.ts --target=bun-darwin-arm64 (cross, from Linux)
 *
 * CROSS-COMPILATION [spec:SP-6144 §8b]. With `--target` this builds the bundle for
 * ANOTHER platform from a Linux box: `bun build --compile --target=…` produces the
 * foreign executable, `scripts/abduco-cross.ts` produces the foreign abduco helper
 * with `zig cc`, and a Darwin target is re-signed with `rcodesign`. bun build --compile
 * already emits an ad-hoc LINKER_SIGNED Mach-O (identifier a.out, no entitlements);
 * rcodesign replaces that signature with identifier podium plus the five Bun JIT
 * entitlement keys. Drop rcodesign and the binary still "signs" — what breaks is JIT,
 * at runtime, not code signing at build time. That is what collapses the release
 * matrix from one runner per architecture to one Linux job for all four.
 *
 * ONE TARGET PER INVOCATION, and deliberately so: the compiled binary embeds abduco
 * through a static `with { type: 'file' }` import of the FIXED path dist-bun/abduco.bin,
 * so two targets building at once would race to leave the wrong helper there. Callers
 * that want several platforms (scripts/release.ts, the dev publisher) run this script
 * once per platform, in sequence.
 */
import { execFileSync } from 'node:child_process'
import { sign as cryptoSign } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeReleaseBuildSync } from '@podium/runtime/release-build-timing'
import { writeSystemdFiles } from '../apps/cli/src/cli-systemd'
import { DISCOVERY_WORKER_ENTRY } from '../apps/daemon/src/discovery-worker-embed.js'
import { JANITOR_WORKER_ENTRY } from '../apps/janitor/src/janitor-worker-embed.js'
/**
 * The dev-label rules, from the one place that defines them (POD-2502). The
 * leaf, not the barrel: this script builds the product, and the protocol's
 * dev-version module imports only `version-order`, which imports nothing.
 */
import {
  commitShaFromDevVersion,
  isDevChannelVersion,
} from '../packages/protocol/src/update/dev-version.js'
import { abducoSupported, buildVendoredAbduco } from '../packages/pty/src/abduco-bin.js'
import {
  bunVersion,
  hasBunTerminal,
  minTerminalBunVersion,
} from '../packages/pty/src/backends/bun-terminal-backend.js'
import { developmentSourceSha } from '../packages/runtime/src/source-version'
import { crossBuildAbduco, type HeadlessPlatform, resolveRcodesign } from './abduco-cross'
import { buildClients } from './build-clients'
import {
  assertNoCallerSuppliedClientRootDigest,
  clientBuildRootDigestFromSites,
} from './client-build-root-digest'
import { resolvePigz, tarCompressArgs } from './parallel-gzip'
import {
  type ClientBuildEvidence,
  isClientBuildEvidence,
  verifyClientBuild,
} from './verify-client-build'

/**
 * The POSIX-sh launcher shim written to `headless/podium`. It exports PODIUM_HOME (so
 * `podium update`'s installDir() resolves to the bundle root, independent of cwd / the
 * compiled binary's execPath), PODIUM_WEB_DIR and PODIUM_MOBILE_WEB_DIR, then execs the
 * compiled CLI.
 *
 * It resolves symlinks before computing DIR so the bundle root is found even when invoked
 * via the `~/.local/bin/podium` symlink that install.sh creates — `$0` would otherwise be
 * the symlink's own directory (`~/.local/bin`), making it look for a nonexistent
 * `~/.local/bin/podium-cli` and export a wrong PODIUM_HOME. The loop is POSIX-portable
 * (plain `readlink`, resolving relative targets against their link's dir — NO `readlink -f`,
 * which is absent on macOS).
 *
 * Exported so a test can render + execute the REAL shim through a symlink (the value baked
 * into the shipped binary), rather than a stub.
 *
 * NOTE: in this template literal only `${…}` needs escaping (`\${…}`) — bare `$` (e.g. `$0`,
 * `$DIR`, `$(…)`) is literal, so the WRITTEN file contains real shell variables.
 */
/**
 * Per-platform artifact names inside dist-bun/ and the headless bundle. Windows gets
 * `.exe` binaries (what `bun build --compile` emits there) and a `.cmd` launcher —
 * there is no POSIX sh to run the shim above, and no install.sh symlink to resolve.
 */
export function bundleNames(platform: NodeJS.Platform = process.platform): {
  compiled: string
  cli: string
  launcher: string
} {
  return platform === 'win32'
    ? { compiled: 'podium.exe', cli: 'podium-cli.exe', launcher: 'podium.cmd' }
    : { compiled: 'podium', cli: 'podium-cli', launcher: 'podium' }
}

/**
 * The four `bun build --compile` targets a release ships, and what each one is called
 * everywhere else.
 *
 * `platform` is the updater's vocabulary — the Tauri updater triple prefix the CLI
 * derives from its own os/arch (`hostUpdateTarget()`) and the key a manifest uses.
 * `asset` is the release-asset infix. Holding all three in ONE table is what stops a
 * bundle built for one platform from being published under another's name.
 */
export const BUN_TARGETS = {
  'bun-linux-x64': {
    platform: 'linux-x86_64',
    nodePlatform: 'linux',
    asset: 'linux-x64',
  },
  'bun-linux-arm64': {
    platform: 'linux-aarch64',
    nodePlatform: 'linux',
    asset: 'linux-arm64',
  },
  'bun-darwin-arm64': {
    platform: 'darwin-aarch64',
    nodePlatform: 'darwin',
    asset: 'darwin-arm64',
  },
  'bun-darwin-x64': {
    platform: 'darwin-x86_64',
    nodePlatform: 'darwin',
    asset: 'darwin-x64',
  },
} as const satisfies Record<
  string,
  { platform: HeadlessPlatform; nodePlatform: NodeJS.Platform; asset: string }
>

export type BunTarget = keyof typeof BUN_TARGETS

export function isBunTarget(value: string): value is BunTarget {
  return Object.hasOwn(BUN_TARGETS, value)
}

/** The `bun build --compile` target that produces a bundle for `platform`. */
export function bunTargetForPlatform(platform: HeadlessPlatform): BunTarget {
  const found = (Object.keys(BUN_TARGETS) as BunTarget[]).find(
    (target) => BUN_TARGETS[target].platform === platform,
  )
  if (!found) throw new Error(`build-bun: no bun --compile target ships ${platform}`)
  return found
}

/**
 * Where a cross-built bundle lands: one directory per platform, so all four survive a
 * single release job and can be inspected (and asserted over) side by side. A plain
 * host build keeps writing to dist-bun/ exactly as before — nothing about running this
 * script with no arguments changes.
 */
export function targetOutputRoot(distBun: string, target: BunTarget | undefined): string {
  return target ? `${distBun}/targets/${BUN_TARGETS[target].platform}` : distBun
}

export function parseBuildTarget(argv: readonly string[]): BunTarget | undefined {
  const flag = argv.find((a) => a.startsWith('--target='))
  if (!flag) return undefined
  const value = flag.slice('--target='.length)
  if (!isBunTarget(value)) {
    throw new Error(
      `build-bun: unknown --target '${value}' (want ${Object.keys(BUN_TARGETS).join(' | ')})`,
    )
  }
  return value
}

/** Kept as the name the release path already uses; the evidence IS the session now. */
export type FreshClientPackagingSession = ClientBuildEvidence

export type PackagedHeadlessBundle = Readonly<{
  bundleRoot: string
  clientRootDigest: string
  tarball: string
}>

function packageVersion(root: string): string {
  const pkgVersion = (() => {
    try {
      return (
        JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
          version?: string
        }
      ).version
    } catch {
      return undefined
    }
  })()
  const version = process.env.PODIUM_APP_VERSION ?? pkgVersion
  if (!version) {
    throw new Error(
      'build-bun: could not determine the version — root package.json has no `version` field ' +
        'and PODIUM_APP_VERSION is unset. Root package.json is the single source of truth.',
    )
  }
  return version
}

/**
 * Run the client build with this process's own Bun, then verify what it produced by
 * checksum: exact inventory + per-file hash + source commit + app version + file-count
 * floor (scripts/verify-client-build.ts). That is the successor to the POD-2540 nonce,
 * which proved only that the stamp step ran in this process. Packaging accepts only
 * evidence minted by that verification, so stale output or a caller-computed digest is
 * not provenance (spec 2026-08-28-cached-release-build-design §5).
 */
export async function beginFreshClientPackagingSession(
  argv: readonly string[] = [],
): Promise<FreshClientPackagingSession> {
  if (arguments.length > 1) {
    throw new Error('build-bun: caller-supplied environment is forbidden for client freshness')
  }
  assertNoCallerSuppliedClientRootDigest(argv)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pathBun = Bun.which('bun', { PATH: process.env.PATH })
  if (!pathBun || realpathSync(pathBun) !== realpathSync(process.execPath)) {
    throw new Error(
      `build-bun: PATH resolves bun to ${pathBun ?? 'nothing'}, not the running interpreter ${process.execPath}`,
    )
  }
  const version = packageVersion(root)
  // Through the Turbo lane (POD-3053), so a client this host has already built for
  // this commit and version is RESTORED rather than rebuilt — the same three
  // per-platform client builds a cross-compiled release used to pay for in full.
  // Freshness does not weaken by restoring: what packaging accepts is the checksum
  // evidence below, which reads the dist that is actually on disk.
  const run = await buildClients(root, [], { ...process.env, PODIUM_APP_VERSION: version })
  const sourceCommit = developmentSourceSha(root)
  if (!sourceCommit) {
    throw new Error('build-bun: cannot name HEAD, so the client build cannot be verified')
  }
  return verifyClientBuild({
    web: `${root}apps/web/dist`,
    mobile: `${root}apps/mobile/dist`,
    sourceCommit,
    version,
    run,
  })
}

/**
 * Where the self-update tarball goes.
 *
 * By default the plain versioned name in dist-bun/, which is what `scripts/release.ts` reads
 * and what a human running this script expects to find.
 *
 * `PODIUM_BUNDLE_ARTIFACT` lets a caller that OWNS the artifact's lifecycle name the file
 * instead. The development publisher does: it stamps the build time into the name so its
 * retention sweep can order bundles without trusting mtimes, and so rebuilding one commit
 * never overwrites a tarball a download may still be streaming. Blank is not a name — an
 * empty or whitespace-only value falls back rather than writing to a path called "".
 */
/**
 * A dev+<sha> tarball claims every served byte was produced from that commit.
 * Packing yesterday's `apps/web/dist` under today's SHA is that lie for the
 * web half — refuse rather than ship it.
 */
export function assertDevWebDistMatchesVersion(
  version: string,
  stamp: { sourceSha?: string } | null,
): void {
  assertDevClientDistMatchesVersion(version, 'apps/web/dist', stamp)
}

export function assertDevClientDistMatchesVersion(
  version: string,
  label: string,
  stamp: { sourceSha?: string } | null,
): void {
  // Publisher mints are `X.Y.Z-dev.<N>+<sha>` (POD-2502); forensic identity is
  // still `dev+<sha>`. Key on either — packing yesterday's dist under today's
  // commit claim is the lie this guard exists to catch.
  //
  // ONE definition of both rules, imported rather than re-stated: which labels
  // are dev-channel, and which commit one names. A release that merely carries
  // build metadata is not a dev label and is not checked here, which is why the
  // `isDevChannelVersion` question is asked first.
  const expected = isDevChannelVersion(version) ? commitShaFromDevVersion(version) : null
  if (expected === null) return
  if (!stamp?.sourceSha || stamp.sourceSha !== expected) {
    throw new Error(
      `build-bun: ${label} was not built from ${version} ` +
        `(stamp sourceSha=${stamp?.sourceSha ?? 'missing'}). ` +
        'Rebuild the client apps, then retry.',
    )
  }
}

/**
 * Replace the bundle's `web/` with the current `apps/web/dist` — REPLACE, never merge.
 *
 * Vite emits content-hashed filenames, so a bare recursive copy leaves every earlier
 * build's assets behind forever: on the dev host that had grown to 803 MB of dead files
 * beside 35 MB of live ones, gzipped into every update tarball and downloaded by every
 * machine that takes one (#1983). Prune first, then check the result is file-for-file the
 * build so a wrong path here can't quietly bring the accumulation back.
 */
export function syncBundleWeb(webDist: string, webDest: string): void {
  rmSync(webDest, { recursive: true, force: true })
  cpSync(webDist, webDest, { recursive: true })
  assertWebDirMatches(webDist, webDest)
}

/** Entries under `dir`, relative and sorted (files and directories alike). */
function listTree(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort()
}

/**
 * Throw unless the bundle's web dir holds exactly the build's entries — the regression
 * guard for {@link syncBundleWeb}. Named as a pair (extra / missing) so a failure says
 * which side drifted rather than just that a count is off.
 */
export function assertWebDirMatches(webDist: string, webDest: string): void {
  const source = new Set(listTree(webDist))
  const copied = new Set(listTree(webDest))
  const extra = [...copied].filter((f) => !source.has(f))
  const missing = [...source].filter((f) => !copied.has(f))
  if (extra.length === 0 && missing.length === 0) return
  const sample = (list: string[]): string =>
    `${list.length}${list.length ? ` (e.g. ${list.slice(0, 3).join(', ')})` : ''}`
  throw new Error(
    `build-bun: ${webDest} does not match ${webDist} — ` +
      `stale entries: ${sample(extra)}; missing entries: ${sample(missing)}`,
  )
}

export function compiledSourceMapArgs(version: string): string[] {
  // Bun 1.3.14 embeds mapped sources in a compiled executable for every
  // sourcemap mode. Inline is explicit about the property development needs:
  // the installed binary remains debuggable without a checkout-relative sidecar.
  // On the pinned Bun 1.3.14, a 19,329-byte two-module map added 8,192 bytes to
  // the executable (a tiny one added zero); production labels still get no map.
  return isDevChannelVersion(version) ? ['--sourcemap=inline'] : []
}

export function updateArtifactPath(
  out: string,
  version: string,
  argv: readonly string[] = [],
  env: Record<string, string | undefined> = process.env,
): string {
  // `--artifact=<path>` is the in-process form of the same "the caller owns the
  // artifact's lifecycle" rule the env variable states. The coordinator packages
  // several platforms inside ONE process, so it cannot name them by mutating a
  // process-wide variable between calls — it names each one on the call itself,
  // and the flag therefore wins over an env value inherited from a parent.
  //
  // A path only: it says WHERE the tarball goes, never anything about what is in
  // it. Provenance stays with the packaging session (`clientRootDigest`), which is
  // why `assertNoCallerSuppliedClientRootDigest` refuses the other direction.
  const flagged = argv.find((arg) => arg.startsWith('--artifact='))?.slice('--artifact='.length)
  const named = flagged?.trim() || env.PODIUM_BUNDLE_ARTIFACT?.trim()
  return named ? named : `${out}/podium-headless-${version}.tar.gz`
}

/**
 * The Windows launcher: same job as {@link launcherShim} (export PODIUM_HOME,
 * PODIUM_WEB_DIR and PODIUM_MOBILE_WEB_DIR relative to the bundle root, then run the compiled CLI) as a batch
 * file. `%~dp0` is the batch file's own directory (trailing backslash stripped so
 * PODIUM_HOME is the clean bundle root); no symlink resolution — Windows installs
 * put the bundle dir on PATH rather than symlinking. `setlocal` keeps the vars from
 * leaking into the calling shell; the spawned CLI still inherits them.
 */
export function windowsLauncherShim(): string {
  return `@echo off\r
setlocal\r
set "DIR=%~dp0"\r
if "%DIR:~-1%"=="\\" set "DIR=%DIR:~0,-1%"\r
set "PODIUM_HOME=%DIR%"\r
if not defined PODIUM_WEB_DIR set "PODIUM_WEB_DIR=%DIR%\\web"\r
if not defined PODIUM_MOBILE_WEB_DIR set "PODIUM_MOBILE_WEB_DIR=%DIR%\\mobile"\r
"%DIR%\\podium-cli.exe" %*\r
exit /b %errorlevel%\r
`
}

export function launcherShim(): string {
  return `#!/bin/sh
# Resolve symlinks so DIR is the real bundle root even when invoked via a
# ~/.local/bin/podium symlink ($0 would otherwise be the symlink's own dir).
SELF="$0"
while [ -L "$SELF" ]; do
  link="$(readlink "$SELF")"
  case "$link" in
    /*) SELF="$link" ;;
    *) SELF="$(dirname "$SELF")/$link" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")" && pwd)"
export PODIUM_HOME="$DIR"
export PODIUM_WEB_DIR="\${PODIUM_WEB_DIR:-$DIR/web}"
export PODIUM_MOBILE_WEB_DIR="\${PODIUM_MOBILE_WEB_DIR:-$DIR/mobile}"
exec "$DIR/podium-cli" "$@"
`
}

export function packageHeadlessForFreshClients(
  session: FreshClientPackagingSession,
  argv: readonly string[] = [],
): PackagedHeadlessBundle {
  if (arguments.length > 2) {
    throw new Error('build-bun: caller-supplied environment is forbidden for packaging')
  }
  assertNoCallerSuppliedClientRootDigest(argv)
  if (!isClientBuildEvidence(session)) {
    throw new Error(
      'build-bun: headless packaging requires client build evidence minted by this invocation',
    )
  }
  const env = process.env
  // Refuse to compile with a Bun whose terminal PTY API is missing (feature-detected, not
  // version-guessed). The compiled daemon's PTY is Bun.Terminal, so an old build Bun
  // would silently ship a binary
  // whose remote terminals render black (proc.terminal undefined on attach). This is the guard
  // that answers "why was the build allowed to use an old Bun": now it isn't.
  if (!hasBunTerminal())
    throw new Error(
      `build-bun: Bun ${bunVersion()} lacks a working terminal PTY API (Bun.spawn({terminal}) → ` +
        `proc.terminal); need Bun >= ${minTerminalBunVersion()}. The compiled daemon would render remote terminals black. ` +
        `Upgrade Bun (\`bun upgrade\`) and rebuild.`,
    )
  const root = fileURLToPath(new URL('..', import.meta.url))
  const out = `${root}dist-bun`
  const target = parseBuildTarget(argv)
  const spec = target ? BUN_TARGETS[target] : undefined
  if (spec && process.platform !== 'linux') {
    // Not a portability limit of `bun build --compile` — a limit of what we have
    // proven. The zig/rcodesign toolchain and the whole §8b evidence trail are for
    // Linux hosts; letting a Mac quietly cross-build would publish bytes nothing in
    // CI ever checks.
    throw new Error(
      `build-bun: --target cross-compilation is supported from linux only; this host is ${process.platform}`,
    )
  }
  const bundleRoot = targetOutputRoot(out, target)
  const names = bundleNames(spec?.nodePlatform ?? process.platform)
  const win = (spec?.nodePlatform ?? process.platform) === 'win32'
  mkdirSync(bundleRoot, { recursive: true })
  mkdirSync(out, { recursive: true })

  // Single source of truth for the version: root package.json `version` (env PODIUM_APP_VERSION
  // wins for one-off builds). Drives the headless VERSION stamp AND the value baked into the
  // compiled server's /version (process.env.PODIUM_APP_VERSION via --define below).
  const version = packageVersion(root)
  if (version !== session.version) {
    throw new Error(
      `build-bun: package version changed after the fresh client build ` +
        `(built=${session.version}, packaging=${version})`,
    )
  }

  // THE WEB PRECONDITION, CHECKED BEFORE ANYTHING EXPENSIVE.
  //
  // The bundle packs `apps/web/dist`, and a dev+<sha> tarball may only pack the
  // website built from that same commit — packing yesterday's under today's sha
  // is the lie the source-identity gate exists to prevent. That check used to
  // sit after the abduco prebuild AND after `bun build --compile`, so every
  // refusal paid for a full compile and threw it away: 28 of 112 attempts in the
  // week to 2026-08-13, each ~50 s, re-asked every 60 s by /version (POD-1985).
  // Nothing below this point can change the answer, so it belongs up here.
  const webDist = `${root}apps/web/dist`
  if (!existsSync(`${webDist}/index.html`)) {
    throw new Error(
      'build-bun: apps/web/dist not built — run `bun run --filter @podium/web build` first',
    )
  }
  let webStamp: { sourceSha?: string; appVersion?: string } | null = null
  try {
    const raw = JSON.parse(readFileSync(`${webDist}/podium-build.json`, 'utf8')) as {
      sourceSha?: unknown
      appVersion?: unknown
    }
    webStamp = {
      ...(typeof raw.sourceSha === 'string' ? { sourceSha: raw.sourceSha } : {}),
      ...(typeof raw.appVersion === 'string' ? { appVersion: raw.appVersion } : {}),
    }
  } catch {
    webStamp = null
  }
  assertDevWebDistMatchesVersion(version, webStamp)
  const mobileDist = `${root}apps/mobile/dist`
  if (!existsSync(`${mobileDist}/index.html`)) {
    throw new Error(
      'build-bun: apps/mobile/dist not built - run `bun run --filter @podium/mobile build` first',
    )
  }
  let mobileStamp: { sourceSha?: string; appVersion?: string } | null = null
  try {
    const raw = JSON.parse(readFileSync(`${mobileDist}/podium-build.json`, 'utf8')) as {
      sourceSha?: unknown
      appVersion?: unknown
    }
    mobileStamp = {
      ...(typeof raw.sourceSha === 'string' ? { sourceSha: raw.sourceSha } : {}),
      ...(typeof raw.appVersion === 'string' ? { appVersion: raw.appVersion } : {}),
    }
  } catch {
    mobileStamp = null
  }
  assertDevClientDistMatchesVersion(version, 'apps/mobile/dist', mobileStamp)
  if (webStamp?.sourceSha !== mobileStamp?.sourceSha) {
    throw new Error(
      'build-bun: apps/web/dist and apps/mobile/dist were built from different commits ' +
        `(web=${webStamp?.sourceSha ?? 'missing'}, mobile=${mobileStamp?.sourceSha ?? 'missing'}).`,
    )
  }
  const currentClientRootDigest = clientBuildRootDigestFromSites({
    web: webDist,
    mobile: mobileDist,
  })
  if (currentClientRootDigest !== session.clientRootDigest) {
    throw new Error(
      `build-bun: client output changed after the fresh build ` +
        `(captured=${session.clientRootDigest}, current=${currentClientRootDigest})`,
    )
  }
  timeReleaseBuildSync(
    { granularity: 'phase', phase: 'dependency-preparation', target: spec?.platform ?? 'local' },
    () =>
      timeReleaseBuildSync(
        {
          granularity: 'task',
          phase: 'dependency-preparation',
          task: 'abduco-helper',
          target: spec?.platform ?? 'local',
        },
        () => {
          if (spec) {
            // Cross build: the helper cannot be compiled by the host cc (wrong architecture,
            // wrong object format), so it comes from the zig-cc cache — built from the SAME
            // vendored abduco.c, keyed on that source's hash. Copied to the fixed path the
            // compiled binary's `with { type: 'file' }` import reads.
            const helper = crossBuildAbduco(spec.platform, { root })
            cpSync(helper, `${out}/abduco.bin`)
            console.log(`[build-bun] embedded abduco (${spec.platform}) <- ${helper}`)
          } else if (!abducoSupported()) {
            // No abduco on Windows (POSIX forkpty) — sessions run on the ConPTY PTY backend
            // without a durable host [spec:SP-7f2c]. The compiled CLI still embeds
            // dist-bun/abduco.bin (a static `with {type:'file'}` import), so write an empty
            // placeholder for the bundler; materializeEmbeddedAbduco skips it at runtime.
            console.log(
              '[build-bun] windows: skipping abduco prebuild (ConPTY backend, no durable host)',
            )
            writeFileSync(`${out}/abduco.bin`, '')
          } else {
            console.log('[build-bun] prebuilding abduco…')
            const abduco = buildVendoredAbduco(`${out}/abduco.bin`)
            if (!abduco)
              throw new Error(
                'build-bun: failed to prebuild abduco (missing C compiler, or a compile error — see the [podium] abduco build output above)',
              )
            console.log(`[build-bun] abduco -> ${abduco}`)
          }
        },
      ),
  )

  const compile = (
    entry: string,
    name: string,
    opts: { extraEntrypoints?: string[]; defines?: Record<string, string> } = {},
  ): void => {
    console.log(
      `[build-bun] compiling ${name} (v${version}${target ? `, --target=${target}` : ''})…`,
    )
    const defines: Record<string, string> = {
      // Bake the real version so the compiled server's /version reports it (not 'dev').
      // Inlined at build time wherever process.env.PODIUM_APP_VERSION is read.
      'process.env.PODIUM_APP_VERSION': `"${version}"`,
      // The display version is not build identity. Keep the source digest as its
      // own compiled fact so /version remains comparable under any naming scheme.
      'process.env.PODIUM_SOURCE_SHA': webStamp?.sourceSha
        ? JSON.stringify(webStamp.sourceSha)
        : 'undefined',
      ...opts.defines,
    }
    const defineArgs = Object.entries(defines).flatMap(([k, v]) => ['--define', `${k}=${v}`])
    timeReleaseBuildSync(
      { granularity: 'phase', phase: 'headless-platform-build', target: spec?.platform ?? 'local' },
      () =>
        timeReleaseBuildSync(
          {
            granularity: 'task',
            phase: 'headless-platform-build',
            task: 'compile-cli',
            target: spec?.platform ?? 'local',
          },
          () =>
            execFileSync(
              'bun',
              [
                'build',
                '--compile',
                ...compiledSourceMapArgs(version),
                // Absent, Bun compiles for the host. Present, it downloads (and caches) the
                // target's own Bun runtime and links the bundle against that instead.
                ...(target ? [`--target=${target}`] : []),
                '--conditions=@podium/source',
                ...defineArgs,
                entry,
                // Extra entrypoints are bundled + embedded alongside the main one (their whole dep
                // graph included). `bun build --compile` embeds each additional entrypoint at its path
                // relative to the common ancestor of ALL entrypoints, under /$bunfs/root. The main
                // entry, by contrast, always lands at /$bunfs/root/<outfile-basename>.
                ...(opts.extraEntrypoints ?? []),
                '--outfile',
                `${bundleRoot}/${name}`,
              ],
              { cwd: root, stdio: 'inherit' },
            ),
        ),
    )
  }

  /**
   * Re-sign a Darwin binary ad-hoc, with Bun's JIT entitlements.
   *
   * `bun build --compile` already emits an ad-hoc signature for Darwin targets, but it
   * is a LINKER_SIGNED one with identifier `a.out` and NO entitlements — and Bun's
   * JavaScriptCore needs `allow-jit` to map its writable-executable pages. So this is
   * not "add a signature", it is "replace a signature that lacks the entitlements".
   *
   * If this pass is ever dropped, what breaks is JIT — not code signing. The binary
   * still carries Bun's linker signature, the build still goes green, and the failure
   * is at runtime when JSC cannot map W^X pages. The published-bundle assertions
   * check identifier `podium` (not LINKER_SIGNED) and the five entitlement keys
   * precisely so that regression is a release-gate red rather than a Mac-side crash.
   */
  const signDarwin = (binary: string): void => {
    const entitlements = `${root}scripts/bun-jit.entitlements.plist`
    if (!existsSync(entitlements))
      throw new Error(`build-bun: missing Darwin entitlements at ${entitlements}`)
    console.log('[build-bun] rcodesign ad-hoc sign (Bun JIT entitlements)…')
    timeReleaseBuildSync(
      { granularity: 'phase', phase: 'signing', target: spec?.platform ?? 'local' },
      () =>
        timeReleaseBuildSync(
          {
            granularity: 'task',
            phase: 'signing',
            task: 'darwin-cli',
            target: spec?.platform ?? 'local',
          },
          () =>
            execFileSync(
              resolveRcodesign(),
              [
                'sign',
                '--binary-identifier',
                'podium',
                '--entitlements-xml-file',
                entitlements,
                binary,
              ],
              { stdio: 'inherit' },
            ),
        ),
    )
    chmodSync(binary, 0o755)
  }

  // ONE binary ships. The `podium` CLI runs every role — the split components as
  // `podium server` / `podium daemon` (separate processes), the desktop sidecar as in-process
  // all-in-one — so the previously-separate standalone `podium-server`/`podium-daemon` compiles
  // are redundant and dropped (see #98). The CLI runs a daemon in-process (all-in-one / `podium
  // daemon`), so it embeds both autonomous worker entrypoints explicitly:
  // Bun does not discover `new Worker(...)` targets during `--compile`. Their
  // shared embed modules keep build-time paths and runtime targets identical.
  compile('scripts/cli-compiled.ts', names.compiled, {
    extraEntrypoints: [DISCOVERY_WORKER_ENTRY, JANITOR_WORKER_ENTRY],
  })
  if (spec?.nodePlatform === 'darwin') signDarwin(`${bundleRoot}/${names.compiled}`)
  console.log(`[build-bun] done -> ${bundleRoot}/${names.compiled}`)

  // --- headless bundle: binaries + web + launcher ---------------------------------
  const headless = `${bundleRoot}/headless`
  // The fresh build was stamped with the session's final product version. Packaging
  // never repairs or restamps it: a mismatch means the build/package chain broke.
  if (webStamp?.appVersion !== version || mobileStamp?.appVersion !== version) {
    throw new Error(
      `build-bun: fresh client build version does not match package version ` +
        `(web=${webStamp?.appVersion ?? 'missing'}, mobile=${mobileStamp?.appVersion ?? 'missing'}, package=${version})`,
    )
  }
  // The module-branded session retained the fresh-build root before compilation.
  // Compare every later representation against that same in-process value.
  mkdirSync(headless, { recursive: true })
  // Release units are generated from the same renderer used by runtime setup and the dev host.
  writeSystemdFiles(`${headless}/systemd`, {
    profile: 'packaged',
    instanceId: 'default',
  })
  syncBundleWeb(webDist, `${headless}/web`)
  syncBundleWeb(mobileDist, `${headless}/mobile`)
  const copiedClientRootDigest = clientBuildRootDigestFromSites({
    web: `${headless}/web`,
    mobile: `${headless}/mobile`,
  })
  if (copiedClientRootDigest !== session.clientRootDigest) {
    throw new Error(
      `build-bun: client output changed while it was copied into the bundle ` +
        `(captured=${session.clientRootDigest}, copied=${copiedClientRootDigest})`,
    )
  }

  // The one compiled binary, plus the launcher shim (below) that execs it as `podium-cli`.
  const bundledCli = `${headless}/${names.cli}`
  if (win) {
    cpSync(`${bundleRoot}/${names.compiled}`, bundledCli)
  } else {
    // A running Linux executable cannot be opened for an in-place copy (ETXTBSY),
    // but replacing its directory entry is safe: the old process keeps its inode
    // while new launches see the complete new binary.
    const stagedCli = `${bundledCli}.new-${process.pid}`
    try {
      cpSync(`${bundleRoot}/${names.compiled}`, stagedCli)
      chmodSync(stagedCli, 0o755)
      renameSync(stagedCli, bundledCli)
    } finally {
      rmSync(stagedCli, { force: true })
    }
  }
  chmodSync(bundledCli, 0o755)

  // License notices ship with every headless bundle (Apache-2.0 NOTICE convention + the
  // generated third-party inventory; regenerate via scripts/generate-third-party-notices.ts).
  for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
    if (!existsSync(`${root}${f}`)) throw new Error(`build-bun: missing ${f} at repo root`)
    cpSync(`${root}${f}`, `${headless}/${f}`)
  }

  // VERSION stamp — drives `podium update`'s self version check. Same single source as the
  // baked-in /version above (root package.json `version`, env PODIUM_APP_VERSION wins).
  writeFileSync(`${headless}/VERSION`, `${version}\n`)

  // Launcher shim: POSIX sh (resolves the install.sh symlink to the real bundle) or a
  // Windows .cmd (no symlinks there — the bundle dir itself goes on PATH). Both export
  // PODIUM_HOME/PODIUM_WEB_DIR, then run the compiled CLI.
  writeFileSync(`${headless}/${names.launcher}`, win ? windowsLauncherShim() : launcherShim())
  chmodSync(`${headless}/${names.launcher}`, 0o755)

  // Self-update artifact: a tarball of the headless/ dir the feed can serve. `tar` from the
  // bundle's parent so the archive root is `headless/` (matching runUpdate's extract path).
  const tarball = updateArtifactPath(bundleRoot, version, argv, env)
  // Compress in parallel where pigz is installed — archiving is the slowest single step of a
  // release and gzip only ever uses one of the build scope's two cores. See scripts/parallel-gzip.ts
  // for the measurements, the -p2 thread pin, and why pigz stays optional.
  const pigz = resolvePigz()
  console.log(
    `build-bun: archiving ${tarball} with ${pigz ? `${pigz} -p2` : 'gzip (pigz not found)'}`,
  )
  timeReleaseBuildSync(
    { granularity: 'phase', phase: 'headless-platform-build', target: spec?.platform ?? 'local' },
    () =>
      timeReleaseBuildSync(
        {
          granularity: 'task',
          phase: 'headless-platform-build',
          task: 'archive',
          target: spec?.platform ?? 'local',
        },
        () =>
          execFileSync('tar', tarCompressArgs(tarball, bundleRoot, 'headless', pigz), {
            cwd: root,
            stdio: 'inherit',
          }),
      ),
  )

  // Sign the tarball bytes (Ed25519) so the feed can serve `signature` and `podium update`
  // can verify before swapping. Key source: env PODIUM_UPDATE_SIGNING_KEY (base64 pkcs8/DER,
  // the operator's production key at release) else the gitignored dev key. The matching public
  // key is committed in packages/runtime/src/update-delivery.ts — keep the two in lockstep on release.
  timeReleaseBuildSync(
    { granularity: 'phase', phase: 'signing', target: spec?.platform ?? 'local' },
    () =>
      timeReleaseBuildSync(
        {
          granularity: 'task',
          phase: 'signing',
          task: 'headless-artifact',
          target: spec?.platform ?? 'local',
        },
        () => {
          const signingKeyB64 = (() => {
            if (env.PODIUM_UPDATE_SIGNING_KEY) return env.PODIUM_UPDATE_SIGNING_KEY.trim()
            const devKey = `${root}scripts/.podium-update-dev.key`
            if (existsSync(devKey)) return readFileSync(devKey, 'utf8').trim()
            return undefined
          })()
          if (!signingKeyB64) {
            console.warn(
              '[build-bun] no signing key (PODIUM_UPDATE_SIGNING_KEY unset + dev key missing) — ' +
                'skipping .sig; `podium update` will REJECT this tarball. Generate scripts/.podium-update-dev.key.',
            )
          } else {
            const key = {
              key: Buffer.from(signingKeyB64, 'base64'),
              format: 'der' as const,
              type: 'pkcs8' as const,
            }
            const sig = cryptoSign(null, readFileSync(tarball), key).toString('base64')
            writeFileSync(`${tarball}.sig`, `${sig}\n`)
            console.log(`[build-bun] headless update signature -> ${tarball}.sig`)
          }
        },
      ),
  )

  // Re-open the archive and compare it with the module-branded fresh build. This is
  // continuity, not correctness: it catches stale/wrong paths, partial copies,
  // corruption, and substitution between the build and packaging. A bad build can
  // still agree with its own manifest.
  const extracted = mkdtempSync(join(tmpdir(), 'podium-packaged-client-proof-'))
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', extracted])
    const packagedClientRootDigest = clientBuildRootDigestFromSites({
      web: join(extracted, 'headless/web'),
      mobile: join(extracted, 'headless/mobile'),
    })
    if (packagedClientRootDigest !== session.clientRootDigest) {
      throw new Error(
        `build-bun: packaged clients differ from the fresh build ` +
          `(captured=${session.clientRootDigest}, packaged=${packagedClientRootDigest})`,
      )
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true })
  }

  console.log(`[build-bun] headless bundle -> ${headless} (VERSION ${version})`)
  console.log(`[build-bun] headless update artifact -> ${tarball}`)
  return { bundleRoot, clientRootDigest: session.clientRootDigest, tarball }
}

if (import.meta.main) {
  assertNoCallerSuppliedClientRootDigest(process.argv.slice(2), process.env)
  throw new Error(
    'build-bun: direct headless packaging is forbidden; run `bun run package:headless` so this invocation fresh-builds the clients first',
  )
}
