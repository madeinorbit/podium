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
 * `rcodesign` re-signs each Darwin Mach-O with Bun's JIT entitlements (Bun's own
 * compile already emitted an ad-hoc LINKER_SIGNED signature; dropping rcodesign
 * breaks JIT at runtime, not code signing at build time), so the architecture of
 * the runner stopped meaning anything.
 *
 * `--prepare-arch x64|arm64` REMAINS, and still builds natively on a runner of that
 * architecture. It is no longer how a release is made: it is the A/B leg that proves
 * the cross-built linux-aarch64 bundle behaves like the native one. It is expected to
 * be deleted after the first release that ships both.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
// Imported from source, not the `@podium/protocol` entry point: that entry resolves to
// `dist/`, which the release workflow never builds (`bun install --ignore-scripts`), so a
// bare specifier fails at runtime in CI. Same convention as the other scripts/ imports.
import {
  MinRequired,
  type MinRequired as MinRequiredShape,
} from '../packages/protocol/src/update/target'
import { HEADLESS_PLATFORMS, type HeadlessPlatform, isHeadlessPlatform } from './abduco-cross'
import {
  beginFreshClientPackagingSession,
  BUN_TARGETS,
  bunTargetForPlatform,
  packageHeadlessForFreshClients,
  type PackagedHeadlessBundle,
} from './build-bun'
import { extractRelease } from './changelog'
import {
  assertNoCallerSuppliedClientRootDigest,
  CLIENT_ROOT_DIGEST_FILE,
} from './client-build-root-digest'
import { buildManifest } from './release-manifest'
import { validateReferencedDesktopManifest } from './desktop-release'
import { verifyCandidateSnapshot } from './release-candidate-snapshot'

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
  clientRootDigest: string
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

type OptionKind = 'value' | 'repeated' | 'flag'

/**
 * EVERY OPTION THIS SCRIPT UNDERSTANDS, AND THE SHAPE OF ITS VALUE (POD-2800).
 *
 * This table is the only declaration. {@link parseReleaseArgs} refuses anything that
 * is not in it, so a new option is one line here plus the read of it — and if you add
 * the line without adding the read, you have built back the bug this table replaced.
 *
 * WHY A TABLE AND NOT `process.argv.indexOf`. The old reader matched argv entries
 * exactly, so `--channel stable` worked and `--channel=stable` was dropped on the
 * floor without a word: the run then built edge while the operator believed they had
 * asked for stable. Silence is the expensive half of that. A refused release costs a
 * retry; a release published to a channel nobody asked for costs a wrong release on a
 * feed real installs read, and no way to take it back.
 *
 *   value    — `--tag v0.4.2` or `--tag=v0.4.2`, given at most once
 *   repeated — the same, but may be given more than once and collects in order
 *   flag     — presence only; handing it a value is a refusal, not a truthy string
 */
const RELEASE_OPTIONS = {
  '--channel': 'value',
  '--tag': 'value',
  '--prepare-arch': 'value',
  '--publish-dir': 'value',
  '--min-required': 'value',
  '--platform': 'repeated',
  '--artifact': 'repeated',
  '--critical': 'flag',
  '--prepare-cross': 'flag',
} as const satisfies Record<`--${string}`, OptionKind>

export type ReleaseOption = keyof typeof RELEASE_OPTIONS

export type ReleaseArgs = {
  /** The value of a `value` option, or undefined when it was not passed. */
  value(option: ReleaseOption): string | undefined
  /** Whether a `flag` option was passed. */
  flag(option: ReleaseOption): boolean
  /** Every value of a `repeated` option, in the order written. */
  repeated(option: ReleaseOption): string[]
}

/**
 * Read a release command line, or refuse it by name.
 *
 * Exported so `scripts/release.test.ts` can watch each refusal fire: a guard nobody
 * has seen fail is not yet evidence.
 */
export function parseReleaseArgs(argv: readonly string[]): ReleaseArgs {
  const declared: Record<string, OptionKind | undefined> = RELEASE_OPTIONS
  const understood = Object.keys(RELEASE_OPTIONS).join(', ')
  const given = new Map<string, string[]>()

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (!token.startsWith('--')) {
      throw new Error(
        `release: unexpected argument '${token}'; this script takes options only (${understood})`,
      )
    }
    const equals = token.indexOf('=')
    const name = equals >= 0 ? token.slice(0, equals) : token
    const inline = equals >= 0 ? token.slice(equals + 1) : undefined
    const kind = declared[name]
    if (!kind) {
      throw new Error(`release: unknown option '${name}'; understood options are ${understood}`)
    }

    if (kind === 'flag') {
      if (inline !== undefined) {
        throw new Error(`release: '${name}' takes no value, but was given '${token}'`)
      }
      given.set(name, [])
      continue
    }

    // With `=` the operator has spelled the value out, so it is taken as written even
    // if it looks like another option. Without one, the next token is only a value if
    // it is not itself an option — otherwise `--channel --critical` would silently
    // release to a channel named `--critical`.
    const value = inline ?? (argv[i + 1]?.startsWith('--') ? undefined : argv[++i])
    if (value === undefined || value === '') {
      throw new Error(`release: '${name}' needs a value`)
    }
    const already = given.get(name)
    if (already && kind === 'value') {
      throw new Error(
        `release: '${name}' was given more than once ('${already[0]}' and '${value}')`,
      )
    }
    given.set(name, [...(already ?? []), value])
  }

  return {
    value: (option) => given.get(option)?.[0],
    flag: (option) => given.has(option),
    repeated: (option) => given.get(option) ?? [],
  }
}

function minRequiredArg(args: ReleaseArgs): MinRequiredShape | undefined {
  const value = args.value('--min-required')
  if (value === undefined) return undefined
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
  packaged: PackagedHeadlessBundle
  outDir: string
  mode: 'cross' | 'native'
}): PreparedHeadless {
  const asset = headlessAsset(p.platform)
  const version = readFileSync(join(p.packaged.bundleRoot, 'headless/VERSION'), 'utf8').trim()
  const built = p.packaged.tarball
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
    webDigest: packagedWebDigest(join(p.packaged.bundleRoot, 'headless')),
    clientRootDigest: p.packaged.clientRootDigest,
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
/**
 * Read `--artifact <platform>=<absolute path>` into the map {@link prepareHeadlessCross}
 * packages against.
 *
 * A caller that owns an artifact's lifecycle — the development publisher, whose
 * retention sweep sorts on the build stamp it writes into the file name — names each
 * platform's output. That used to be `PODIUM_BUNDLE_ARTIFACT` on a per-platform child
 * process; one coordinator packaging N platforms in ONE process needs N names on the
 * command line instead.
 *
 * It names a PATH and nothing else. Every refusal here is a name that would otherwise
 * be resolved silently against the wrong thing: an unknown platform (the bundle would
 * be written under a name no machine asks for), a relative path (resolved against the
 * coordinator's cwd — the snapshot worktree, which is deleted after the build, so the
 * publisher would find nothing where it looked), and a platform given twice (the second
 * write would clobber the first and both descriptors would claim the surviving bytes).
 */
export function parseArtifactOverrides(
  values: readonly string[],
): Map<HeadlessPlatform, string> {
  const overrides = new Map<HeadlessPlatform, string>()
  for (const value of values) {
    const equals = value.indexOf('=')
    if (equals < 0) {
      throw new Error(`release: --artifact wants <platform>=<absolute path>, got '${value}'`)
    }
    const platform = value.slice(0, equals)
    const path = value.slice(equals + 1)
    if (!isHeadlessPlatform(platform)) {
      throw new Error(
        `release: --artifact names unknown headless platform '${platform}' ` +
          `(want ${RELEASE_PLATFORMS.join(' | ')})`,
      )
    }
    if (!isAbsolute(path)) {
      throw new Error(
        `release: --artifact path for ${platform} must be absolute, got '${path}'`,
      )
    }
    if (overrides.has(platform)) {
      throw new Error(`release: --artifact for ${platform} given twice`)
    }
    overrides.set(platform, path)
  }
  return overrides
}

export async function prepareHeadlessCross(
  platforms: readonly HeadlessPlatform[] = RELEASE_PLATFORMS,
  outDir = 'dist-bun/release',
  artifacts: ReadonlyMap<HeadlessPlatform, string> = new Map(),
): Promise<PreparedHeadless[]> {
  if (process.platform !== 'linux') {
    throw new Error(
      `headless cross-builds run on linux only; this runner is ${process.platform}/${process.arch}`,
    )
  }
  if (platforms.length === 0) throw new Error('prepare-cross needs at least one platform')

  // Web + mobile, once for the whole set. Packaged systemd units are rendered into
  // each platform bundle by build-bun; dev-host units never belong on this path.
  // Stamp the fresh client output with the FINAL product version before capturing
  // its process-local root; packaging is forbidden from restamping after this point.
  const session = await beginFreshClientPackagingSession([])
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, CLIENT_ROOT_DIGEST_FILE), `${session.clientRootDigest}\n`)

  const prepared: PreparedHeadless[] = []
  for (const platform of platforms) {
    const target = bunTargetForPlatform(platform)
    console.log(`[release] cross-building ${platform} (--target=${target})`)
    const named = artifacts.get(platform)
    const packaged = packageHeadlessForFreshClients(session, [
      `--target=${target}`,
      ...(named ? [`--artifact=${named}`] : []),
    ])
    prepared.push(
      stagePrepared({
        platform,
        packaged,
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
export async function prepareHeadlessArchitecture(
  arch: HeadlessArch,
  outDir = 'dist-bun/release',
): Promise<PreparedHeadless> {
  const config = HEADLESS_ARCH[arch]
  if (process.platform !== 'linux' || process.arch !== config.nodeArch) {
    throw new Error(
      `headless ${arch} must build natively on linux/${config.nodeArch}; ` +
        `this runner is ${process.platform}/${process.arch}`,
    )
  }

  const session = await beginFreshClientPackagingSession([])
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, CLIENT_ROOT_DIGEST_FILE), `${session.clientRootDigest}\n`)
  const packaged = packageHeadlessForFreshClients(session, [])
  return stagePrepared({
    platform: config.target,
    packaged,
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
  const clientRootDigests = new Set(prepared.map((item) => item.clientRootDigest))
  if (clientRootDigests.size !== 1 || !prepared[0]?.clientRootDigest) {
    throw new Error('prepared headless artifacts have different or missing client root digests')
  }
  const capturedClientRootDigest = (() => {
    try {
      return readFileSync(join(dir, CLIENT_ROOT_DIGEST_FILE), 'utf8').trim()
    } catch {
      return ''
    }
  })()
  if (capturedClientRootDigest !== prepared[0].clientRootDigest) {
    throw new Error('prepared headless artifacts do not match the captured client root record')
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

/**
 * WHAT AN OLD INSTALL WILL MAKE OF THIS RELEASE (POD-2794).
 *
 * Every install shipped before the pairing was relaxed runs its own baked
 * resolver, and v0.1.0's rule is EXACT version equality between
 * `podium-update.json` and `latest.json` — on every channel, headless Linux
 * servers included, with no override and no reading of `minRequired`. POD-2769
 * measured that by executing the v0.1.0 resolver source against real published
 * manifests, so it is not a reading of the code.
 *
 * We cannot patch binaries that are already in the field, which is why this
 * check lives in the PUBLISHER rather than in `release-target.ts`. The only
 * lever left is what we put on the feed those binaries read.
 *
 * It refuses rather than repairs, and that is the design. Restamping
 * `latest.json` at the headless version would satisfy the old rule, but that
 * document is also the Tauri updater endpoint baked into every shipped shell,
 * so every installed shell would be offered bytes that still report the old
 * version after installing — a silent headless stranding traded for a desktop
 * update loop. The decision belongs to a person, once, at publish time.
 *
 * EDGE HITS THIS BY DEFAULT, with nobody doing anything wrong: `gh release
 * upload --clobber` only replaces assets this run STAGED, so a release that
 * built no desktop leaves the previous `latest.json` sitting on the rolling
 * release at the previous version. An absent staged manifest is therefore not
 * "no pairing claim", it is "the old one persists" — which is why it refuses
 * too rather than passing.
 */
export function legacyPairingNotice(p: {
  channel: 'stable' | 'edge'
  headlessVersion: string
  /** Absent when this run staged no desktop manifest at all. */
  desktopVersion?: string
}): string | undefined {
  if (p.desktopVersion === p.headlessVersion) return undefined
  const found =
    p.desktopVersion === undefined
      ? p.channel === 'edge'
        ? 'this run staged none, so the previous release\u2019s manifest stays in place at its own older version'
        : 'this run staged none, so that URL will 404'
      : `this run staged ${p.desktopVersion}`
  return (
    `[release] ${p.headlessVersion} \u2192 ${p.channel} STRANDS PRE-PAIRING INSTALLS. Every ` +
    `install older than the relaxed pairing requires latest.json to carry exactly ` +
    `${p.headlessVersion}; ${found}. Those installs will report no update available and say ` +
    `nothing about why. To move them, a release must carry a desktop build at its own version.`
  )
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
  writeFileSync(join(p.dir, 'VERSION'), version + '\n')
  const desktopFiles: string[] = []
  const desktopManifestPath = join(p.dir, 'latest.json')
  let stagedDesktopVersion: string | undefined
  if (existsSync(desktopManifestPath)) {
    const raw = readFileSync(desktopManifestPath, 'utf8')
    validateReferencedDesktopManifest(raw)
    const parsed: unknown = JSON.parse(raw)
    const named = (parsed as { version?: unknown }).version
    stagedDesktopVersion = typeof named === 'string' ? named : undefined
    desktopFiles.push('latest.json')
    if (existsSync(join(p.dir, 'desktop-shell-input.sha256'))) {
      desktopFiles.push('desktop-shell-input.sha256')
    }
  }
  const releaseFiles = [
    ...desktopFiles,
    ...prepared.flatMap((item) => [item.asset, `${item.asset}.sig`]),
    manifestName,
    'VERSION',
    CLIENT_ROOT_DIGEST_FILE,
  ]
  const checksums = writeChecksums(p.dir, releaseFiles)

  if (!process.env.GH_TOKEN) {
    console.log(`[release] built ${version} for ${p.channel}; set GH_TOKEN to publish.`)
    return
  }

  // CI proves the complete stable candidate with a real published v0.1.0
  // install before this invocation. release.ts deterministically reconstructs
  // the manifests above; this seal makes that claim exact by refusing if any
  // byte or file now differs from the directory the old install accepted.
  const acceptedSnapshot = process.env.PODIUM_RELEASE_CANDIDATE_SNAPSHOT
  if (acceptedSnapshot) verifyCandidateSnapshot(p.dir, acceptedSnapshot)

  // STATED, NOT REFUSED, and after the local-build exit because it is a fact
  // about PUBLISHING rather than about building.
  //
  // This was a refusal with a waiver flag until POD-2796 measured what that
  // would cost: spec §5 has an unchanged shell carry its OWN older version
  // forward, so the mismatch is the NORMAL state of every release that did not
  // rebuild the shell, and the waiver would have been passed on essentially all
  // of them. A refusal waived by default is ceremony, and ceremony is what the
  // next real refusal hides behind. The stranding is a known, documented,
  // one-time migration fact (spec §5b) — so the proportionate instrument is to
  // say it, unconditionally, where whoever cuts the release will read it.
  const notice = legacyPairingNotice({
    channel: p.channel,
    headlessVersion: version,
    ...(stagedDesktopVersion !== undefined ? { desktopVersion: stagedDesktopVersion } : {}),
  })
  if (notice) console.log(notice)

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
  // Runs on the raw command line, ahead of the parser, so the forbidden spelling keeps
  // its own refusal instead of being reported as merely unknown.
  assertNoCallerSuppliedClientRootDigest(process.argv.slice(2), process.env)
  const args = parseReleaseArgs(process.argv.slice(2))
  const channel = args.value('--channel') ?? 'edge'
  if (channel !== 'stable' && channel !== 'edge') throw new Error(`unknown channel ${channel}`)
  const tag = channel === 'stable' ? (args.value('--tag') ?? '') : 'edge'
  const prepareArch = args.value('--prepare-arch')
  const publishDir = args.value('--publish-dir')
  const prepareCross = args.flag('--prepare-cross')
  const modes = [prepareArch, publishDir, prepareCross || undefined].filter(Boolean)
  if (modes.length > 1) {
    throw new Error('choose one of --prepare-cross, --prepare-arch or --publish-dir')
  }

  if (prepareCross) {
    // `--platform` may be repeated to build a subset; the dev publisher uses that to
    // mint only the platforms its fleet actually has machines for. A release passes
    // none and gets all four.
    const requested = args.repeated('--platform')
    for (const value of requested) {
      if (!isHeadlessPlatform(value)) {
        throw new Error(
          `unknown headless platform '${value}' (want ${RELEASE_PLATFORMS.join(' | ')})`,
        )
      }
    }
    await prepareHeadlessCross(
      requested.length > 0 ? (requested as HeadlessPlatform[]) : RELEASE_PLATFORMS,
      undefined,
      parseArtifactOverrides(args.repeated('--artifact')),
    )
    return
  }
  if (prepareArch) {
    if (prepareArch !== 'x64' && prepareArch !== 'arm64') {
      throw new Error(`unknown headless architecture ${prepareArch}`)
    }
    await prepareHeadlessArchitecture(prepareArch)
    return
  }
  if (publishDir) {
    publishPreparedHeadless({
      channel,
      tag,
      dir: publishDir,
      critical: args.flag('--critical'),
      minRequired: minRequiredArg(args),
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
  const prepared = await prepareHeadlessArchitecture(nativeArch)
  publishPreparedHeadless({
    channel,
    tag,
    dir: 'dist-bun/release',
    requiredTargets: [prepared.target],
    critical: args.flag('--critical'),
    minRequired: minRequiredArg(args),
  })
}

if (import.meta.main) void main()
