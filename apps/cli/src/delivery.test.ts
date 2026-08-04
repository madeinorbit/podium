import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fetchArtifact } from './delivery'

// An ephemeral keypair makes this test independent of the gitignored dev key
// while exercising the same verifier used by `podium update`.
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const bodyBytes = new Uint8Array([1, 2, 3, 4])
const signature = cryptoSign(null, bodyBytes, privateKey).toString('base64')
const digest = `sha256-${createHash('sha256').update(bodyBytes).digest('base64')}`

const okFetch = (async () => new Response(bodyBytes, { status: 200 })) as unknown as typeof fetch

describe('fetchArtifact', () => {
  it('returns bytes for a correctly signed and digested feed artifact', async () => {
    const { bytes } = await fetchArtifact(
      { url: 'https://x.test/a.tgz', digest, signature },
      'feed',
      { fetch: okFetch, pubkey },
    )
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4])
  })

  it('verifies a bundle artifact with the SAME rigour as a feed artifact', async () => {
    const { bytes } = await fetchArtifact(
      { url: 'https://server.test/a.tgz', digest, signature },
      'bundle',
      { fetch: okFetch, pubkey },
    )
    expect(bytes.length).toBe(4)
  })

  it('throws on a bad digest before returning bytes', async () => {
    await expect(
      fetchArtifact({ url: 'https://x.test/a.tgz', digest: 'sha256-wrong', signature }, 'feed', {
        fetch: okFetch,
        pubkey,
      }),
    ).rejects.toThrow(/digest/i)
  })

  it('throws on a bad signature and never returns bytes', async () => {
    await expect(
      fetchArtifact({ url: 'https://x.test/a.tgz', digest, signature: 'AAAA' }, 'feed', {
        fetch: okFetch,
        pubkey,
        verifyDigest: false,
      }),
    ).rejects.toThrow(/signature/i)
  })

  it('throws on an empty signature rather than treating it as unsigned-but-fine', async () => {
    await expect(
      fetchArtifact({ url: 'https://x.test/a.tgz', digest, signature: '' }, 'feed', {
        fetch: okFetch,
        pubkey,
        verifyDigest: false,
      }),
    ).rejects.toThrow(/signature/i)
  })

  it('throws on a failed download', async () => {
    const bad = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(
      fetchArtifact({ url: 'https://x.test/a.tgz', digest, signature }, 'feed', {
        fetch: bad,
        pubkey,
      }),
    ).rejects.toThrow(/404/)
  })

  it('delegates git delivery to the safe checkout runner', async () => {
    const operations: string[] = []
    const result = await fetchArtifact(
      { delivery: 'git', repo: '/checkout', sha: 'abc1234' },
      'git',
      {
        fetch: okFetch,
        pubkey,
        git: {
          run: (_cmd, args) => {
            operations.push(args.find((arg) => ['status', 'fetch', 'checkout'].includes(arg)) ?? '')
            return { status: 0, stdout: '' }
          },
        },
      },
    )

    expect(result).toEqual({ git: true })
    expect(operations).toEqual(['status', 'fetch', 'checkout'])
  })
})
