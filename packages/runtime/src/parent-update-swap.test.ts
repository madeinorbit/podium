/**
 * Coverage for the swap as the PARENT now performs it [POD-2505].
 *
 * The first five cases are ported verbatim in intent from
 * apps/server/src/modules/updates/installed-restart.test.ts, which is where this
 * logic used to live before spec §8 disposition 11 moved it out of the server.
 * They are the schema-gate-before-fetch and VERSION-re-read-fence guarantees,
 * and they must not evaporate just because the code changed address.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createParentUpdateSwap, releaseCarriesNewMigrations } from './parent-update-swap'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function installDirAt(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-parent-swap-'))
  roots.push(dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'VERSION'), `${version}\n`)
  return dir
}

describe('createParentUpdateSwap', () => {
  it('delivers and swaps the exact target', async () => {
    const dir = installDirAt('0.4.1')
    const deliver = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const swap = vi.fn(async (_bytes: Uint8Array, installDir: string) => {
      writeFileSync(join(installDir, 'VERSION'), '0.4.2\n')
    })
    const run = createParentUpdateSwap({
      installDir: dir,
      deliver,
      swap,
      readApplied: () => undefined,
    })

    const result = await run({ version: '0.4.2', critical: false, artifacts: {} })

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ version: '0.4.2' }), '0.4.1')
    expect(swap).toHaveBeenCalledOnce()
    expect(result).toEqual({ version: '0.4.2', releaseHadMigrations: undefined, swapped: true })
  })

  it('does no delivery when the bundle is already the target', async () => {
    const dir = installDirAt('0.4.2')
    const deliver = vi.fn()
    const run = createParentUpdateSwap({ installDir: dir, deliver, readApplied: () => undefined })

    const result = await run({ version: '0.4.2', critical: false, artifacts: {} })

    expect(deliver).not.toHaveBeenCalled()
    expect(result.swapped).toBe(false)
  })

  it('the VERSION re-read fence refuses a delivery that installed something else', async () => {
    const dir = installDirAt('0.4.1')
    const run = createParentUpdateSwap({
      installDir: dir,
      deliver: async () => new Uint8Array([1]),
      readApplied: () => undefined,
      swap: async (_bytes, installDir) => {
        // The published feed rolled while the download was in flight.
        writeFileSync(join(installDir, 'VERSION'), '0.4.3\n')
      },
    })

    await expect(run({ version: '0.4.2', critical: false, artifacts: {} })).rejects.toThrow(
      /installed 0\.4\.3, expected 0\.4\.2/,
    )
  })

  it('the schema gate refuses BEFORE downloading or swapping anything', async () => {
    const dir = installDirAt('0.4.2')
    const deliver = vi.fn(async () => new Uint8Array([1]))
    const swap = vi.fn(async () => {})
    const run = createParentUpdateSwap({
      installDir: dir,
      deliver,
      swap,
      readApplied: () => ['20260820000000_new-schema'],
    })

    await expect(
      run({
        version: '0.4.1',
        critical: false,
        artifacts: {},
        schema: { migrations: ['20260819000000_old-schema'] },
      }),
    ).rejects.toThrow(/schema-advanced/)
    expect(deliver, 'nothing may be fetched once the gate refuses').not.toHaveBeenCalled()
    expect(swap).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('0.4.2')
  })

  it('reports whether the release carried migrations this database had not applied', async () => {
    const dir = installDirAt('1.0.0')
    const run = createParentUpdateSwap({
      installDir: dir,
      deliver: async () => new Uint8Array([1]),
      swap: async (_bytes, installDir) => writeFileSync(join(installDir, 'VERSION'), '1.1.0\n'),
      readApplied: () => ['20260101000000_baseline'],
    })

    const result = await run({
      version: '1.1.0',
      critical: false,
      artifacts: {},
      schema: { migrations: ['20260101000000_baseline', '20260201000000_operations'] },
    })

    // Decision 4: this is what makes rollback UNAVAILABLE rather than silent.
    expect(result.releaseHadMigrations).toBe(true)
  })
})

describe('releaseCarriesNewMigrations', () => {
  it('preserves unknown when the target declares nothing', () => {
    expect(releaseCarriesNewMigrations({}, ['a'])).toBeUndefined()
    expect(releaseCarriesNewMigrations({}, undefined)).toBeUndefined()
    expect(releaseCarriesNewMigrations({ schema: { migrations: [] } }, ['a'])).toBe(false)
  })

  it('is false when every declared migration is already applied', () => {
    expect(
      releaseCarriesNewMigrations({ schema: { migrations: ['a', 'b'] } }, ['a', 'b', 'c']),
    ).toBe(false)
  })

  it('is true for a declared migration the database has not applied', () => {
    expect(releaseCarriesNewMigrations({ schema: { migrations: ['a', 'z'] } }, ['a'])).toBe(true)
  })

  it('is false on a daemon-only machine with no database to migrate', () => {
    expect(releaseCarriesNewMigrations({ schema: { migrations: ['a', 'b'] } }, undefined)).toBe(
      false,
    )
  })

  it('preserves unknown when the local ledger cannot be read', async () => {
    const installDir = installDirAt('0.4.2')
    const swap = createParentUpdateSwap({
      installDir,
      readApplied: () => {
        throw new Error('ledger unavailable')
      },
      deliver: async () => new Uint8Array(),
    })

    await expect(
      swap({ version: '0.4.2', critical: false, schema: { migrations: ['a'] }, artifacts: {} }),
    ).resolves.toMatchObject({ releaseHadMigrations: undefined, swapped: false })
  })
})

/**
 * Trust is stamped on the TARGET. The parent's default deliver closure must
 * read it — injecting `deliver` would hide a root that never reached
 * `fetchArtifact`. These used to live on the server; the parent now fetches.
 */
describe('parent delivery reads the target trust root', () => {
  const asset = { url: 'https://feed.test/a.tgz', digest: 'd', signature: 's' }
  const targetFor = (trust?: 'release' | 'instance') => ({
    version: '0.4.2',
    critical: false,
    ...(trust ? { trust } : {}),
    artifacts: {
      headless: { delivery: 'feed' as const, platforms: { 'linux-x86_64': asset } },
    },
  })

  async function deliveryAttempt(trust?: 'release' | 'instance', pinnedPubkey?: string) {
    const dir = installDirAt('0.4.1')
    const seen: string[] = []
    const run = createParentUpdateSwap({
      installDir: dir,
      platform: 'linux-x86_64',
      pubkey: 'baked-release-key',
      ...(pinnedPubkey ? { pinnedPubkey } : {}),
      readApplied: () => undefined,
      swap: async () => {},
      fetch: (async (url: string) => {
        seen.push(String(url))
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      }) as unknown as typeof fetch,
    })
    let error: unknown
    await run(targetFor(trust)).catch((thrown: unknown) => {
      error = thrown
    })
    return { seen, error }
  }

  it('fails closed on an instance-trusted target when nothing was pinned', async () => {
    const { seen, error } = await deliveryAttempt('instance')
    expect((error as Error).message).toMatch(/pinned at pairing/)
    expect(seen).toEqual([])
  })

  it('proceeds to the download once the pinned key this target names exists', async () => {
    const { seen, error } = await deliveryAttempt('instance', 'pinned-instance-key')
    expect(seen).toEqual([asset.url])
    expect((error as Error).message).toMatch(/verification FAILED/)
  })

  it('needs no pinned key at all when the target names the release root', async () => {
    const { seen, error } = await deliveryAttempt('release')
    expect(seen).toEqual([asset.url])
    expect((error as Error).message).not.toMatch(/pinned at pairing/)
  })
})
