/**
 * The server's half of the parent-supervised update [POD-2505].
 *
 * The delivery / schema-gate / VERSION-fence cases that used to live here moved
 * with the code they cover, to packages/runtime/src/parent-update-swap.test.ts
 * (spec §8 disposition 11). What remains is what the SERVER still owns: the two
 * asks it makes of the parent, and whether it advertises a restart capability it
 * actually has.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createInstalledCoordinatorRestart,
  createInstalledCoordinatorUpdate,
  parentAvailable,
} from './installed-restart'

describe('parentAvailable', () => {
  it('is true under a parent and false for a legacy installed shape', () => {
    expect(parentAvailable({ PODIUM_UNDER_PARENT: '1' })).toBe(true)
    // A section-4 migration host: an old server unit sets INVOCATION_ID and
    // there is no parent anywhere. Advertising "can restart" here is what
    // produced a capability whose only behaviour was to throw.
    expect(parentAvailable({ INVOCATION_ID: 'legacy-server-unit' })).toBe(false)
    expect(parentAvailable({ PODIUM_RUN_MODE: 'detached' })).toBe(false)
  })
})

describe('createInstalledCoordinatorRestart', () => {
  it('is absent without a real restart authority', () => {
    expect(
      createInstalledCoordinatorRestart({ instanceId: 'default', port: () => 18787, env: {} }),
    ).toBeUndefined()
  })

  it('is absent for a legacy installed shape, so canRestartServer cannot lie', () => {
    expect(
      createInstalledCoordinatorRestart({
        instanceId: 'default',
        port: () => 18787,
        env: { INVOCATION_ID: 'legacy-server-unit', PODIUM_APP_VERSION: '1.0.0' },
        hasParent: () => false,
      }),
    ).toBeUndefined()
  })

  it('asks the supervising parent to self-handover onto the pending version', () => {
    const requestHandover = vi.fn(() => ({ ok: true as const, pid: 99 }))
    const restart = createInstalledCoordinatorRestart({
      instanceId: 'default',
      port: () => 19001,
      env: { PODIUM_UNDER_PARENT: '1', PODIUM_APP_VERSION: '0.4.1' },
      requestHandover,
      hasParent: () => true,
      pendingVersion: () => '0.4.2',
    })

    restart?.()

    expect(requestHandover).toHaveBeenCalledWith('0.4.2')
  })

  it('asks once per successful request, and does NOT latch on a failed one', () => {
    const results: Array<{ ok: true; pid: number } | { ok: false; reason: string }> = [
      { ok: false, reason: 'no-parent' },
      { ok: true, pid: 7 },
    ]
    const requestHandover = vi.fn(() => results.shift() as { ok: true; pid: number })
    const restart = createInstalledCoordinatorRestart({
      instanceId: 'default',
      port: () => 19001,
      env: { PODIUM_UNDER_PARENT: '1', PODIUM_APP_VERSION: '1.0.0' },
      requestHandover,
      hasParent: () => true,
      pendingVersion: () => '1.0.0',
    })

    // A latch set BEFORE the ask meant this step reported "Restarting the
    // server…" forever: every re-ensure() returned silently without re-asking.
    expect(() => restart?.()).toThrow(/machine-cannot-restart/)
    restart?.()
    restart?.()
    expect(requestHandover).toHaveBeenCalledTimes(2)
  })
})

describe('createInstalledCoordinatorUpdate', () => {
  it('is absent without a supervising parent', () => {
    expect(createInstalledCoordinatorUpdate({ env: {}, hasParent: () => false })).toBeUndefined()
  })

  it('asks the parent to install the target, and carries the pin with it', async () => {
    const requestSwap = vi.fn(async () => ({ releaseHadMigrations: false }))
    const installed: string[] = []
    const ensure = createInstalledCoordinatorUpdate({
      env: { PODIUM_UNDER_PARENT: '1' },
      hasParent: () => true,
      pinnedPubkey: 'PUB',
      requestSwap,
      onInstalled: (version) => installed.push(version),
    })

    await ensure?.({ version: '0.4.2', critical: false, artifacts: {} })

    expect(requestSwap).toHaveBeenCalledWith(expect.objectContaining({ version: '0.4.2' }), 'PUB')
    // The producer for the restart closure's expected version (review finding 15).
    expect(installed).toEqual(['0.4.2'])
  })

  it('surfaces the parent failure verbatim, and does not record an install', async () => {
    const installed: string[] = []
    const ensure = createInstalledCoordinatorUpdate({
      env: { PODIUM_UNDER_PARENT: '1' },
      hasParent: () => true,
      requestSwap: async () => {
        throw new Error('cannot converge: schema-advanced — …')
      },
      onInstalled: (version) => installed.push(version),
    })

    await expect(ensure?.({ version: '0.4.2', critical: false, artifacts: {} })).rejects.toThrow(
      /schema-advanced/,
    )
    expect(installed).toEqual([])
  })
})

/**
 * THE FLEET-OF-ONE SERVER, which is the OTHER half of this issue's first
 * acceptance line (spec §1, disposition 11).
 *
 * A server-only installation has no local daemon, so it performs its own
 * verified delivery — and it must obey the same rule the daemon does: the
 * TARGET names which key may have signed the bytes, and this process never
 * decides for itself. These arms drive the REAL delivery closure rather than
 * the injected `deliver` seam every other case here uses, because the seam is
 * exactly what would hide a trust root that never reached `fetchArtifact`.
 */
describe('an installed coordinator delivering for itself', () => {
  const asset = { url: 'https://feed.test/a.tgz', digest: 'd', signature: 's' }
  const targetFor = (trust?: 'release' | 'instance') => ({
    version: '0.4.2',
    critical: false,
    ...(trust ? { trust } : {}),
    artifacts: {
      headless: { delivery: 'feed' as const, platforms: { 'linux-x86_64': asset } },
    },
  })

  /** Runs the real closure far enough to observe the fetch it would make. */
  async function deliveryAttempt(trust?: 'release' | 'instance', pinnedPubkey?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'podium-server-trust-'))
    const seen: Array<{ url: string; authorization: string | null }> = []
    try {
      writeFileSync(join(dir, 'VERSION'), '0.4.1\n')
      const ensure = createInstalledCoordinatorUpdate({
        env: { INVOCATION_ID: 'server-unit' },
        installDir: dir,
        platform: 'linux-x86_64',
        pubkey: 'baked-release-key',
        ...(pinnedPubkey ? { pinnedPubkey } : {}),
        readApplied: () => undefined,
        swap: async () => {},
        fetch: (async (url: string, init?: RequestInit) => {
          seen.push({
            url: String(url),
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        }) as unknown as typeof fetch,
      })
      let error: unknown
      await ensure?.(targetFor(trust)).catch((thrown: unknown) => {
        error = thrown
      })
      return { seen, error }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('fails closed on an instance-trusted target when nothing was pinned', async () => {
    const { seen, error } = await deliveryAttempt('instance')
    expect((error as Error).message).toMatch(/pinned at pairing/)
    // …and it does so BEFORE the download, not after a quarter of a gigabyte.
    expect(seen).toEqual([])
  })

  it('proceeds to the download once the pinned key this target names exists', async () => {
    const { seen, error } = await deliveryAttempt('instance', 'pinned-instance-key')
    expect(seen.map((call) => call.url)).toEqual([asset.url])
    // It gets as far as the integrity gates, which is as far as a fixture
    // digest can take it — the point is that the key question was answered.
    expect((error as Error).message).toMatch(/verification FAILED/)
  })

  /**
   * A RELEASE-TRUSTED TARGET NEEDS NO PIN, and that asymmetry is the whole
   * discriminator: the same coordinator, the same absent pinned key, refused
   * before the download on `instance` and downloading on `release`.
   */
  it('needs no pinned key at all when the target names the release root', async () => {
    const { seen, error } = await deliveryAttempt('release')
    expect(seen.map((call) => call.url)).toEqual([asset.url])
    expect((error as Error).message).not.toMatch(/pinned at pairing/)
  })

  it('treats a target naming no root as `release`, not as "whatever is available"', async () => {
    const { seen } = await deliveryAttempt(undefined, 'pinned-instance-key')
    expect(seen.map((call) => call.url)).toEqual([asset.url])
  })
})
