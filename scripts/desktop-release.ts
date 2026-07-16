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

export type DesktopReleaseChannel = 'stable' | 'edge'
export type DesktopReleaseTarget = 'linux-x86_64' | 'darwin-aarch64'

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
  requiredDownloadSuffixes: string[]
}

const targetBundles: TargetBundle[] = [
  { target: 'linux-x86_64', updaterSuffix: '.AppImage', requiredDownloadSuffixes: [] },
  {
    target: 'darwin-aarch64',
    updaterSuffix: '.app.tar.gz',
    requiredDownloadSuffixes: ['.dmg'],
  },
]

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
  const updaterSources: string[] = []
  const signatureSources: string[] = []
  const downloadSources: string[] = []

  for (const bundle of targetBundles) {
    const updaterSource = exactlyOne(
      files.filter((path) => !path.endsWith('.sig')),
      bundle.updaterSuffix,
      `${bundle.target} updater artifact ending in ${bundle.updaterSuffix}`,
    )
    const signatureSource = `${updaterSource}.sig`
    if (!existsSync(signatureSource)) {
      throw new Error(`missing detached signature ${signatureSource}`)
    }
    const signature = readFileSync(signatureSource, 'utf8').trim()
    if (!signature) throw new Error(`detached signature is empty: ${signatureSource}`)

    updaterSources.push(updaterSource)
    signatureSources.push(signatureSource)
    artifacts.push({
      target: bundle.target,
      artifactName: basename(updaterSource),
      signature,
    })
    for (const suffix of bundle.requiredDownloadSuffixes) {
      downloadSources.push(
        exactlyOne(files, suffix, `${bundle.target} download ending in ${suffix}`),
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
  const copySources = (sources: string[]): string[] =>
    sources.map((source) => {
      const destination = join(input.outputDir, basename(source))
      copyFileSync(source, destination)
      return destination
    })
  const artifactPaths = copySources(updaterSources)
  const signaturePaths = copySources(signatureSources)
  const downloadPaths = copySources(downloadSources)
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

function main(): void {
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
    notes: arg('--notes'),
    bundleDir: arg('--bundle-dir') ?? 'apps/desktop/src-tauri/target',
    outputDir: arg('--output-dir') ?? 'dist-desktop',
  })
  console.log(`[desktop-release] prepared ${version} for ${channel} at ${result.manifestPath}`)
}

if (import.meta.main) main()
