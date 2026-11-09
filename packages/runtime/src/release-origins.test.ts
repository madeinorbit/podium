import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createReleaseFetcher,
  installerOriginPolicy,
  MIRROR_RELEASE_ORIGIN,
  PRIMARY_RELEASE_ORIGIN,
  RELEASE_ORIGINS,
  releaseArtifactBase,
  releaseChannelPath,
  releaseRedirectAllowed,
  releaseUrl,
  resolveReleaseArtifact,
  urlBelongsToReleaseDirectory,
} from './release-origins'
import { fetchArtifact } from './update-delivery'

const path = releaseChannelPath('edge') + 'podium-update.json'
const artifactPath = releaseChannelPath('edge') + 'headless.tgz'

describe('release origin policy', () => {
  for (const origin of RELEASE_ORIGINS) {
    it(`${origin.id} refuses walk-outs, encoded separators, foreign hosts and the other origin`, () => {
      const base = releaseArtifactBase(origin)
      for (const name of ['../outside/a', '%252e%252e/a', 'edge%252fa', 'edge/%255c../a']) {
        expect(urlBelongsToReleaseDirectory(base + name, base)).toBe(false)
      }
      for (const name of [
        'https://foreign.example/download/edge/a',
        '//foreign.example/download/edge/a',
        'https://user:pw@foreign.example/a',
      ]) {
        expect(() => resolveReleaseArtifact(name, origin)).toThrow()
      }
      for (const other of RELEASE_ORIGINS.filter((other) => other !== origin)) {
        expect(() => resolveReleaseArtifact(releaseUrl(artifactPath, other), origin)).toThrow(
          'outside',
        )
      }
      expect(resolveReleaseArtifact(artifactPath, origin)).toBe(releaseUrl(artifactPath, origin))
    })
    it(`${origin.id} limits redirects to its exact trusted https hosts`, () => {
      for (const host of origin.redirectHosts)
        expect(releaseRedirectAllowed(new URL(`https://${host}/a`), origin)).toBe(true)
      for (const name of [
        'http://foreign.example/a',
        'https://foreign.example/a',
        `https://${origin.redirectHosts[0]}.evil.example/a`,
        `https://${origin.redirectHosts[0]}:444/a`,
      ]) {
        expect(releaseRedirectAllowed(new URL(name), origin)).toBe(false)
      }
    })
  }

  it('keeps the standalone installer policy generated from the same module', () => {
    const installer = readFileSync(new URL('../../../install.sh', import.meta.url), 'utf8')
    expect(installer).toContain(installerOriginPolicy())
  })
})

describe('ordered release fetching', () => {
  it('fails over a 504 to the mirror and remembers it without changing primary order', async () => {
    const client = createReleaseFetcher()
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).startsWith(PRIMARY_RELEASE_ORIGIN.baseUrl)
        ? new Response(null, { status: 504 })
        : Response.json({ version: '1.0.0' }),
    )
    const options = { fetch: fetchMock, read: (response: Response) => response.json() }
    const result = await client.fetchRelease(path, options)
    expect(result.origin).toBe(MIRROR_RELEASE_ORIGIN)
    expect(result.data).toEqual({ version: '1.0.0' })
    expect(client.getLastSuccessfulOrigin()).toBe(MIRROR_RELEASE_ORIGIN)
    await client.fetchRelease(path, options)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      releaseUrl(path),
      releaseUrl(path, MIRROR_RELEASE_ORIGIN),
      releaseUrl(path),
      releaseUrl(path, MIRROR_RELEASE_ORIGIN),
    ])
  })

  it('bounds a stalled primary (including its response body) before trying the mirror', async () => {
    const client = createReleaseFetcher()
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).startsWith(PRIMARY_RELEASE_ORIGIN.baseUrl)
        ? new Response(new ReadableStream({ start() {} }))
        : Response.json({ served: 'mirror' }),
    )
    const result = await client.fetchRelease(path, {
      fetch: fetchMock,
      timeoutMs: 10,
      read: (response) => response.json(),
    })
    expect(result.origin).toBe(MIRROR_RELEASE_ORIGIN)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry an unpublished mirror in a tight loop', async () => {
    const client = createReleaseFetcher()
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }))
    await expect(client.fetchRelease(path, { fetch: fetchMock })).rejects.toThrow('404')
    await expect(client.fetchRelease(path, { fetch: fetchMock })).rejects.toThrow('404')
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      releaseUrl(path),
      releaseUrl(path, MIRROR_RELEASE_ORIGIN),
      releaseUrl(path),
    ])
  })

  it('keeps a companion read pinned to the selected origin', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 504 }))
    await expect(
      createReleaseFetcher().fetchRelease(path, {
        fetch: fetchMock,
        origin: MIRROR_RELEASE_ORIGIN,
      }),
    ).rejects.toThrow('504')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(releaseUrl(path, MIRROR_RELEASE_ORIGIN))
  })

  it('fails closed on a served malformed manifest', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{broken'))
    await expect(
      createReleaseFetcher().fetchRelease(path, {
        fetch: fetchMock,
        read: (response) => response.json(),
      }),
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('artifact verification after failover', () => {
  it('still rejects a mirror artifact signed by the wrong key even when its digest matches', async () => {
    const trusted = generateKeyPairSync('ed25519')
    const attacker = generateKeyPairSync('ed25519')
    const bytes = Buffer.from('tampered package')
    const asset = {
      url: releaseUrl(artifactPath, MIRROR_RELEASE_ORIGIN),
      signature: sign(null, bytes, attacker.privateKey).toString('base64'),
      digest: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
    }
    await expect(
      fetchArtifact(asset, {
        fetch: vi.fn<typeof fetch>(async () => new Response(bytes)),
        pubkey: trusted.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        trust: 'release',
      }),
    ).rejects.toThrow('signature verification FAILED')
  })
})
