/**
 * Prepare the signed Tauri AppImage and its static updater manifest for an explicitly
 * promoted stable or edge desktop release. This script never publishes. [spec:SP-7f2c]
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

export type DesktopReleaseChannel = 'stable' | 'edge'

type DesktopManifest = {
  version: string
  notes?: string
  platforms: Record<string, { url: string; signature: string }>
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

export function buildDesktopManifest(input: {
  version: string
  channel: DesktopReleaseChannel
  artifactName: string
  signature: string
  notes?: string
  stableTag?: string
  target?: string
}): string {
  const releaseTag = desktopReleaseTag(input.channel, input.version, input.stableTag)
  const target = input.target ?? 'linux-x86_64'
  const url = `https://github.com/madeinorbit/podium/releases/download/${releaseTag}/${input.artifactName}`
  return `${JSON.stringify(
    {
      version: input.version,
      ...(input.notes ? { notes: input.notes } : {}),
      platforms: { [target]: { url, signature: input.signature } },
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
    artifactName: string
    signature: string
    notes?: string
    stableTag?: string
    target?: string
  },
): void {
  const parsed = JSON.parse(text) as Partial<DesktopManifest>
  const target = expected.target ?? 'linux-x86_64'
  const releaseTag = desktopReleaseTag(expected.channel, expected.version, expected.stableTag)
  const expectedUrl = `https://github.com/madeinorbit/podium/releases/download/${releaseTag}/${expected.artifactName}`
  if (parsed.version !== expected.version) {
    throw new Error(`manifest version mismatch: expected ${expected.version}`)
  }
  const platform = parsed.platforms?.[target]
  if (!platform) throw new Error(`manifest is missing platform ${target}`)
  if (platform.url !== expectedUrl) {
    throw new Error(`manifest URL mismatch: expected ${expectedUrl}`)
  }
  if (platform.signature !== expected.signature) {
    throw new Error('manifest signature does not match the detached .sig contents')
  }
  if (parsed.notes !== (expected.notes || undefined)) {
    throw new Error('manifest notes do not match the requested release notes')
  }
}

export function prepareDesktopRelease(input: {
  version: string
  channel: DesktopReleaseChannel
  bundleDir: string
  outputDir: string
  notes?: string
  stableTag?: string
}): { artifactPath: string; signaturePath: string; manifestPath: string; releaseTag: string } {
  const appImages = readdirSync(input.bundleDir).filter((name) => name.endsWith('.AppImage'))
  if (appImages.length !== 1) {
    throw new Error(
      `expected exactly one AppImage in ${input.bundleDir}; found ${appImages.length}`,
    )
  }
  const artifactName = basename(appImages[0] ?? '')
  const sourceArtifact = join(input.bundleDir, artifactName)
  const sourceSignature = `${sourceArtifact}.sig`
  if (!existsSync(sourceSignature)) throw new Error(`missing detached signature ${sourceSignature}`)
  const signature = readFileSync(sourceSignature, 'utf8').trim()
  if (!signature) throw new Error(`detached signature is empty: ${sourceSignature}`)

  const manifest = buildDesktopManifest({
    version: input.version,
    channel: input.channel,
    artifactName,
    signature,
    notes: input.notes,
    stableTag: input.stableTag,
  })
  validateDesktopManifest(manifest, {
    version: input.version,
    channel: input.channel,
    artifactName,
    signature,
    notes: input.notes,
    stableTag: input.stableTag,
  })

  rmSync(input.outputDir, { recursive: true, force: true })
  mkdirSync(input.outputDir, { recursive: true })
  const artifactPath = join(input.outputDir, artifactName)
  const signaturePath = `${artifactPath}.sig`
  const manifestPath = join(input.outputDir, 'latest.json')
  copyFileSync(sourceArtifact, artifactPath)
  copyFileSync(sourceSignature, signaturePath)
  writeFileSync(manifestPath, manifest)

  return {
    artifactPath,
    signaturePath,
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
    bundleDir: arg('--bundle-dir') ?? 'apps/desktop/src-tauri/target/release/bundle/appimage',
    outputDir: arg('--output-dir') ?? 'dist-desktop',
  })
  console.log(`[desktop-release] prepared ${version} for ${channel} at ${result.manifestPath}`)
}

if (import.meta.main) main()
