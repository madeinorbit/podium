import { generateKeyPairSync, sign } from 'node:crypto'
import type { UpdateGrantMessage } from '@podium/protocol'
import { fetchArtifact, PODIUM_UPDATE_PUBKEY } from '@podium/runtime/update-delivery'
import { describe, expect, it, vi } from 'vitest'
import { applyGrant, type GrantApplyDeps } from './grant-apply'

/**
 * THE DAEMON'S HALF OF PER-CHANNEL TRUST (spec §1, dispositions 1 and 2).
 *
 * This file used to cover git delivery, which is retired: exactly one machine
 * runs from source — the publisher — and it is not a fleet consumer. What
 * replaced it on this seam is the fact that has to hold in its place, and it is
 * a stricter one: the daemon must verify a dev artifact against the key it
 * pinned at pairing and an edge artifact against the baked release key, having
 * decided NEITHER for itself.
 *
 * These arms go through `applyGrant` into the REAL `fetchArtifact`, with real
 * keys and real signatures, because the defect being guarded against is a
 * verification that passes for the wrong reason — which every stub reproduces
 * perfectly.
 */

const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2])
const digest = 'sha256-hpqcL5Spvten/3Jb59Azko2Cfdi/lA/f1EmdaykAqPg='
const instance = generateKeyPairSync('ed25519')
const instancePubkey = instance.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

function grantFor(trust: 'instance' | 'release' | undefined): UpdateGrantMessage {
  return {
    type: 'updateGrant',
    grantId: `g-${trust ?? 'none'}`,
    target: {
      version: '0.1.2-dev.4+abc1234',
      critical: false,
      ...(trust ? { trust } : {}),
      artifacts: {
        headless: {
          delivery: 'feed',
          platforms: {
            'linux-x86_64': {
              url: 'https://server.test/updates/feed/dev/artifact/x',
              digest,
              signature: sign(null, bytes, instance.privateKey).toString('base64'),
            },
          },
        },
      },
    },
  }
}

/** The daemon's real delivery wiring: both roots offered, the target choosing. */
function depsFor(): GrantApplyDeps & { swap: ReturnType<typeof vi.fn> } {
  const swap = vi.fn()
  return {
    currentVersion: () => '0.1.2-dev.3+aaaaaaa',
    caps: ['update.delivery.feed'],
    platform: 'linux-x86_64',
    fetchArtifact: (asset, trust, signal, onProgress) =>
      fetchArtifact(asset, {
        fetch: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
        pubkey: PODIUM_UPDATE_PUBKEY,
        pinnedPubkey: instancePubkey,
        ...(trust ? { trust } : {}),
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
      }),
    swap,
    writePending: vi.fn(),
    restart: vi.fn(),
    report: vi.fn(),
    now: () => 1_000,
  }
}

function reportedDetails(deps: GrantApplyDeps): string[] {
  return (deps.report as ReturnType<typeof vi.fn>).mock.calls
    .map(([status]) => (status as { detail?: string }).detail)
    .filter((detail): detail is string => detail !== undefined)
}

describe('a grant carries the key its artifact must be signed by', () => {
  it('installs an instance-signed artifact on an instance-trusted target', async () => {
    const deps = depsFor()
    await applyGrant(grantFor('instance'), deps)
    expect(deps.swap).toHaveBeenCalledOnce()
    expect(deps.restart).toHaveBeenCalledOnce()
  })

  it('REFUSES the same artifact when the target names the release root', async () => {
    // The acceptance case, seen from the machine: a release-channel target
    // pointing at dev-feed bytes. The download and the digest both succeed;
    // only the key says no, and nothing is swapped.
    const deps = depsFor()
    await applyGrant(grantFor('release'), deps)
    expect(deps.swap).not.toHaveBeenCalled()
    expect(deps.restart).not.toHaveBeenCalled()
    expect(reportedDetails(deps).at(-1)).toMatch(/signature verification FAILED/)
  })

  it('REFUSES it when the target names no root at all, rather than trying both', async () => {
    const deps = depsFor()
    await applyGrant(grantFor(undefined), deps)
    expect(deps.swap).not.toHaveBeenCalled()
    expect(reportedDetails(deps).at(-1)).toMatch(/signature verification FAILED/)
  })

  it('preserves marker-before-restart ordering on the surviving delivery path', async () => {
    const order: string[] = []
    const deps = depsFor()
    deps.writePending = vi.fn(() => void order.push('write'))
    deps.restart = vi.fn(() => void order.push('restart'))
    await applyGrant(grantFor('instance'), deps)
    expect(order).toEqual(['write', 'restart'])
    expect(deps.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'restarting', grantId: 'g-instance' }),
    )
  })
})
