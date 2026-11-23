/**
 * One update check and going back (POD-7281, docs/design/harness-managed-installs.md
 * §5.5 and §5.6), driven through the fake adapter against a local fake vendor.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallLedger } from './install-ledger.js'
import { installRelease, type ManagedInstallTarget } from './managed-install.js'
import { FakeVendorHost, fakeTarget } from './managed-install.test-support.js'
import {
  type CheckForUpdateOptions,
  checkForUpdate,
  compareHarnessVersions,
  decideUpdate,
  goBackRelease,
  setUpdatesPaused,
} from './managed-update.js'

const KIND = 'claude-code' as const

let root: string
let harnessesDir: string
let vendor: FakeVendorHost
let ledger: InstallLedger

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'podium-managed-update-'))
  harnessesDir = join(root, 'harnesses')
  vendor = await new FakeVendorHost([{ version: '1.0.0' }]).start()
  ledger = InstallLedger.open({ harnessesDir })
})

afterEach(async () => {
  ledger.close()
  await vendor.stop()
  rmSync(root, { recursive: true, force: true })
})

const commandEnv = () => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: join(root, 'machine-home'),
})

const host = () => ({
  ledger,
  commandEnv: commandEnv(),
  vendorOrigins: vendor.origins,
  target: fakeTarget(),
  probeTimeoutMs: 10_000,
})

const check = (overrides: Partial<CheckForUpdateOptions> = {}) =>
  checkForUpdate(KIND, { ...host(), ...overrides })

/** A managed install on 1.0.0, as `podium install` leaves it. */
async function installFirst() {
  const first = await installRelease(KIND, host())
  if (first.outcome !== 'installed') throw new Error(`first install: ${JSON.stringify(first)}`)
  return first
}

function kindEntries(): string[] {
  try {
    return readdirSync(join(harnessesDir, KIND)).sort()
  } catch {
    return []
  }
}

describe('decideUpdate', () => {
  const base = { latest: '1.2.0', current: '1.1.0', rejected: false, paused: false }

  it('installs only a newer, allowed, not-rejected version while not paused', () => {
    expect(decideUpdate(base)).toEqual({ install: true })
    expect(decideUpdate({ ...base, paused: true })).toEqual({ install: false, reason: 'paused' })
    expect(decideUpdate({ ...base, rejected: true })).toEqual({
      install: false,
      reason: 'rejected',
    })
    expect(decideUpdate({ ...base, latest: '1.1.0' })).toEqual({
      install: false,
      reason: 'not-newer',
    })
    expect(decideUpdate({ ...base, latest: '1.0.9' })).toEqual({
      install: false,
      reason: 'not-newer',
    })
    expect(
      decideUpdate({
        ...base,
        versionPolicy: { minimum: { major: 1, minor: 3 }, verifiedThrough: '9.0.0' },
      }),
    ).toEqual({ install: false, reason: 'below-minimum' })
    expect(decideUpdate({ ...base, latest: 'nightly' })).toEqual({
      install: false,
      reason: 'unparseable',
    })
  })

  it('installs any allowed version when there is no working current release', () => {
    const { current: _current, ...noCurrent } = base
    expect(decideUpdate({ ...noCurrent, latest: '0.9.0' })).toEqual({ install: true })
  })

  it('compares by number, not by text', () => {
    expect(compareHarnessVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareHarnessVersions('2.0.0', '2.0.0')).toBe(0)
    expect(compareHarnessVersions('x', '1.0.0')).toBeUndefined()
  })
})

describe('checkForUpdate', () => {
  it('hands an installed update to the vendor and never checks or repairs it again', async () => {
    await installFirst()
    vendor.publish({ version: '1.1.0' })
    const base = fakeTarget()
    const target: ManagedInstallTarget = {
      ...base,
      install: {
        ...base.install,
        install: async (...args) => ({
          ...(await base.install.install(...args)),
          updater: 'cannot-stop',
        }),
      },
    }
    expect(await check({ target })).toMatchObject({ outcome: 'installed', version: '1.1.0' })
    expect(ledger.get(KIND)).toMatchObject({ current: 2, vendorUpdated: true })
    const requests = [...vendor.requests]
    vendor.publish({ version: '1.2.0' })
    expect(await check({ currentFailed: 2 })).toMatchObject({ outcome: 'vendor-updated' })
    expect(await installRelease(KIND, { ...host(), updating: true })).toMatchObject({
      outcome: 'vendor-updated',
    })
    expect(vendor.requests).toEqual(requests)
    expect(ledger.get(KIND)?.current).toBe(2)
  })

  it('does nothing for a harness Podium does not manage, and creates no row', async () => {
    expect(await check()).toEqual({ outcome: 'not-managed', kind: KIND })
    expect(ledger.get(KIND)).toBeUndefined()
  })

  it('installs a newer stable release through the mechanism and asks for a reprobe', async () => {
    await installFirst()
    vendor.publish({ version: '1.1.0' })
    const reprobe = vi.fn()
    const result = await check({ reprobe })
    expect(result).toMatchObject({
      outcome: 'installed',
      latest: '1.1.0',
      version: '1.1.0',
      number: 2,
      previous: 1,
    })
    expect(reprobe).toHaveBeenCalledTimes(1)
    expect(ledger.get(KIND)).toMatchObject({ current: 2, previous: 1 })
    expect(ledger.get(KIND)?.lastCheck).toMatchObject({ ok: true, latest: '1.1.0' })
    expect(kindEntries()).toEqual(['1-1.0.0', '2-1.1.0'])
  })

  it('installs nothing when the vendor names the current version, and records the check', async () => {
    await installFirst()
    const requestsBefore = vendor.requests.length
    const result = await check()
    expect(result).toMatchObject({ outcome: 'no-update', latest: '1.0.0', reason: 'not-newer' })
    // One request: the stable pointer. No download.
    expect(vendor.requests.slice(requestsBefore)).toEqual(['/releases/stable'])
    expect(ledger.get(KIND)).toMatchObject({ current: 1, previous: null })
    expect(ledger.get(KIND)?.lastCheck).toMatchObject({ ok: true, latest: '1.0.0' })
  })

  it('installs nothing while paused, until resumed', async () => {
    await installFirst()
    vendor.publish({ version: '1.1.0' })
    expect(setUpdatesPaused(KIND, true, { ledger })).toEqual({
      outcome: 'set',
      kind: KIND,
      paused: true,
    })
    expect(await check()).toMatchObject({ outcome: 'no-update', latest: '1.1.0', reason: 'paused' })
    expect(ledger.get(KIND)).toMatchObject({ current: 1, paused: true })

    // The pause is in the ledger: another program opening it sees it.
    const other = InstallLedger.open({ harnessesDir })
    try {
      expect(other.get(KIND)?.paused).toBe(true)
    } finally {
      other.close()
    }

    setUpdatesPaused(KIND, false, { ledger })
    expect(await check()).toMatchObject({ outcome: 'installed', version: '1.1.0' })
  })

  it('pausing a harness Podium does not manage writes nothing', () => {
    expect(setUpdatesPaused(KIND, true, { ledger })).toEqual({ outcome: 'not-managed', kind: KIND })
    expect(ledger.get(KIND)).toBeUndefined()
  })

  it('installs nothing for a rejected version, and the next release as usual', async () => {
    await installFirst()
    vendor.publish({ version: '1.1.0' })
    ledger.rejectRelease(KIND, '1.1.0', 'test')
    expect(await check()).toMatchObject({ outcome: 'no-update', reason: 'rejected' })
    vendor.publish({ version: '1.2.0' })
    expect(await check()).toMatchObject({ outcome: 'installed', version: '1.2.0' })
  })

  it('installs nothing below the minimum', async () => {
    await installFirst()
    vendor.publish({ version: '1.1.0' })
    expect(
      await check({
        target: fakeTarget({
          versionPolicy: { minimum: { major: 2, minor: 0 }, verifiedThrough: '9.0.0' },
        }),
      }),
    ).toMatchObject({ outcome: 'no-update', reason: 'below-minimum' })
    expect(ledger.get(KIND)?.current).toBe(1)
  })

  it('records an unreachable vendor, starts the failing run, and keeps the current release', async () => {
    await installFirst()
    await vendor.stop()
    const result = await check()
    expect(result).toMatchObject({ outcome: 'check-failed' })
    const row = ledger.get(KIND)
    expect(row).toMatchObject({ current: 1, lastCheck: { ok: false } })
    expect(row?.failingSince).toBeDefined()
    // The failing run stays open through further failures, from its first one.
    const since = row?.failingSince
    await check()
    expect(ledger.get(KIND)?.failingSince).toBe(since)
  })

  it('ends the failing run on a good check with nothing to install', async () => {
    await installFirst()
    await vendor.stop()
    await check()
    expect(ledger.get(KIND)?.failingSince).toBeDefined()
    await vendor.start()
    expect(await check()).toMatchObject({ outcome: 'no-update', reason: 'not-newer' })
    expect(ledger.get(KIND)?.failingSince).toBeUndefined()
  })

  it('tries a failed download again on the next check, and rejects a binary that does not run', async () => {
    await installFirst()
    vendor.publish({ version: '1.1.0', badChecksum: true })
    expect(await check()).toMatchObject({ outcome: 'failed', version: '1.1.0', rejected: false })
    expect(ledger.get(KIND)?.failingSince).toBeDefined()
    vendor.publish({ version: '1.1.0' })
    expect(await check()).toMatchObject({ outcome: 'installed', version: '1.1.0' })
    expect(ledger.get(KIND)?.failingSince).toBeUndefined()

    vendor.publish({ version: '1.2.0', behaviour: 'exit' })
    expect(await check()).toMatchObject({ outcome: 'failed', version: '1.2.0', rejected: true })
    expect(ledger.isRejected(KIND, '1.2.0')).toBe(true)
    // Not fetched again every six hours.
    const before = vendor.requests.length
    expect(await check()).toMatchObject({ outcome: 'no-update', reason: 'rejected' })
    expect(vendor.requests.slice(before)).toEqual(['/releases/stable'])
  })

  it('installs the current version again as a new folder when the current release failed its probe', async () => {
    await installFirst()
    expect(await check({ currentFailed: 1 })).toMatchObject({
      outcome: 'installed',
      version: '1.0.0',
      number: 2,
    })
    // A stale report naming a release that is no longer current changes nothing.
    expect(await check({ currentFailed: 1 })).toMatchObject({
      outcome: 'no-update',
      reason: 'not-newer',
    })
  })

  it('housekeeping runs with a check that installs nothing', async () => {
    await installFirst()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(harnessesDir, KIND, '.staging-leftover'))
    mkdirSync(join(harnessesDir, KIND, '7-0.9.0'))
    const result = await check()
    expect(result).toMatchObject({ outcome: 'no-update' })
    if (result.outcome !== 'no-update') throw new Error('expected no-update')
    expect(result.swept.sort()).toEqual(['.staging-leftover', '7-0.9.0'])
    expect(kindEntries()).toEqual(['1-1.0.0'])
  })

  it('leaves an install held by another program alone', async () => {
    await installFirst()
    vendor.publish({ version: '1.1.0' })
    const other = ledger.acquireInstallLock({ label: 'install claude-code (cli)' })
    if (!other.acquired) throw new Error('lock')
    try {
      expect(await check()).toMatchObject({ outcome: 'busy' })
    } finally {
      other.lock.release()
    }
    expect(ledger.get(KIND)?.current).toBe(1)
  })
})

describe('goBackRelease', () => {
  async function onTwoReleases() {
    await installFirst()
    vendor.publish({ version: '1.1.0' })
    const second = await check()
    if (second.outcome !== 'installed') throw new Error('second install')
  }

  it('makes the previous release current and rejects the newer one', async () => {
    await onTwoReleases()
    const reprobe = vi.fn()
    const result = await goBackRelease(KIND, { ledger, reprobe })
    expect(result).toMatchObject({
      outcome: 'went-back',
      current: 1,
      version: '1.0.0',
      rejected: '1.1.0',
    })
    expect(reprobe).toHaveBeenCalledTimes(1)
    expect(ledger.get(KIND)).toMatchObject({ current: 1, previous: null })
    expect(ledger.isRejected(KIND, '1.1.0')).toBe(true)
    // The rejected folder had no session on it: housekeeping removed it.
    expect(kindEntries()).toEqual(['1-1.0.0'])

    // The next check does not bring it straight back ...
    expect(await check()).toMatchObject({ outcome: 'no-update', reason: 'rejected' })
    // ... and a newer release than the rejected one installs as usual.
    vendor.publish({ version: '1.2.0' })
    expect(await check()).toMatchObject({ outcome: 'installed', version: '1.2.0', previous: 1 })
  })

  it('keeps the rejected folder while a session runs on it', async () => {
    await onTwoReleases()
    ledger.recordSessionInstall({
      sessionId: 'ses_running' as SessionId,
      kind: KIND,
      executable: join(harnessesDir, KIND, '2-1.1.0', 'bin', 'fake-harness'),
      version: '1.1.0',
      provenance: 'managed',
      release: 2,
    })
    expect(await goBackRelease(KIND, { ledger })).toMatchObject({ outcome: 'went-back' })
    expect(kindEntries()).toEqual(['1-1.0.0', '2-1.1.0'])
  })

  it('refuses with nothing to go back to, and writes nothing', async () => {
    expect(await goBackRelease(KIND, { ledger })).toEqual({ outcome: 'not-managed', kind: KIND })
    await installFirst()
    expect(await goBackRelease(KIND, { ledger })).toMatchObject({
      outcome: 'nothing-to-go-back-to',
    })
    expect(ledger.get(KIND)).toMatchObject({ current: 1, previous: null })
    expect(ledger.rejectedReleases(KIND)).toEqual([])
  })

  it('refuses while an install holds the lock', async () => {
    await onTwoReleases()
    const other = ledger.acquireInstallLock({ label: 'install claude-code (cli)' })
    if (!other.acquired) throw new Error('lock')
    try {
      expect(await goBackRelease(KIND, { ledger })).toMatchObject({ outcome: 'busy' })
    } finally {
      other.lock.release()
    }
    expect(ledger.get(KIND)).toMatchObject({ current: 2, previous: 1 })
  })
})
