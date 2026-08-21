import { createHash, sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type DeliveryProgress,
  decideProgressReport,
  fetchArtifact,
  PROGRESS_REPORT_INTERVAL_MS,
  PROGRESS_REPORT_PERCENT_STEP,
  verifyTarball,
} from './update-delivery'

/**
 * DOWNLOAD PROGRESS (POD-2101, spec §3.3). Two questions, kept apart on
 * purpose: when is there news (a pure rule, tested in a table), and does the
 * stream actually produce it (tested against a real `Response`, no timers).
 */

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

const chunk = (byte: number, size: number): Uint8Array => new Uint8Array(size).fill(byte)

function artifactOf(chunks: Uint8Array[]): {
  url: string
  digest: string
  signature: string
  bytes: Uint8Array
} {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  return {
    url: 'https://x.test/a.tgz',
    digest: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
    signature: cryptoSign(null, bytes, privateKey).toString('base64'),
    bytes,
  }
}

/** A body that arrives in pieces, like a real one does. */
function streamingFetch(chunks: Uint8Array[], declareLength: boolean): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      },
    })
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    return new Response(stream, {
      status: 200,
      ...(declareLength ? { headers: { 'content-length': String(total) } } : {}),
    })
  }) as unknown as typeof fetch
}

describe('decideProgressReport', () => {
  it('speaks the first time bytes arrive, whatever the numbers say', () => {
    expect(decideProgressReport(undefined, undefined, 0, undefined)).toBe(true)
    expect(decideProgressReport(undefined, undefined, 0, 0)).toBe(true)
  })

  it('speaks again once the interval has passed, even with no percentage', () => {
    expect(
      decideProgressReport(1_000, undefined, 1_000 + PROGRESS_REPORT_INTERVAL_MS, undefined),
    ).toBe(true)
    expect(decideProgressReport(1_000, 10, 1_000 + PROGRESS_REPORT_INTERVAL_MS - 1, 10)).toBe(false)
  })

  it('speaks early when the download has moved five points', () => {
    expect(decideProgressReport(1_000, 10, 1_100, 10 + PROGRESS_REPORT_PERCENT_STEP)).toBe(true)
    expect(decideProgressReport(1_000, 10, 1_100, 10 + PROGRESS_REPORT_PERCENT_STEP - 1)).toBe(
      false,
    )
  })

  it('stays quiet inside the interval when the length is unknown', () => {
    // Nothing to compare, so the only thing that can earn a frame is time —
    // otherwise every chunk of a large unmeasurable body would be a message.
    expect(decideProgressReport(1_000, undefined, 1_500, undefined)).toBe(false)
  })

  it('speaks once a percentage becomes knowable at all', () => {
    expect(decideProgressReport(1_000, undefined, 1_100, 3)).toBe(true)
  })
})

describe('fetchArtifact progress', () => {
  it('reports percent as the body arrives, and still verifies the whole thing', async () => {
    const chunks = [chunk(1, 25), chunk(2, 25), chunk(3, 25), chunk(4, 25)]
    const artifact = artifactOf(chunks)
    const seen: DeliveryProgress[] = []
    const { bytes } = await fetchArtifact(artifact, {
      fetch: streamingFetch(chunks, true),
      pubkey,
      onProgress: (progress) => seen.push(progress),
      // Frozen: every report below is earned by the percentage, not by time.
      now: () => 0,
    })

    expect(bytes.byteLength).toBe(100)
    expect(Array.from(bytes)).toEqual(Array.from(artifact.bytes))
    expect(seen.map((p) => p.percent)).toEqual([25, 50, 75, 100])
    expect(seen.every((p) => p.phase === 'downloading')).toBe(true)
    expect(seen.at(-1)).toMatchObject({ receivedBytes: 100, totalBytes: 100 })
  })

  it('reports bytes with NO percent when nothing declared a length', async () => {
    const chunks = [chunk(1, 10), chunk(2, 10), chunk(3, 10)]
    const artifact = artifactOf(chunks)
    const seen: DeliveryProgress[] = []
    let clock = 0
    await fetchArtifact(artifact, {
      fetch: streamingFetch(chunks, false),
      pubkey,
      onProgress: (progress) => seen.push(progress),
      now: () => {
        // One interval per chunk: with no percentage to compare, time is the
        // only thing that can earn a frame, and here every chunk earns one.
        clock += PROGRESS_REPORT_INTERVAL_MS
        return clock
      },
    })

    expect(seen.map((p) => p.percent)).toEqual([undefined, undefined, undefined])
    expect(seen.map((p) => p.totalBytes)).toEqual([undefined, undefined, undefined])
    expect(seen.map((p) => p.receivedBytes)).toEqual([10, 20, 30])
  })

  it('takes the one-shot path, unchanged, when nobody is listening', async () => {
    const chunks = [chunk(7, 8)]
    const artifact = artifactOf(chunks)
    const { bytes } = await fetchArtifact(artifact, {
      fetch: streamingFetch(chunks, true),
      pubkey,
    })
    expect(Array.from(bytes)).toEqual(Array.from(artifact.bytes))
  })

  it('still refuses a tampered body it streamed', async () => {
    const chunks = [chunk(1, 16), chunk(2, 16)]
    const artifact = artifactOf(chunks)
    await expect(
      fetchArtifact(
        { ...artifact, digest: 'sha256-wrong' },
        {
          fetch: streamingFetch(chunks, true),
          pubkey,
          onProgress: () => {},
        },
      ),
    ).rejects.toThrow(/digest/i)
  })
})

/**
 * WHICH KEY GETS TO SAY YES (spec §1, dispositions 1 and 2).
 *
 * This is the whole security content of turning `dev` into a pulled channel.
 * The selection used to be `delivery === 'bundle' ? pinned : baked`, which asked
 * about the TRANSPORT; now it asks about the CHANNEL, through the `trust` the
 * server's resolver stamped on the target.
 *
 * Every case below signs a REAL body with a REAL key and pushes it through the
 * real download path, because the failure this guards against is precisely a
 * signature check that passes for the wrong reason. Both directions are here:
 * a target may not be verified against a key it did not name, whichever way
 * round the mistake is made.
 */
describe('fetchArtifact trust root', () => {
  const instance = generateKeyPairSync('ed25519')
  const instancePubkey = instance.publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64')

  /** The same bytes, signed by the instance key instead of the release key. */
  function instanceSigned(chunks: Uint8Array[]): ReturnType<typeof artifactOf> {
    const artifact = artifactOf(chunks)
    return {
      ...artifact,
      signature: cryptoSign(null, artifact.bytes, instance.privateKey).toString('base64'),
    }
  }

  const body = [chunk(9, 32)]

  it('verifies an instance-trusted target against the PINNED key', async () => {
    const artifact = instanceSigned(body)
    const { bytes } = await fetchArtifact(artifact, {
      fetch: streamingFetch(body, true),
      pubkey,
      pinnedPubkey: instancePubkey,
      trust: 'instance',
    })
    expect(bytes.byteLength).toBe(32)
  })

  it('verifies a release-trusted target against the BAKED key', async () => {
    const artifact = artifactOf(body)
    const { bytes } = await fetchArtifact(artifact, {
      fetch: streamingFetch(body, true),
      pubkey,
      pinnedPubkey: instancePubkey,
      trust: 'release',
    })
    expect(bytes.byteLength).toBe(32)
  })

  it('REFUSES an instance-signed artifact offered on a release-trusted target', async () => {
    // The acceptance case: a release channel's manifest points at a dev-feed
    // artifact. The bytes download and hash fine; only the key says no.
    await expect(
      fetchArtifact(instanceSigned(body), {
        fetch: streamingFetch(body, true),
        pubkey,
        pinnedPubkey: instancePubkey,
        trust: 'release',
      }),
    ).rejects.toThrow(/signature verification FAILED/i)
  })

  it('REFUSES a release-signed artifact offered on an instance-trusted target', async () => {
    await expect(
      fetchArtifact(artifactOf(body), {
        fetch: streamingFetch(body, true),
        pubkey,
        pinnedPubkey: instancePubkey,
        trust: 'instance',
      }),
    ).rejects.toThrow(/signature verification FAILED/i)
  })

  it('treats an ABSENT trust root as `release`, never as "whatever verifies"', async () => {
    await expect(
      fetchArtifact(instanceSigned(body), {
        fetch: streamingFetch(body, true),
        pubkey,
        pinnedPubkey: instancePubkey,
      }),
    ).rejects.toThrow(/signature verification FAILED/i)
  })

  it('fails closed when an instance-trusted target reaches a daemon with no pinned key', async () => {
    await expect(
      fetchArtifact(instanceSigned(body), {
        fetch: streamingFetch(body, true),
        pubkey,
        trust: 'instance',
      }),
    ).rejects.toThrow(/pinned at pairing/i)
  })
})

/**
 * THE PURE SECURITY PRIMITIVE, consolidated here by POD-2106. These arms lived
 * in `apps/cli/src/podium-update.test.ts` against the CLI's own byte-identical
 * copy of `verifyTarball`; the copy is gone and the CLI imports this one, so
 * the tests come with it rather than being left guarding a deleted function.
 *
 * The suite above signs real bodies and exercises verification through
 * `fetchArtifact`. This one goes at the function directly, because the cases
 * that matter are the REJECTIONS — and a rejection reached through the whole
 * download path is indistinguishable from a download that simply failed.
 */
describe('verifyTarball', () => {
  // An independent keypair, so payloads can be signed deterministically in the
  // test; the committed dev pubkey default is exercised by the round-trip path.
  const keys = generateKeyPairSync('ed25519')
  const pubB64 = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const sigB64 = cryptoSign(null, payload, keys.privateKey).toString('base64')

  it('accepts a correctly-signed payload', () => {
    expect(verifyTarball(payload, sigB64, pubB64)).toBe(true)
  })
  it('REJECTS a tampered payload (same signature)', () => {
    const tampered = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9])
    expect(verifyTarball(tampered, sigB64, pubB64)).toBe(false)
  })
  it('REJECTS a wrong signature (signed by a different key)', () => {
    const other = generateKeyPairSync('ed25519').privateKey
    const wrongSig = cryptoSign(null, payload, other).toString('base64')
    expect(verifyTarball(payload, wrongSig, pubB64)).toBe(false)
  })
  it('REJECTS a missing/empty signature', () => {
    expect(verifyTarball(payload, '', pubB64)).toBe(false)
  })
  it('REJECTS garbage that is not a valid signature (no throw)', () => {
    expect(verifyTarball(payload, 'not-base64-sig!!', pubB64)).toBe(false)
  })
  it('REJECTS a malformed public key rather than throwing out of the caller', () => {
    expect(verifyTarball(payload, sigB64, 'not-a-key')).toBe(false)
  })
})
