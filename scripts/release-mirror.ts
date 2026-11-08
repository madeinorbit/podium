/** R2 publication is deliberately disabled unless CI explicitly opts in. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  MIRROR_RELEASE_ORIGIN,
  PRIMARY_RELEASE_ORIGIN,
  RELEASE_PATHS,
  type ReleaseChannel,
  releaseTagPath,
  releaseUrl,
  resolveReleaseArtifact,
} from '../packages/runtime/src/release-origins'

export const MIRROR_PUBLISH_SWITCH = 'PODIUM_PUBLISH_RELEASE_MIRROR'

/** Only artifact references change; bytes, signatures, digests and release notes do not. */
export function mirrorManifest(text: string): string {
  const manifest = JSON.parse(text)
  const rebind = (name: string) => {
    const url = resolveReleaseArtifact(name, PRIMARY_RELEASE_ORIGIN)
    return releaseUrl(
      new URL(url).pathname.slice(new URL(PRIMARY_RELEASE_ORIGIN.baseUrl).pathname.length),
      MIRROR_RELEASE_ORIGIN,
    )
  }
  const platforms = (values: Record<string, { url: string }> | undefined) => {
    for (const artifact of Object.values(values ?? {})) artifact.url = rebind(artifact.url)
  }
  platforms(manifest.platforms)
  platforms(manifest.artifacts?.headless?.platforms)
  platforms(manifest.artifacts?.desktop?.platforms)
  for (const delivery of manifest.artifacts?.headlessAlternatives ?? [])
    platforms(delivery.platforms)
  if (manifest.downloads) manifest.downloads = manifest.downloads.map(rebind)
  return JSON.stringify(manifest, null, 2) + '\n'
}

export function mirrorUploadPrefixes(channel: ReleaseChannel, tag: string): string[] {
  return [releaseTagPath(tag), ...(channel === 'stable' ? [RELEASE_PATHS.latest] : [])]
}

export function publishReleaseMirror(
  input: {
    channel: ReleaseChannel
    tag: string
    files: string[]
  },
  env: NodeJS.ProcessEnv = process.env,
  exec: typeof execFileSync = execFileSync,
): void {
  if (env[MIRROR_PUBLISH_SWITCH] !== '1') return
  const endpoint = env.PODIUM_RELEASE_R2_ENDPOINT
  const bucket = env.PODIUM_RELEASE_R2_BUCKET
  if (!endpoint || !bucket || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('mirror publishing needs the R2 endpoint, bucket and CI-only AWS credentials')
  }
  const staging = mkdtempSync(join(tmpdir(), 'podium-release-mirror-'))
  try {
    for (const file of input.files) {
      const name = basename(file)
      const bytes = readFileSync(file)
      writeFileSync(
        join(staging, name),
        ['podium-update.json', 'latest.json'].includes(name)
          ? mirrorManifest(bytes.toString('utf8'))
          : bytes,
      )
    }
    // Manifest URLs change, so regenerate the checksum inventory for the mirror copy.
    if (input.files.some((file) => basename(file) === 'SHA256SUMS')) {
      writeFileSync(
        join(staging, 'SHA256SUMS'),
        readdirSync(staging)
          .filter((name) => name !== 'SHA256SUMS')
          .sort()
          .map(
            (name) =>
              `${createHash('sha256')
                .update(readFileSync(join(staging, name)))
                .digest('hex')}  ${name}\n`,
          )
          .join(''),
      )
    }
    for (const prefix of mirrorUploadPrefixes(input.channel, input.tag)) {
      // Payloads precede discovery documents. Never delete the other publisher's files.
      const names = readdirSync(staging).sort(
        (a, b) => Number(a.endsWith('.json')) - Number(b.endsWith('.json')),
      )
      for (const name of names)
        exec(
          'aws',
          [
            's3',
            'cp',
            join(staging, name),
            `s3://${bucket}/${prefix}${name}`,
            '--endpoint-url',
            endpoint,
            '--region',
            'auto',
            '--only-show-errors',
            '--cache-control',
            name.endsWith('.json') ? 'no-cache' : 'public, max-age=300',
          ],
          { env, stdio: 'inherit' },
        )
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const arg = (name: string) => {
    const index = process.argv.indexOf(name)
    return index < 0 ? undefined : process.argv[index + 1]
  }
  const channel = arg('--channel')
  const tag = arg('--tag')
  const dir = arg('--dir')
  if (!['stable', 'edge', 'dev'].includes(channel ?? '') || !tag || !dir)
    throw new Error('need --channel, --tag and --dir')
  publishReleaseMirror({
    channel: channel as ReleaseChannel,
    tag,
    files: readdirSync(dir).map((name) => join(dir, name)),
  })
}
