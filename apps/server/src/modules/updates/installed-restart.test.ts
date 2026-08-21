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
