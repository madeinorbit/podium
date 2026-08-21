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
    const run = createParentUpdateSwap({ installDir: dir, deliver, swap, readApplied: () => undefined })

    const result = await run({ version: '0.4.2', critical: false, artifacts: {} })

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ version: '0.4.2' }), '0.4.1')
    expect(swap).toHaveBeenCalledOnce()
    expect(result).toEqual({ version: '0.4.2', releaseHadMigrations: false, swapped: true })
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
  it('is false when the target declares nothing — a guess must not withhold rollback', () => {
    expect(releaseCarriesNewMigrations({}, ['a'])).toBe(false)
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
})
