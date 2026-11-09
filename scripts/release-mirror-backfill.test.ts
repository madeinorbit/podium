import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyTarball } from '../packages/runtime/src/update-delivery'
import { publishReleaseDestinations } from './release-destinations'
import { publishReleaseMirror } from './release-mirror'
import {
  type BackfillDeps,
  backfillReleaseMirrors,
  desktopSignatureText,
  githubAssetLocation,
  type PublishedRelease,
} from './release-mirror-backfill'

const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
const env = {
  PODIUM_PUBLISH_RELEASE_MIRROR: '1',
  PODIUM_RELEASE_R2_ENDPOINT: 'https://fixture.invalid',
  PODIUM_RELEASE_R2_BUCKET: 'fixture',
  AWS_ACCESS_KEY_ID: 'fixture',
  AWS_SECRET_ACCESS_KEY: 'fixture',
}
const url = (tag: string, name: string) =>
  `https://github.com/madeinorbit/podium/releases/download/${tag}/${name}`
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-backfill-test-'))
  scratch.push(dir)
  const installer = join(dir, 'install.sh')
  writeFileSync(installer, 'reviewed installer')
  const key = generateKeyPairSync('ed25519')
  const publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const files = new Map<string, Buffer>()
  const releases = new Map<string, PublishedRelease>()
  const put = (tag: string, name: string, text: string) => {
    const bytes = Buffer.from(text)
    files.set(`${tag}/${name}`, bytes)
    const release = releases.get(tag) ?? {
      tag_name: tag,
      draft: false,
      prerelease: tag === 'edge',
      assets: [],
    }
    release.assets.push({
      name,
      size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      state: 'uploaded',
    })
    releases.set(tag, release)
  }
  const asset = 'podium-headless-linux-x64.tar.gz'
  const bytes = Buffer.from('signed headless fixture')
  const signature = sign(null, bytes, key.privateKey).toString('base64')
  const headless = {
    url: url('v2.0.0', asset),
    signature,
    digest: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
  }
  put('v2.0.0', asset, bytes.toString())
  put('v2.0.0', asset + '.sig', signature)
  put('v2.0.0', 'install.sh', 'old installer')
  put('v2.0.0', 'SHA256SUMS', 'old inventory')
  put('v1.0.0', 'Podium_old.app.tar.gz', 'signed desktop fixture')
  put('v1.0.0', 'Podium_old.app.tar.gz.sig', 'desktop signature')
  put('v1.0.0', 'Podium_old.dmg', 'installer fixture')
  const desktop = { url: url('v1.0.0', 'Podium_old.app.tar.gz'), signature: 'desktop signature' }
  put(
    'v2.0.0',
    'podium-update.json',
    JSON.stringify({
      version: '2.0.0',
      platforms: { linux: headless },
      artifacts: {
        headless: { platforms: { linux: headless } },
        desktop: { platforms: { darwin: desktop } },
      },
    }),
  )
  put(
    'v2.0.0',
    'latest.json',
    JSON.stringify({
      version: '1.0.0',
      platforms: { darwin: desktop },
      downloads: [url('v1.0.0', 'Podium_old.dmg')],
    }),
  )
  const uploaded: Array<{ key: string; bytes: Buffer }> = []
  const exec = vi.fn((_command: string, args: string[]) => {
    uploaded.push({ key: args[3]!, bytes: readFileSync(args[2]!) })
  })
  const deps: BackfillDeps = {
    release: (tag) => releases.get(tag === 'latest' ? 'v2.0.0' : tag),
    download: (tag, item, path) => writeFileSync(path, files.get(`${tag}/${item.name}`)!),
    verifyHeadless: (path, signature) => {
      if (!verifyTarball(readFileSync(path), signature, publicKey)) throw new Error('bad signature')
    },
    verifyDesktop: vi.fn(),
    publish: (input, env) => publishReleaseMirror(input, env, exec as never),
    installer,
  }
  return { deps, files, releases, put, uploaded, headless, asset }
}

describe('verified mirror backfill', () => {
  it('copies older shell objects first, freezes headless aliases, and promotes stable last', () => {
    const f = fixture()
    const result = backfillReleaseMirrors(['stable'], f.deps, env)
    expect(result).toMatchObject({ channels: ['stable'], headless: 1, desktop: 1 })
    const manifestIndex = f.uploaded.findIndex((item) =>
      item.key.endsWith('/download/v2.0.0/podium-update.json'),
    )
    expect(
      f.uploaded.findIndex((item) => item.key.endsWith('/download/v1.0.0/Podium_old.app.tar.gz')),
    ).toBeLessThan(manifestIndex)
    const manifest = JSON.parse(f.uploaded[manifestIndex]!.bytes.toString())
    const frozen = manifest.artifacts.headless.platforms.linux.url
    expect(frozen).toMatch(
      /releases\.podium\.do\/download\/v2\.0\.0\/podium-headless-linux-x64-[a-f0-9]{64}\.tar\.gz$/,
    )
    expect(f.uploaded.findIndex((item) => item.key.endsWith('/' + basename(frozen)))).toBeLessThan(
      manifestIndex,
    )
    expect(
      f.uploaded.findIndex((item) => item.key.endsWith('/download/v2.0.0/' + f.asset)),
    ).toBeGreaterThan(manifestIndex)
    const latestIndex = f.uploaded.findIndex((item) => item.key.startsWith('s3://fixture/latest/'))
    expect(latestIndex).toBeGreaterThan(manifestIndex)
    expect(f.uploaded.some((item) => item.key.startsWith('s3://fixture/latest/Podium_old'))).toBe(
      false,
    )
    expect(
      f.uploaded
        .filter((item) => item.key.endsWith('/install.sh'))
        .every((item) => item.bytes.toString() === 'reviewed installer'),
    ).toBe(true)
    const sums = f.uploaded
      .find((item) => item.key.endsWith('/download/v2.0.0/SHA256SUMS'))!
      .bytes.toString()
    expect(sums).toContain(basename(frozen))
  })

  it.each([
    'size',
    'signature',
    'missing',
    'foreign',
  ] as const)('refuses %s faults before any R2 write', (fault) => {
    const f = fixture()
    if (fault === 'size') f.files.set(`v2.0.0/${f.asset}`, Buffer.from('tampered'))
    if (fault === 'signature')
      f.deps.verifyHeadless = () => {
        throw new Error('bad signature')
      }
    if (fault === 'missing') f.releases.delete('v1.0.0')
    if (fault === 'foreign') {
      const text = f.files
        .get('v2.0.0/latest.json')!
        .toString()
        .replaceAll('github.com/madeinorbit/podium', 'evil.invalid/madeinorbit/podium')
      const entry = f.releases.get('v2.0.0')!.assets.find((item) => item.name === 'latest.json')!
      f.files.set('v2.0.0/latest.json', Buffer.from(text))
      entry.size = Buffer.byteLength(text)
      entry.digest = `sha256:${createHash('sha256').update(text).digest('hex')}`
    }
    expect(() => backfillReleaseMirrors(['stable'], f.deps, env)).toThrow()
    expect(f.uploaded).toEqual([])
  })

  it('fails closed when the desktop verifier rejects a carried-forward signature', () => {
    const f = fixture()
    f.deps.verifyDesktop = () => {
      throw new Error('invalid minisign')
    }
    expect(() => backfillReleaseMirrors(['stable'], f.deps, env)).toThrow('invalid minisign')
    expect(f.uploaded).toEqual([])
  })

  it('requires explicit publication and complete scoped credentials before reading inventory', () => {
    const f = fixture()
    f.deps.release = vi.fn()
    expect(() => backfillReleaseMirrors(['stable'], f.deps, {})).toThrow('explicit')
    expect(() =>
      backfillReleaseMirrors(['stable'], f.deps, { PODIUM_PUBLISH_RELEASE_MIRROR: '1' }),
    ).toThrow('PODIUM_RELEASE_R2_ENDPOINT')
    expect(f.deps.release).not.toHaveBeenCalled()
  })

  it('refuses a stale latest promotion if another stable release appeared during backfill', () => {
    const f = fixture()
    let reads = 0
    const original = f.deps.release
    f.deps.release = (tag) =>
      tag === 'latest' && ++reads > 1
        ? { ...f.releases.get('v2.0.0')!, tag_name: 'v3.0.0' }
        : original(tag)
    expect(() => backfillReleaseMirrors(['stable'], f.deps, env)).toThrow('latest moved')
    expect(f.uploaded.some((item) => item.key.startsWith('s3://fixture/latest/'))).toBe(false)
  })

  it('rejects foreign and ambiguous tag boundaries', () => {
    expect(() => githubAssetLocation('https://evil.invalid/a')).toThrow()
    expect(() => githubAssetLocation(url('edge', '../outside'))).toThrow()
    expect(() => githubAssetLocation(url('edge', 'a?query'))).toThrow()
    expect(githubAssetLocation(url('v1.0.0', 'payload.tar.gz'))).toEqual({
      tag: 'v1.0.0',
      name: 'payload.tar.gz',
    })
  })
})

describe('accepted candidate destinations', () => {
  it('publishes to R2 even when GitHub fails and still reports the GitHub failure', () => {
    const mirror = vi.fn()
    expect(() =>
      publishReleaseDestinations(() => {
        throw new Error('GitHub unavailable')
      }, mirror),
    ).toThrow('GitHub unavailable')
    expect(mirror).toHaveBeenCalledOnce()
  })
  it('reports both failures and never treats a missing mirror upload as success', () => {
    expect(() =>
      publishReleaseDestinations(
        () => {
          throw new Error('github')
        },
        () => {
          throw new Error('mirror')
        },
      ),
    ).toThrow(AggregateError)
  })
})

describe('desktop signature transport encoding', () => {
  it('decodes the Tauri base64 envelope and preserves raw minisign text', () => {
    const text = 'untrusted comment: fixture\nfirst\ntrusted comment: fixture\nsecond'
    expect(desktopSignatureText(Buffer.from(text).toString('base64'))).toBe(text)
    expect(desktopSignatureText(text)).toBe(text)
    expect(() => desktopSignatureText('not-a-signature')).toThrow('encoding')
  })
})
