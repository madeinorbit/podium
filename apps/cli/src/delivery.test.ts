import { createHash, sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { fetchArtifact } from '@podium/runtime/update-delivery'
import { describe, expect, it } from 'vitest'

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
      { fetch: okFetch, pubkey },
    )
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4])
  })

  /**
   * TRUST IS A PROPERTY OF THE CHANNEL, NOT OF THE TRANSPORT (spec §1).
   *
   * These two arms used to be about the `bundle` delivery kind, which existed
   * only to mean "signed by the server rather than by CI". The kind is retired
   * and the distinction it was standing in for now travels explicitly, so the
   * same two cases are stated as what they always were.
   */
  it('verifies an instance-trusted artifact with the SAME rigour, against the pinned key', async () => {
    const { bytes } = await fetchArtifact(
      { url: 'https://server.test/a.tgz', digest, signature },
      {
        fetch: okFetch,
        pubkey: 'release-key-is-not-used',
        pinnedPubkey: pubkey,
        trust: 'instance',
      },
    )
    expect(bytes.length).toBe(4)
  })

  it('uses the committed release key when the target names the release root', async () => {
    const { bytes } = await fetchArtifact(
      { url: 'https://x.test/a.tgz', digest, signature },
      { fetch: okFetch, pubkey, pinnedPubkey: 'wrong-pinned-key', trust: 'release' },
    )
    expect(bytes.length).toBe(4)
  })

  it('rejects an instance-trusted target without a pairing pin', async () => {
    await expect(
      fetchArtifact(
        { url: 'https://server.test/a.tgz', digest, signature },
        { fetch: okFetch, pubkey, trust: 'instance' },
      ),
    ).rejects.toThrow(/pinned/i)
  })

  it('throws on a bad digest before returning bytes', async () => {
    await expect(
      fetchArtifact(
        { url: 'https://x.test/a.tgz', digest: 'sha256-wrong', signature },
        { fetch: okFetch, pubkey },
      ),
    ).rejects.toThrow(/digest/i)
  })

  it('throws on a bad signature and never returns bytes', async () => {
    await expect(
      fetchArtifact(
        { url: 'https://x.test/a.tgz', digest, signature: 'AAAA' },
        { fetch: okFetch, pubkey, verifyDigest: false },
      ),
    ).rejects.toThrow(/signature/i)
  })

  it('throws on an empty signature rather than treating it as unsigned-but-fine', async () => {
    await expect(
      fetchArtifact(
        { url: 'https://x.test/a.tgz', digest, signature: '' },
        { fetch: okFetch, pubkey, verifyDigest: false },
      ),
    ).rejects.toThrow(/signature/i)
  })

  it('throws on a failed download', async () => {
    const bad = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(
      fetchArtifact({ url: 'https://x.test/a.tgz', digest, signature }, { fetch: bad, pubkey }),
    ).rejects.toThrow(/404/)
  })

  it('refuses an artifact reference with no URL to fetch', async () => {
    // The only delivery kind left is a download, so a descriptor naming no URL
    // is a misconfiguration rather than another kind of delivery.
    await expect(
      fetchArtifact({ url: '', digest, signature }, { fetch: okFetch, pubkey }),
    ).rejects.toThrow(/artifact URL/i)
  })
})
