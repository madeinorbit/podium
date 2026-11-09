/** Copy existing accepted releases to R2; no signing key or GitHub mutation is used. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  PRIMARY_RELEASE_ORIGIN,
  type ReleaseChannel,
  releaseTagPath,
  releaseUrl,
  resolveReleaseArtifact,
} from '../packages/runtime/src/release-origins'
import { verifyTarball } from '../packages/runtime/src/update-delivery'
import { publishReleaseMirror } from './release-mirror'

type Json = Record<string, unknown>
export type ReleaseAsset = { name: string; size: number; digest?: string | null; state?: string }
export type PublishedRelease = {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: ReleaseAsset[]
}
export type MirrorReference = {
  item: Json
  url: string
  kind: 'headless' | 'desktop' | 'download'
  signature?: string
  digest?: string
}
export type BackfillDeps = {
  release: (tag: string) => PublishedRelease | undefined
  download: (tag: string, asset: ReleaseAsset, path: string) => void
  verifyHeadless: (path: string, signature: string) => void
  verifyDesktop: (path: string, signaturePath: string) => void
  publish: typeof publishReleaseMirror
  installer: string
}
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid release document')
  return value as Json
}

/** Only artifact fields are traversed; notes and arbitrary external links are not downloads. */
export function mirrorReferences(name: string, manifest: Json): MirrorReference[] {
  const result: MirrorReference[] = []
  const platforms = (table: unknown, kind: 'headless' | 'desktop') => {
    if (table === undefined) return
    for (const raw of Object.values(object(table))) {
      const item = object(raw)
      if (typeof item.url !== 'string' || typeof item.signature !== 'string' || !item.signature)
        throw new Error('release artifact is missing its URL or signature')
      if (item.digest !== undefined && typeof item.digest !== 'string')
        throw new Error('invalid artifact digest')
      result.push({
        item,
        url: item.url,
        kind,
        signature: item.signature,
        ...(typeof item.digest === 'string' ? { digest: item.digest } : {}),
      })
    }
  }
  platforms(manifest.platforms, name === 'latest.json' ? 'desktop' : 'headless')
  if (manifest.artifacts !== undefined) {
    const artifacts = object(manifest.artifacts)
    for (const kind of ['headless', 'desktop'] as const) {
      if (artifacts[kind] !== undefined) platforms(object(artifacts[kind]).platforms, kind)
    }
    if (artifacts.headlessAlternatives !== undefined) {
      if (!Array.isArray(artifacts.headlessAlternatives))
        throw new Error('invalid headless alternatives')
      for (const alternative of artifacts.headlessAlternatives)
        platforms(object(alternative).platforms, 'headless')
    }
  }
  if (!result.length) throw new Error(`${name} names no signed artifacts`)
  if (manifest.downloads !== undefined) {
    if (!Array.isArray(manifest.downloads)) throw new Error('invalid installer downloads')
    for (const url of manifest.downloads) {
      if (typeof url !== 'string') throw new Error('invalid installer URL')
      result.push({ item: {}, url, kind: 'download' })
    }
  }
  return result
}

/** Keep tag/name boundaries exact, even when a carried-forward shell lives on an older tag. */
export function githubAssetLocation(
  url: string,
  stableTag?: string,
): { tag: string; name: string } {
  const canonical = new URL(resolveReleaseArtifact(url, PRIMARY_RELEASE_ORIGIN))
  const path = canonical.pathname.slice(new URL(PRIMARY_RELEASE_ORIGIN.baseUrl).pathname.length)
  let [kind, tag, name, extra] = path.split('/')
  if (kind === 'latest' && tag === 'download' && stableTag) tag = stableTag
  else if (kind !== 'download') throw new Error('artifact does not name a release tag')
  if (canonical.search || canonical.hash || !tag || !name || extra !== undefined)
    throw new Error('unsafe release asset path')
  tag = decodeURIComponent(tag)
  name = decodeURIComponent(name)
  if (
    !/^[A-Za-z0-9._+-]+$/.test(name) ||
    name === '.' ||
    name === '..' ||
    tag.includes('/') ||
    tag === '.' ||
    tag === '..'
  )
    throw new Error('unsafe release asset name')
  return { tag, name }
}

export function backfillReleaseMirrors(
  channels: readonly ReleaseChannel[],
  deps: BackfillDeps,
  env: NodeJS.ProcessEnv = process.env,
): { channels: ReleaseChannel[]; files: number; headless: number; desktop: number } {
  if (env.PODIUM_PUBLISH_RELEASE_MIRROR !== '1')
    throw new Error('backfill requires explicit mirror publication')
  for (const key of [
    'PODIUM_RELEASE_R2_ENDPOINT',
    'PODIUM_RELEASE_R2_BUCKET',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ])
    if (!env[key]) throw new Error(`backfill requires ${key}`)
  const dir = mkdtempSync(join(tmpdir(), 'podium-release-backfill-'))
  type File = { path: string; sha256: string }
  type Group = { files: Map<string, File>; aliases: Set<string> }
  const groups = new Map<string, Group>()
  const releases = new Map<string, PublishedRelease | undefined>()
  const getRelease = (tag: string) => {
    if (!releases.has(tag)) {
      const release = deps.release(tag)
      if (release?.draft) throw new Error('refusing a draft release')
      releases.set(tag, release)
      if (release) releases.set(release.tag_name, release)
    }
    return releases.get(tag)
  }
  const group = (tag: string): Group => {
    let value = groups.get(tag)
    if (!value) {
      value = { files: new Map(), aliases: new Set() }
      groups.set(tag, value)
    }
    return value
  }
  const stage = (tag: string, name: string): File => {
    const value = group(tag)
    const existing = value.files.get(name)
    if (existing) return existing
    if (!/^[A-Za-z0-9._+-]+$/.test(name) || name === '.' || name === '..')
      throw new Error('unsafe release asset name')
    const asset = getRelease(tag)?.assets.find((item) => item.name === name)
    if (!asset || (asset.state !== undefined && asset.state !== 'uploaded'))
      throw new Error(`missing published asset ${tag}/${name}`)
    const folder = join(dir, encodeURIComponent(tag))
    mkdirSync(folder, { recursive: true })
    const path = join(folder, name)
    deps.download(tag, asset, path)
    const bytes = readFileSync(path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== asset.size || (asset.digest && asset.digest !== `sha256:${sha256}`))
      throw new Error(`published asset digest/size changed: ${tag}/${name}`)
    const file = { path, sha256 }
    value.files.set(name, file)
    if (/^podium-headless-[a-z0-9-]+\.tar\.gz(?:\.sig)?$/.test(name) || name === 'install.sh')
      value.aliases.add(name)
    return file
  }
  const roots: Array<{
    channel: ReleaseChannel
    tag: string
    documents: Array<{ path: string; manifest: Json; references: MirrorReference[] }>
  }> = []
  const verified = new Set<string>()
  let headless = 0
  let desktop = 0
  try {
    const stable = channels.includes('stable') ? getRelease('latest') : undefined
    for (const channel of [...new Set(channels)]) {
      const release = channel === 'stable' ? stable : getRelease(channel)
      if (!release) continue // Only a real 404 means the channel does not exist.
      if (channel === 'stable' && release.prerelease)
        throw new Error('stable points at a prerelease')
      if (channel !== 'stable' && release.tag_name !== channel)
        throw new Error('standing channel tag mismatch')
      const documents = ['podium-update.json', 'latest.json']
        .filter((name) => release.assets.some((asset) => asset.name === name))
        .map((name) => {
          const file = stage(release.tag_name, name)
          const manifest = object(JSON.parse(readFileSync(file.path, 'utf8')))
          return { path: file.path, manifest, references: mirrorReferences(name, manifest) }
        })
      if (!documents.length) throw new Error(`release ${release.tag_name} has no update documents`)
      roots.push({ channel, tag: release.tag_name, documents })
      for (const asset of release.assets) stage(release.tag_name, asset.name)
    }
    if (!roots.length) throw new Error('no published release channels found')
    // Validate the entire referenced closure before the first R2 write.
    for (const root of roots)
      for (const document of root.documents)
        for (const reference of document.references) {
          const location = githubAssetLocation(reference.url, stable?.tag_name)
          const file = stage(location.tag, location.name)
          if (
            reference.digest &&
            reference.digest !== `sha256-${Buffer.from(file.sha256, 'hex').toString('base64')}`
          )
            throw new Error(`manifest digest disagrees: ${location.tag}/${location.name}`)
          if (reference.kind === 'download') continue
          const signature = stage(location.tag, `${location.name}.sig`)
          if (readFileSync(signature.path, 'utf8').trim() !== reference.signature?.trim())
            throw new Error('detached signature disagrees with manifest')
          const key = `${reference.kind}:${reference.url}:${reference.signature}`
          if (!verified.has(key)) {
            if (reference.kind === 'headless') {
              deps.verifyHeadless(file.path, reference.signature!)
              headless++
            } else {
              deps.verifyDesktop(file.path, signature.path)
              desktop++
            }
            verified.add(key)
          }
          // Freeze legacy rolling headless names before advertising them. Installer aliases switch last.
          if (
            reference.kind === 'headless' &&
            /^podium-headless-[a-z0-9-]+\.tar\.gz$/.test(location.name)
          ) {
            const name = location.name.replace('.tar.gz', `-${file.sha256}.tar.gz`)
            const files = group(location.tag).files
            for (const [next, source] of [
              [name, file],
              [`${name}.sig`, signature],
            ] as const) {
              const path = join(dir, encodeURIComponent(location.tag), next)
              copyFileSync(source.path, path)
              files.set(next, { path, sha256: source.sha256 })
            }
            reference.item.url = releaseUrl(
              releaseTagPath(location.tag) + name,
              PRIMARY_RELEASE_ORIGIN,
            )
          }
        }
    for (const root of roots) {
      for (const document of root.documents)
        writeFileSync(document.path, JSON.stringify(document.manifest, null, 2) + '\n')
      const installer = group(root.tag).files.get('install.sh')
      if (installer) copyFileSync(deps.installer, installer.path)
    }
    const upload = (
      tag: string,
      channel: ReleaseChannel,
      phase: 'payloads' | 'discovery' | 'aliases',
      destination: 'tag' | 'latest',
    ) => {
      const value = group(tag)
      deps.publish(
        {
          tag,
          channel,
          phase,
          destination,
          files: [...value.files.values()].map((file) => file.path),
          aliases: [...value.aliases].map((name) => value.files.get(name)!.path),
        },
        env,
      )
    }
    const channelFor = (tag: string): ReleaseChannel =>
      roots.find((root) => root.tag === tag)?.channel ?? 'stable'
    for (const tag of groups.keys()) upload(tag, channelFor(tag), 'payloads', 'tag')
    // Payloads on EVERY referenced tag are present before ANY discovery document is visible.
    for (const root of roots) upload(root.tag, root.channel, 'discovery', 'tag')
    for (const tag of groups.keys()) upload(tag, channelFor(tag), 'aliases', 'tag')
    const stableRoot = roots.find((root) => root.channel === 'stable')
    if (stableRoot) {
      if (deps.release('latest')?.tag_name !== stableRoot.tag)
        throw new Error('latest moved during backfill; refusing stale promotion')
      for (const phase of ['payloads', 'discovery', 'aliases'] as const)
        upload(stableRoot.tag, 'stable', phase, 'latest')
    }
    return {
      channels: roots.map((root) => root.channel),
      files: [...groups.values()].reduce((n, value) => n + value.files.size, 0),
      headless,
      desktop,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Tauri stores the minisign text as base64; keep the published sidecar unchanged. */
export function desktopSignatureText(text: string): string {
  const raw = text.trim()
  const decoded = raw.startsWith('untrusted comment:')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8')
  if (!decoded.startsWith('untrusted comment:') || decoded.split('\n').length < 4)
    throw new Error('invalid desktop signature encoding')
  return decoded
}

/** Retry only temporary GitHub transport failures; missing or rejected assets stay fatal. */
export function retryGithubTransfer<T>(
  transfer: () => T,
  sleep: (ms: number) => void = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  },
): T {
  const waits = [5_000, 15_000, 30_000]
  for (let attempt = 0; ; attempt++) {
    try {
      return transfer()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        attempt >= waits.length ||
        !/HTTP (?:429|5\d{2})\b|connection reset|tls handshake timeout|i\/o timeout|unexpected EOF|temporary failure in name resolution/i.test(
          message,
        )
      )
        throw error
      console.warn(`[release-mirror-backfill] GitHub transfer retry ${attempt + 1}/${waits.length}`)
      sleep(waits[attempt]!)
    }
  }
}

function cliDeps(): BackfillDeps {
  const repo = 'madeinorbit/podium'
  const desktopVerifier = process.env.PODIUM_MIRROR_DESKTOP_VERIFIER
  const config = JSON.parse(
    readFileSync(join(import.meta.dir, '../apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  )
  const publicKey = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8')
  return {
    release: (tag) => {
      const endpoint =
        tag === 'latest'
          ? `repos/${repo}/releases/latest`
          : `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
      return retryGithubTransfer(() => {
        const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8' })
        if (result.status !== 0) {
          if (/\bHTTP 404\b/.test(result.stderr)) return undefined
          throw new Error(`release inventory unavailable: ${result.stderr.trim()}`)
        }
        return JSON.parse(result.stdout) as PublishedRelease
      })
    },
    download: (tag, asset, path) =>
      retryGithubTransfer(() =>
        execFileSync(
          'gh',
          [
            'release',
            'download',
            tag,
            '--repo',
            repo,
            '--pattern',
            asset.name,
            '--dir',
            dirname(path),
            '--clobber',
          ],
          { stdio: 'pipe' },
        ),
      ),
    verifyHeadless: (path, signature) => {
      if (!verifyTarball(readFileSync(path), signature))
        throw new Error('headless release signature verification failed')
    },
    verifyDesktop: (path, signature) => {
      if (!desktopVerifier) throw new Error('PODIUM_MIRROR_DESKTOP_VERIFIER is required')
      const decoded = `${signature}.minisign`
      writeFileSync(decoded, desktopSignatureText(readFileSync(signature, 'utf8')))
      execFileSync(desktopVerifier, [publicKey, path, decoded], { stdio: 'pipe' })
    },
    publish: publishReleaseMirror,
    installer: join(import.meta.dir, '../install.sh'),
  }
}
if (import.meta.main) {
  if (!process.argv.includes('--execute')) throw new Error('backfill requires --execute')
  const at = process.argv.indexOf('--channels')
  const value = at < 0 ? 'all' : process.argv[at + 1]
  const channels = value === 'all' ? ['stable', 'edge', 'dev'] : value?.split(',')
  if (!channels?.length || channels.some((channel) => !['stable', 'edge', 'dev'].includes(channel)))
    throw new Error('invalid backfill channels')
  const result = backfillReleaseMirrors(channels as ReleaseChannel[], cliDeps())
  const reportAt = process.argv.indexOf('--report')
  if (reportAt >= 0) {
    const report = process.argv[reportAt + 1]
    if (!report) throw new Error('--report needs a path')
    writeFileSync(report, JSON.stringify(result, null, 2) + '\n')
  }
  console.log('[release-mirror-backfill]', JSON.stringify(result))
}
