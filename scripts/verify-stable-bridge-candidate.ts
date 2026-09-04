/**
 * Verify the complete stable candidate before a published v0.1.0 install sees it.
 *
 * The private release key is deliberately not an input. The caller supplies the
 * public Ed25519 SPKI baked into v0.1.0, and this script verifies every headless
 * artifact named by podium-update.json. Desktop updater artifacts live in
 * Tauri's separate minisign trust domain, so the caller also supplies a verifier
 * bound to the public key embedded by the shipped v0.1.0 shell. Both halves are
 * checked on the same prepared directory and neither private key is an input.
 */
import { execFileSync } from 'node:child_process'
import { createHash, verify } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

type Reference = { url: string; signature: string; digest?: string }
type Manifest = { version?: unknown; platforms?: unknown; artifacts?: unknown }

/** The Tauri updater public key embedded by the published v0.1.0 desktop shell. */
export const V0_1_0_DESKTOP_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEI5RkE0OUFBNjMwNENDQjcKUldTM3pBUmpxa242dVd6V3FGbi9NRnhlU0lmR0s1RGhqZys2aXpQV0d5VnBXUHVhZ3lGa1Z1d0QK'

function arg(name: string): string {
  const at = process.argv.indexOf(name)
  const value = at >= 0 ? process.argv[at + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

function object(value: unknown, place: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${place} must be an object`)
  }
  return value as Record<string, unknown>
}

function references(value: unknown, place: string): Record<string, Reference> {
  const entries = Object.entries(object(value, place))
  if (entries.length === 0) throw new Error(`${place} has no artifacts`)
  return Object.fromEntries(
    entries.map(([platform, raw]) => {
      const item = object(raw, `${place}.${platform}`)
      if (typeof item.url !== 'string' || item.url.length === 0) {
        throw new Error(`${place}.${platform} has no URL`)
      }
      if (typeof item.signature !== 'string' || item.signature.length === 0) {
        throw new Error(`${place}.${platform} has no signature`)
      }
      if (item.digest !== undefined && typeof item.digest !== 'string') {
        throw new Error(`${place}.${platform} has an invalid digest`)
      }
      return [platform, { url: item.url, signature: item.signature, ...(item.digest ? { digest: item.digest } : {}) }]
    }),
  )
}

function artifactPath(dir: string, tag: string, place: string, urlText: string): string {
  let url: URL
  try {
    url = new URL(urlText)
  } catch {
    throw new Error(`${place} has an invalid URL: ${urlText}`)
  }
  const prefix = `/madeinorbit/podium/releases/download/${tag}/`
  if (
    url.protocol !== 'https:' ||
    url.host !== 'github.com' ||
    !url.pathname.startsWith(prefix) ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${place} points outside the prepared ${tag} release: ${urlText}`)
  }
  const name = basename(url.pathname)
  if (!name || name === '.' || name === '..' || url.pathname !== `${prefix}${name}`) {
    throw new Error(`${place} has an unsafe artifact path: ${urlText}`)
  }
  const path = join(dir, name)
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${place} references missing artifact ${name}`)
  }
  return path
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest
}

export function verifyStableBridgeCandidate(input: {
  dir: string
  version: string
  tag: string
  pubkey: string
  /** Required for a production candidate; omitted only by the run-local fixture. */
  verifyDesktop?: (artifact: string, signature: string) => void
}): { headlessArtifacts: number; desktopArtifacts: number } {
  const release = readManifest(join(input.dir, 'podium-update.json'))
  const desktop = readManifest(join(input.dir, 'latest.json'))
  if (release.version !== input.version || desktop.version !== input.version) {
    throw new Error(
      `candidate manifests must both name ${input.version} (headless=${String(release.version)}, desktop=${String(desktop.version)})`,
    )
  }

  const legacy = references(release.platforms, 'podium-update.json.platforms')
  const artifacts = object(release.artifacts, 'podium-update.json.artifacts')
  const headless = object(artifacts.headless, 'podium-update.json.artifacts.headless')
  if (headless.delivery !== 'feed') throw new Error('headless candidate delivery must be feed')
  const described = references(
    headless.platforms,
    'podium-update.json.artifacts.headless.platforms',
  )
  if (JSON.stringify(Object.keys(legacy).sort()) !== JSON.stringify(Object.keys(described).sort())) {
    throw new Error('legacy and target headless manifests name different platforms')
  }

  const publicKey = {
    key: Buffer.from(input.pubkey, 'base64'),
    format: 'der' as const,
    type: 'spki' as const,
  }
  for (const [platform, reference] of Object.entries(legacy)) {
    const detail = described[platform]
    if (!detail || detail.url !== reference.url || detail.signature !== reference.signature) {
      throw new Error(`legacy and target headless references disagree for ${platform}`)
    }
    const path = artifactPath(input.dir, input.tag, `headless ${platform}`, reference.url)
    const bytes = readFileSync(path)
    if (!verify(null, bytes, publicKey, Buffer.from(reference.signature, 'base64'))) {
      throw new Error(`headless ${platform} artifact is not signed by v0.1.0's baked release key`)
    }
    const sidecar = `${path}.sig`
    if (!existsSync(sidecar) || readFileSync(sidecar, 'utf8').trim() !== reference.signature) {
      throw new Error(`headless ${platform} detached signature disagrees with the manifest`)
    }
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64')}`
    if (detail.digest !== digest) {
      throw new Error(`headless ${platform} digest disagrees with the prepared artifact`)
    }
  }

  const desktopReferences = references(desktop.platforms, 'latest.json.platforms')
  if (!input.verifyDesktop) {
    throw new Error('production candidate verification requires the v0.1.0 desktop updater key')
  }
  for (const [platform, reference] of Object.entries(desktopReferences)) {
    const path = artifactPath(input.dir, input.tag, `desktop ${platform}`, reference.url)
    const sidecar = `${path}.sig`
    if (!existsSync(sidecar) || readFileSync(sidecar, 'utf8').trim() !== reference.signature) {
      throw new Error(`desktop ${platform} detached signature disagrees with latest.json`)
    }
    try {
      input.verifyDesktop(path, sidecar)
    } catch {
      throw new Error(`desktop ${platform} artifact is not signed by v0.1.0's baked updater key`)
    }
  }

  return {
    headlessArtifacts: Object.keys(legacy).length,
    desktopArtifacts: Object.keys(desktopReferences).length,
  }
}

if (import.meta.main) {
  const desktopVerifier = arg('--desktop-verifier')
  const desktopPubkey = arg('--desktop-pubkey')
  const decodedDesktopPubkey = Buffer.from(desktopPubkey, 'base64').toString('utf8')
  const result = verifyStableBridgeCandidate({
    dir: arg('--dir'),
    version: arg('--version'),
    tag: arg('--tag'),
    pubkey: arg('--pubkey'),
    verifyDesktop: (artifact, signature) => {
      execFileSync(desktopVerifier, [decodedDesktopPubkey, artifact, signature], {
        stdio: 'pipe',
      })
    },
  })
  console.log(
    `[stable-bridge] verified ${result.headlessArtifacts} headless and ${result.desktopArtifacts} desktop candidate artifacts`,
  )
}
