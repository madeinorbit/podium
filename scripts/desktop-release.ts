/**
 * Prepare signed Tauri updater artifacts and one static multi-platform manifest for an
 * explicitly promoted stable or edge desktop release. This script never publishes.
 * [spec:SP-7f2c]
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { extractRelease } from './changelog'

export type DesktopReleaseChannel = 'stable' | 'edge'
export type DesktopReleaseTarget =
  | 'linux-x86_64'
  | 'windows-x86_64'
  | 'darwin-aarch64'
  | 'darwin-x86_64'

export type DesktopReleaseArtifact = {
  target: DesktopReleaseTarget
  artifactName: string
  signature: string
}

type DesktopManifest = {
  version: string
  notes?: string
  platforms: Record<string, { url: string; signature: string }>
}

type TargetBundle = {
  target: DesktopReleaseTarget
  updaterSuffix: string
  publishedUpdaterName?: (version: string) => string
  requiredDownloadSuffixes: string[]
  // Both macOS targets emit the same bundle suffixes (.app.tar.gz, .dmg), so suffix matching
  // alone is ambiguous. Tauri stamps the arch into the path (x86_64-apple-darwin target dir,
  // _x64 in DMG names); this predicate scopes a bundle to its own architecture's files.
  matches?: (path: string) => boolean
}

const macIntelMarker = /x86_64|_x64/

const targetBundles: TargetBundle[] = [
  { target: 'linux-x86_64', updaterSuffix: '.AppImage', requiredDownloadSuffixes: [] },
  {
    target: 'windows-x86_64',
    updaterSuffix: '-setup.exe',
    requiredDownloadSuffixes: [],
    matches: (path) => /[\\/]nsis[\\/]/.test(path),
  },
  {
    target: 'darwin-aarch64',
    updaterSuffix: '.app.tar.gz',
    publishedUpdaterName: (version) => `Podium_${version}_aarch64.app.tar.gz`,
    requiredDownloadSuffixes: ['.dmg'],
    matches: (path) => !macIntelMarker.test(path),
  },
  {
    target: 'darwin-x86_64',
    updaterSuffix: '.app.tar.gz',
    publishedUpdaterName: (version) => `Podium_${version}_x64.app.tar.gz`,
    requiredDownloadSuffixes: ['.dmg'],
    matches: (path) => macIntelMarker.test(path),
  },
]

// Every asset kind this workflow publishes, signatures included. Pruning matches on these
// suffixes so it can never touch the headless workflow's assets on the same rolling release.
const desktopAssetSuffixes = targetBundles
  .flatMap((bundle) => [bundle.updaterSuffix, ...bundle.requiredDownloadSuffixes])
  .flatMap((suffix) => [suffix, `${suffix}.sig`])

/**
 * Desktop assets on the release that this publish does not replace. DMG, AppImage, and macOS
 * updater archive names embed the version, so `gh release upload --clobber` accumulates one pair
 * per edge build — including pre-notarization installers — unless publish deletes the leftovers.
 */
export function staleDesktopAssets(existingAssets: string[], currentAssets: string[]): string[] {
  const current = new Set(currentAssets)
  return existingAssets.filter(
    (name) =>
      desktopAssetSuffixes.some((suffix) => name.endsWith(suffix)) && !current.has(name),
  )
}

export function desktopReleaseTag(
  channel: DesktopReleaseChannel,
  version: string,
  stableTag?: string,
): string {
  if (channel === 'edge') return 'edge'
  if (!stableTag) throw new Error('stable desktop release needs --tag vX.Y.Z')
  if (stableTag !== `v${version}`) {
    throw new Error(`stable tag ${stableTag} does not match desktop version ${version}`)
  }
  return stableTag
}

function assertUniqueArtifacts(artifacts: DesktopReleaseArtifact[]): void {
  if (artifacts.length === 0) throw new Error('desktop manifest needs at least one artifact')
  const targets = new Set<string>()
  const names = new Set<string>()
  for (const artifact of artifacts) {
    if (targets.has(artifact.target)) {
      throw new Error(`duplicate desktop manifest target ${artifact.target}`)
    }
    if (names.has(artifact.artifactName)) {
      throw new Error(`duplicate desktop artifact name ${artifact.artifactName}`)
    }
    if (!artifact.signature) {
      throw new Error(`desktop artifact signature is empty for ${artifact.target}`)
    }
    targets.add(artifact.target)
    names.add(artifact.artifactName)
  }
}

export function buildDesktopManifest(input: {
  version: string
  channel: DesktopReleaseChannel
  artifacts: DesktopReleaseArtifact[]
  notes?: string
  stableTag?: string
}): string {
  assertUniqueArtifacts(input.artifacts)
  const releaseTag = desktopReleaseTag(input.channel, input.version, input.stableTag)
  const platforms = Object.fromEntries(
    input.artifacts.map((artifact) => [
      artifact.target,
      {
        url: `https://github.com/madeinorbit/podium/releases/download/${releaseTag}/${artifact.artifactName}`,
        signature: artifact.signature,
      },
    ]),
  )
  return `${JSON.stringify(
    {
      version: input.version,
      ...(input.notes ? { notes: input.notes } : {}),
      platforms,
    } satisfies DesktopManifest,
    null,
    2,
  )}\n`
}

export function validateDesktopManifest(
  text: string,
  expected: {
    version: string
    channel: DesktopReleaseChannel
    artifacts: DesktopReleaseArtifact[]
    notes?: string
    stableTag?: string
  },
): void {
  assertUniqueArtifacts(expected.artifacts)
  const parsed = JSON.parse(text) as Partial<DesktopManifest>
  const releaseTag = desktopReleaseTag(expected.channel, expected.version, expected.stableTag)
  if (parsed.version !== expected.version) {
    throw new Error(`manifest version mismatch: expected ${expected.version}`)
  }
  const expectedTargets = expected.artifacts.map((artifact) => artifact.target).sort()
  const actualTargets = Object.keys(parsed.platforms ?? {}).sort()
  if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) {
    throw new Error(
      `manifest platform mismatch: expected ${expectedTargets.join(', ')}, found ${actualTargets.join(', ')}`,
    )
  }
  for (const artifact of expected.artifacts) {
    const expectedUrl = `https://github.com/madeinorbit/podium/releases/download/${releaseTag}/${artifact.artifactName}`
    const platform = parsed.platforms?.[artifact.target]
    if (!platform) throw new Error(`manifest is missing platform ${artifact.target}`)
    if (platform.url !== expectedUrl) {
      throw new Error(`manifest URL mismatch: expected ${expectedUrl}`)
    }
    if (platform.signature !== artifact.signature) {
      throw new Error(
        `manifest signature for ${artifact.target} does not match the detached .sig contents`,
      )
    }
  }
  if (parsed.notes !== (expected.notes || undefined)) {
    throw new Error('manifest notes do not match the requested release notes')
  }
}

function filesBelow(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) files.push(...filesBelow(path))
    else files.push(path)
  }
  return files
}

function exactlyOne(files: string[], suffix: string, description: string): string {
  const matches = files.filter((path) => basename(path).endsWith(suffix))
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${description}; found ${matches.length}`)
  }
  return matches[0] ?? ''
}

export function prepareDesktopRelease(input: {
  version: string
  channel: DesktopReleaseChannel
  bundleDir: string
  outputDir: string
  notes?: string
  stableTag?: string
}): {
  artifactPaths: string[]
  signaturePaths: string[]
  downloadPaths: string[]
  manifestPath: string
  releaseTag: string
} {
  const files = filesBelow(input.bundleDir)
  const artifacts: DesktopReleaseArtifact[] = []
  const updaterSources: Array<{ source: string; name: string }> = []
  const signatureSources: Array<{ source: string; name: string }> = []
  const downloadSources: string[] = []

  for (const bundle of targetBundles) {
    const bundleFiles = files.filter((path) => bundle.matches?.(path) ?? true)
    const updaterSource = exactlyOne(
      bundleFiles.filter((path) => !path.endsWith('.sig')),
      bundle.updaterSuffix,
      `${bundle.target} updater artifact ending in ${bundle.updaterSuffix}`,
    )
    const signatureSource = `${updaterSource}.sig`
    if (!existsSync(signatureSource)) {
      throw new Error(`missing detached signature ${signatureSource}`)
    }
    const signature = readFileSync(signatureSource, 'utf8').trim()
    if (!signature) throw new Error(`detached signature is empty: ${signatureSource}`)

    const artifactName = bundle.publishedUpdaterName?.(input.version) ?? basename(updaterSource)
    updaterSources.push({ source: updaterSource, name: artifactName })
    signatureSources.push({ source: signatureSource, name: `${artifactName}.sig` })
    artifacts.push({
      target: bundle.target,
      artifactName,
      signature,
    })
    for (const suffix of bundle.requiredDownloadSuffixes) {
      downloadSources.push(
        exactlyOne(bundleFiles, suffix, `${bundle.target} download ending in ${suffix}`),
      )
    }
  }

  const manifest = buildDesktopManifest({
    version: input.version,
    channel: input.channel,
    artifacts,
    notes: input.notes,
    stableTag: input.stableTag,
  })
  validateDesktopManifest(manifest, {
    version: input.version,
    channel: input.channel,
    artifacts,
    notes: input.notes,
    stableTag: input.stableTag,
  })

  rmSync(input.outputDir, { recursive: true, force: true })
  mkdirSync(input.outputDir, { recursive: true })
  const copyNamedSources = (sources: Array<{ source: string; name: string }>): string[] =>
    sources.map(({ source, name }) => {
      const destination = join(input.outputDir, name)
      copyFileSync(source, destination)
      return destination
    })
  const artifactPaths = copyNamedSources(updaterSources)
  const signaturePaths = copyNamedSources(signatureSources)
  const downloadPaths = copyNamedSources(
    downloadSources.map((source) => ({ source, name: basename(source) })),
  )
  const manifestPath = join(input.outputDir, 'latest.json')
  writeFileSync(manifestPath, manifest)

  return {
    artifactPaths,
    signaturePaths,
    downloadPaths,
    manifestPath,
    releaseTag: desktopReleaseTag(input.channel, input.version, input.stableTag),
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/**
 * Release notes for a desktop release, taken from CHANGELOG.md under the version's own heading.
 *
 * Notes live in the repository, not in a workflow input, so they are written and reviewed in the
 * same commit that names the version and a tag push carries them without anyone opening the
 * Actions UI. This is the source the headless release already reads (`scripts/release.ts`), so
 * both halves of one release quote the same text rather than two operators' recollections.
 *
 * An explicit `--notes` still wins, for the occasional re-promotion that needs different wording
 * without rewriting history.
 */
export function resolveNotes(
  version: string,
  explicit?: string,
  changelogPath = 'CHANGELOG.md',
): string | undefined {
  if (explicit) return explicit
  try {
    return extractRelease(readFileSync(changelogPath, 'utf8'), version)?.summary
  } catch {
    // A missing changelog is not a reason to fail a release that is otherwise sound.
    return undefined
  }
}

function main(): void {
  // Reads the release's current asset names from stdin and prints the desktop assets this
  // prepared output does not replace, one per line, for the workflow to delete.
  if (process.argv.includes('--list-stale')) {
    const existing = readFileSync(0, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const current = readdirSync(arg('--output-dir') ?? 'dist-desktop')
    for (const name of staleDesktopAssets(existing, current)) console.log(name)
    return
  }
  const channel = arg('--channel')
  if (channel !== 'stable' && channel !== 'edge') {
    throw new Error('--channel must be stable or edge')
  }
  const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
  const version = arg('--version') ?? rootPackage.version
  if (!version) throw new Error('desktop release version is missing')
  const stableTag = arg('--tag')
  const releaseTag = desktopReleaseTag(channel, version, stableTag)
  if (process.argv.includes('--validate-only')) {
    console.log(`[desktop-release] validated ${version} for ${channel} at ${releaseTag}`)
    return
  }
  const result = prepareDesktopRelease({
    version,
    channel,
    stableTag,
    notes: resolveNotes(version, arg('--notes')),
    bundleDir: arg('--bundle-dir') ?? 'apps/desktop/src-tauri/target',
    outputDir: arg('--output-dir') ?? 'dist-desktop',
  })
  console.log(`[desktop-release] prepared ${version} for ${channel} at ${result.manifestPath}`)
}

if (import.meta.main) main()
