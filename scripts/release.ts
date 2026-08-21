/**
 * Headless release helper.
 *
 * ONE LINUX JOB BUILDS ALL FOUR PLATFORMS [spec:SP-6144 section 8b]. `--prepare-cross`
 * cross-compiles linux-x86_64, linux-aarch64, darwin-aarch64 and darwin-x86_64 from a
 * single Linux runner (see scripts/build-bun.ts), then one publisher job runs
 * `--publish-dir <dir>` over the prepared set. Keeping the publish step singular avoids
 * release/manifest races.
 *
 * WHY THIS USED TO BE A MATRIX. The compiled daemon embeds a native abduco helper, so
 * the helper — and therefore the whole bundle — had to be produced on the architecture
 * that would run it. `zig cc` now builds that helper for every target from Linux and
 * `rcodesign` applies the ad-hoc signature Apple Silicon requires, so the architecture
 * of the runner stopped meaning anything.
 *
 * `--prepare-arch x64|arm64` REMAINS, and still builds natively on a runner of that
 * architecture. It is no longer how a release is made: it is the A/B leg that proves
 * the cross-built linux-aarch64 bundle behaves like the native one. It is expected to
 * be deleted after the first release that ships both.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
// Imported from source, not the `@podium/protocol` entry point: that entry resolves to
// `dist/`, which the release workflow never builds (`bun install --ignore-scripts`), so a
// bare specifier fails at runtime in CI. Same convention as the other scripts/ imports.
import {
  MinRequired,
  type MinRequired as MinRequiredShape,
} from '../packages/protocol/src/update/target'
import { HEADLESS_PLATFORMS, type HeadlessPlatform, isHeadlessPlatform } from './abduco-cross'
import { BUN_TARGETS, bunTargetForPlatform, targetOutputRoot } from './build-bun'
import { extractRelease } from './changelog'
import { buildManifest } from './release-manifest'

/** Every platform a release publishes a headless bundle for. */
export const RELEASE_PLATFORMS: readonly HeadlessPlatform[] = HEADLESS_PLATFORMS

/** The release asset name for a platform — derived from the ONE target table, never spelled twice. */
export function headlessAsset(platform: HeadlessPlatform): string {
  return `podium-headless-${BUN_TARGETS[bunTargetForPlatform(platform)].asset}.tar.gz`
}

export type HeadlessArch = 'x64' | 'arm64'

/**
 * The two NATIVE legs. Retained only for the A/B check described at the top of this
 * file; a release's four bundles all come from {@link prepareHeadlessCross}.
 */
const HEADLESS_ARCH = {
  x64: { nodeArch: 'x64', target: 'linux-x86_64' },
  arm64: { nodeArch: 'arm64', target: 'linux-aarch64' },
} as const satisfies Record<
  HeadlessArch,
  { nodeArch: NodeJS.Architecture; target: HeadlessPlatform }
>

type PreparedHeadless = {
  version: string
  target: string
  asset: string
  signature: string
  webDigest: string
  /**
   * How the bundle was produced. Recorded rather than inferred so the A/B job can say
   * which leg it is comparing, and so a descriptor can never be mistaken for the other
   * kind after the native legs are deleted.
   */
  mode?: 'cross' | 'native'
}

export function packagedWebDigest(root = 'dist-bun/headless'): string {
  const read = (site: 'web' | 'mobile'): { sourceSha: string; appVersion: string } => {
    const path = join(root, site, 'podium-build.json')
    const stamp = JSON.parse(readFileSync(path, 'utf8')) as {
      sourceSha?: unknown
      appVersion?: unknown
    }
    if (typeof stamp.sourceSha !== 'string' || stamp.sourceSha.length === 0) {
      throw new Error(`prepared ${site} site has no sourceSha in ${path}`)
    }
    if (typeof stamp.appVersion !== 'string' || stamp.appVersion.length === 0) {
      throw new Error(`prepared ${site} site has no appVersion in ${path}`)
    }
    return { sourceSha: stamp.sourceSha, appVersion: stamp.appVersion }
  }
  const web = read('web')
  const mobile = read('mobile')
  if (web.sourceSha !== mobile.sourceSha || web.appVersion !== mobile.appVersion) {
    throw new Error(
      `prepared web and mobile sites disagree (web=${web.appVersion}/${web.sourceSha}, mobile=${mobile.appVersion}/${mobile.sourceSha})`,
    )
  }
  const bundleVersion = readFileSync(join(root, 'VERSION'), 'utf8').trim()
  if (web.appVersion !== bundleVersion) {
    throw new Error(
      `prepared client version ${web.appVersion} does not match bundle VERSION ${bundleVersion}`,
    )
  }
  return web.sourceSha
}

export function buildHeadlessManifestForPlatforms(p: {
  version: string
  platforms: Array<{ target: string; url: string; signature: string }>
}): string {
  return JSON.stringify(
    {
      version: p.version,
      platforms: Object.fromEntries(
        p.platforms.map(({ target, url, signature }) => [target, { url, signature }]),
      ),
    },
    null,
    2,
  )
}

/** Backward-compatible one-platform helper used by existing callers/tests. */
export function buildHeadlessManifest(p: {
  version: string
  url: string
  signature: string
  target?: string
}): string {
  return buildHeadlessManifestForPlatforms({
    version: p.version,
    platforms: [
      {
        target: p.target ?? 'linux-x86_64',
        url: p.url,
        signature: p.signature,
      },
    ],
  })
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function minRequiredArg(): MinRequiredShape | undefined {
  const flag = '--min-required'
  const index = process.argv.indexOf(flag)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error('--min-required needs a JSON object')
  }
  try {
    return MinRequired.parse(JSON.parse(value))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid --min-required JSON: ${message}`)
  }
}

function releaseUrl(channel: 'stable' | 'edge', tag: string, asset: string): string {
  return channel === 'stable'
    ? `https://github.com/madeinorbit/podium/releases/download/${tag}/${asset}`
    : `https://github.com/madeinorbit/podium/releases/download/edge/${asset}`
}

function descriptorName(asset: string): string {
  return `${asset}.json`
}

/**
 * Copy one built bundle out of its build root into the release staging dir and record
 * the descriptor the publisher reads. Shared by the cross and native paths so the two
 * legs cannot drift in what they stage or in what they claim about it.
 */
function stagePrepared(p: {
  platform: HeadlessPlatform
  bundleRoot: string
  outDir: string
  mode: 'cross' | 'native'
}): PreparedHeadless {
  const asset = headlessAsset(p.platform)
  const version = readFileSync(join(p.bundleRoot, 'headless/VERSION'), 'utf8').trim()
  const built = join(p.bundleRoot, `podium-headless-${version}.tar.gz`)
  const builtSig = `${built}.sig`
  if (!existsSync(built) || !existsSync(builtSig)) {
    throw new Error(`headless build did not produce signed artifact ${built}`)
  }

  mkdirSync(p.outDir, { recursive: true })
  cpSync(built, join(p.outDir, asset))
  cpSync(builtSig, join(p.outDir, `${asset}.sig`))
  const prepared: PreparedHeadless = {
    version,
    target: p.platform,
    asset,
    signature: readFileSync(builtSig, 'utf8').trim(),
    webDigest: packagedWebDigest(join(p.bundleRoot, 'headless')),
    mode: p.mode,
  }
  writeFileSync(join(p.outDir, descriptorName(asset)), `${JSON.stringify(prepared)}\n`)
  console.log(`[release] prepared ${p.platform} (${p.mode}) → ${join(p.outDir, asset)}`)
  return prepared
}

/**
 * Build every requested platform from THIS Linux runner and stage them for publish.
 *
 * The client apps are built ONCE and then packed into all four bundles. That is what
 * makes `loadPreparedHeadless`'s "one web digest across every platform" check something
 * a build can actually satisfy, and it means a Mac user and a Linux user on the same
 * release are served byte-identical web assets.
 *
 * The per-platform builds run in SEQUENCE. They share dist-bun/abduco.bin — the fixed
 * path the compiled binary embeds its helper from — so running them concurrently would
 * race to leave the wrong architecture's abduco inside a bundle. See scripts/build-bun.ts.
 */
export function prepareHeadlessCross(
  platforms: readonly HeadlessPlatform[] = RELEASE_PLATFORMS,
  outDir = 'dist-bun/release',
): PreparedHeadless[] {
  if (process.platform !== 'linux') {
    throw new Error(
      `headless cross-builds run on linux only; this runner is ${process.platform}/${process.arch}`,
    )
  }
  if (platforms.length === 0) throw new Error('prepare-cross needs at least one platform')

  // systemd units + web + mobile, once for the whole set.
  execFileSync('bun', ['run', 'package:clients'], { stdio: 'inherit' })

  const prepared: PreparedHeadless[] = []
  for (const platform of platforms) {
    const target = bunTargetForPlatform(platform)
    console.log(`[release] cross-building ${platform} (--target=${target})`)
    execFileSync('bun', ['scripts/build-bun.ts', `--target=${target}`], { stdio: 'inherit' })
    prepared.push(
      stagePrepared({
        platform,
        bundleRoot: targetOutputRoot('dist-bun', target),
        outDir,
        mode: 'cross',
      }),
    )
  }
  return prepared
}

/**
 * The NATIVE leg: build this runner's own architecture the pre-cross way.
 *
 * Kept as the A/B control against {@link prepareHeadlessCross} for one release. It
 * stages under the SAME asset name as the cross build, so the two legs must be uploaded
 * to different directories — the publisher rejects two descriptors claiming one platform.
 */
export function prepareHeadlessArchitecture(
  arch: HeadlessArch,
  outDir = 'dist-bun/release',
): PreparedHeadless {
  const config = HEADLESS_ARCH[arch]
  if (process.platform !== 'linux' || process.arch !== config.nodeArch) {
    throw new Error(
      `headless ${arch} must build natively on linux/${config.nodeArch}; ` +
        `this runner is ${process.platform}/${process.arch}`,
    )
  }

  execFileSync('bun', ['run', 'package:headless'], { stdio: 'inherit' })
  return stagePrepared({
    platform: config.target,
    bundleRoot: 'dist-bun',
    outDir,
    mode: 'native',
  })
}

export function loadPreparedHeadless(
  dir: string,
  requiredTargets: readonly string[] = RELEASE_PLATFORMS,
): { version: string; prepared: PreparedHeadless[] } {
  const prepared = readdirSync(dir)
    .filter((name) => name.endsWith('.tar.gz.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as PreparedHeadless)
    .sort((a, b) => a.target.localeCompare(b.target))
  if (prepared.length === 0) throw new Error(`no prepared headless artifacts in ${dir}`)

  const versions = new Set(prepared.map((item) => item.version))
  if (versions.size !== 1) throw new Error('prepared headless artifacts have different versions')
  const webDigests = new Set(prepared.map((item) => item.webDigest))
  if (webDigests.size !== 1 || !prepared[0]?.webDigest) {
    throw new Error('prepared headless artifacts have different or missing web digests')
  }
  for (const target of requiredTargets) {
    if (!prepared.some((item) => item.target === target)) {
      throw new Error(`prepared headless artifacts are missing ${target}`)
    }
  }
  if (new Set(prepared.map((item) => item.target)).size !== prepared.length) {
    throw new Error('prepared headless artifacts contain a duplicate platform target')
  }
  for (const item of prepared) {
    const asset = join(dir, item.asset)
    const signature = `${asset}.sig`
    if (!existsSync(asset) || !existsSync(signature)) {
      throw new Error(`prepared headless artifact is incomplete: ${item.asset}`)
    }
    if (readFileSync(signature, 'utf8').trim() !== item.signature) {
      throw new Error(`prepared headless signature descriptor drifted: ${item.asset}`)
    }
  }
  return { version: prepared[0]!.version, prepared }
}

function writeChecksums(dir: string, files: string[]): string {
  const output = files
    .map((file) => {
      const path = join(dir, file)
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
      return `${digest}  ${basename(path)}`
    })
    .join('\n')
  const path = join(dir, 'SHA256SUMS')
  writeFileSync(path, `${output}\n`)
  return path
}

/** Where a checkout keeps the migrations its build defines. */
export const MIGRATIONS_DIR = 'apps/server/src/migrations/drizzle'

/**
 * The migrations this release's build defines, for the manifest to declare
 * (POD-2213).
 *
 * THROWS rather than publishing silence. A manifest with no declaration is one
 * no machine can ever prove it could roll back to, so a release job that cannot
 * see its own migrations has to stop and be fixed, not ship a target that will
 * be refused for the rest of its life.
 */
export function readDefinedMigrations(dir: string = MIGRATIONS_DIR): string[] {
  const names = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : []
  if (names.length === 0) {
    throw new Error(
      `no migrations found in ${dir}, so this release cannot declare the schema it can open`,
    )
  }
  return names
}

export function publishPreparedHeadless(p: {
  channel: 'stable' | 'edge'
  tag: string
  dir: string
  requiredTargets?: readonly string[]
  critical?: boolean
  minRequired?: MinRequiredShape
  changelogPath?: string
  /** Seam for tests; defaults to this checkout's migrations. */
  migrationsDir?: string
}): void {
  if (p.channel === 'stable' && !p.tag) throw new Error('stable release needs --tag vX.Y.Z')
  const { version, prepared } = loadPreparedHeadless(p.dir, p.requiredTargets)
  const manifestName = 'podium-update.json'
  const notes = extractRelease(readFileSync(p.changelogPath ?? 'CHANGELOG.md', 'utf8'), version)
  writeFileSync(
    join(p.dir, manifestName),
    `${JSON.stringify(
      buildManifest({
        version,
        platforms: prepared.map((item) => ({
          target: item.target,
          url: releaseUrl(p.channel, p.tag, item.asset),
          signature: item.signature,
          bytes: readFileSync(join(p.dir, item.asset)),
        })),
        notes,
        critical: p.critical ?? false,
        minRequired: p.minRequired,
        webDigest: prepared[0]!.webDigest,
        schemaMigrations: readDefinedMigrations(p.migrationsDir),
      }),
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(p.dir, 'VERSION'), `${version}\n`)
  const releaseFiles = [
    ...prepared.flatMap((item) => [item.asset, `${item.asset}.sig`]),
    manifestName,
    'VERSION',
  ]
  const checksums = writeChecksums(p.dir, releaseFiles)

  if (!process.env.GH_TOKEN) {
    console.log(`[release] built ${version} for ${p.channel}; set GH_TOKEN to publish.`)
    return
  }

  const assets = [...releaseFiles.map((file) => join(p.dir, file)), checksums, 'install.sh']
  if (p.channel === 'edge') {
    const releaseExists =
      spawnSync('gh', ['release', 'view', 'edge'], { stdio: 'ignore' }).status === 0
    const sha =
      process.env.GITHUB_SHA ??
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (releaseExists) {
      const repo = process.env.GITHUB_REPOSITORY ?? 'madeinorbit/podium'
      execFileSync('gh', [
        'api',
        '--method',
        'PATCH',
        `repos/${repo}/git/refs/tags/edge`,
        '-f',
        `sha=${sha}`,
        '-F',
        'force=true',
      ])
      execFileSync('gh', [
        'release',
        'edit',
        'edge',
        '--prerelease',
        '--title',
        `edge (${version})`,
        '--notes',
        `Rolling edge build ${version}`,
      ])
      execFileSync('gh', ['release', 'upload', 'edge', ...assets, '--clobber'])
    } else {
      execFileSync('gh', [
        'release',
        'create',
        'edge',
        '--target',
        sha,
        '--prerelease',
        '--title',
        `edge (${version})`,
        '--notes',
        `Rolling edge build ${version}`,
        ...assets,
      ])
    }
  } else {
    execFileSync('gh', ['release', 'create', p.tag, '--latest', '--generate-notes', ...assets])
  }
  console.log(`[release] published ${version} → ${p.channel}`)
}

async function main(): Promise<void> {
  const channel = (arg('--channel') ?? 'edge') as 'stable' | 'edge'
  if (channel !== 'stable' && channel !== 'edge') throw new Error(`unknown channel ${channel}`)
  const tag = channel === 'stable' ? (arg('--tag') ?? '') : 'edge'
  const prepareArch = arg('--prepare-arch')
  const publishDir = arg('--publish-dir')
  const prepareCross = process.argv.includes('--prepare-cross')
  const modes = [prepareArch, publishDir, prepareCross || undefined].filter(Boolean)
  if (modes.length > 1) {
    throw new Error('choose one of --prepare-cross, --prepare-arch or --publish-dir')
  }

  if (prepareCross) {
    // `--platform` may be repeated to build a subset; the dev publisher uses that to
    // mint only the platforms its fleet actually has machines for. A release passes
    // none and gets all four.
    const requested = process.argv
      .filter((a) => a.startsWith('--platform='))
      .map((a) => a.slice('--platform='.length))
    for (const value of requested) {
      if (!isHeadlessPlatform(value)) {
        throw new Error(
          `unknown headless platform '${value}' (want ${RELEASE_PLATFORMS.join(' | ')})`,
        )
      }
    }
    prepareHeadlessCross(
      requested.length > 0 ? (requested as HeadlessPlatform[]) : RELEASE_PLATFORMS,
    )
    return
  }
  if (prepareArch) {
    if (prepareArch !== 'x64' && prepareArch !== 'arm64') {
      throw new Error(`unknown headless architecture ${prepareArch}`)
    }
    prepareHeadlessArchitecture(prepareArch)
    return
  }
  if (publishDir) {
    publishPreparedHeadless({
      channel,
      tag,
      dir: publishDir,
      critical: process.argv.includes('--critical'),
      minRequired: minRequiredArg(),
    })
    return
  }

  // Local build convenience: prepare only the native architecture and emit a
  // local single-platform manifest. Publishing is intentionally reserved for the
  // release workflow, which supplies every published platform atomically.
  if (process.env.GH_TOKEN) {
    throw new Error('publishing requires the multi-platform --publish-dir workflow')
  }
  const nativeArch: HeadlessArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const prepared = prepareHeadlessArchitecture(nativeArch)
  publishPreparedHeadless({
    channel,
    tag,
    dir: 'dist-bun/release',
    requiredTargets: [prepared.target],
    critical: process.argv.includes('--critical'),
    minRequired: minRequiredArg(),
  })
}

if (import.meta.main) void main()
