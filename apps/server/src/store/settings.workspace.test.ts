/**
 * SETTINGS ARE A WORKSPACE'S (POD-6959 design 2.1, task POD-7013).
 *
 * Two workspaces over one database (`openPeopleStoreSlices`, on the run's engine) each read and write
 * their own `workspace_meta` rows: the settings blob, the model catalog of the
 * same machine, the membership cursor, the upgrade receipts, the sign-in
 * carry-over end. Each case writes both workspaces under the same key and reads
 * each back, so a read that ignored the workspace would see the other's value.
 */

import { asMachineId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openPeopleStoreSlices,
  type WorkspacePeopleSlice,
} from '../test-support/people-store-slice'

const MACHINE = asMachineId('machine-shared')

let opened: WorkspacePeopleSlice | undefined

afterEach(async () => {
  await opened?.close()
  opened = undefined
})

async function twoWorkspaces(): Promise<readonly [WorkspacePeopleSlice, WorkspacePeopleSlice]> {
  const stores = await openPeopleStoreSlices(['ws_a', 'ws_b'])
  opened = stores[0]
  return stores
}

describe('workspace settings', () => {
  it('holds a settings blob per workspace', async () => {
    const [a, b] = await twoWorkspaces()
    const base = normalizeSettings(undefined)
    await a.settings.setSettings({
      ...base,
      gitWorkflow: { ...base.gitWorkflow, defaultParentBranch: 'release-a' },
    })
    await b.settings.setSettings({
      ...base,
      gitWorkflow: { ...base.gitWorkflow, defaultParentBranch: 'release-b' },
    })
    expect((await a.settings.getSettings()).gitWorkflow.defaultParentBranch).toBe('release-a')
    expect((await b.settings.getSettings()).gitWorkflow.defaultParentBranch).toBe('release-b')
    // Two rows of one key in workspace_meta, none in meta.
    const rows = await a.all(
      sql`SELECT workspace_id FROM workspace_meta WHERE key = 'settings' ORDER BY workspace_id`,
    )
    expect(rows).toEqual([{ workspace_id: 'ws_a' }, { workspace_id: 'ws_b' }])
    expect(await a.all(sql`SELECT 1 FROM meta WHERE key = 'settings'`)).toEqual([])
  })

  it('holds a model catalog per workspace for the same machine', async () => {
    const [a, b] = await twoWorkspaces()
    const catalog = (label: string) => ({
      machineId: MACHINE,
      byAgent: { claude: [{ value: label, label }] },
      fetchedAt: 1,
    })
    await a.settings.setModelCatalog(catalog('model-a'))
    expect(await b.settings.getModelCatalog(MACHINE)).toBeNull()
    await b.settings.setModelCatalog(catalog('model-b'))
    expect((await a.settings.getModelCatalog(MACHINE))?.byAgent.claude?.[0]?.value).toBe('model-a')
    expect((await b.settings.getModelCatalog(MACHINE))?.byAgent.claude?.[0]?.value).toBe('model-b')
  })

  it('holds the membership cursor, the upgrade receipts and the retired member per workspace', async () => {
    const [a, b] = await twoWorkspaces()
    await a.settings.recordAppliedMembershipVersion(7)
    expect(await a.settings.appliedMembershipVersion()).toBe(7)
    expect(await b.settings.appliedMembershipVersion()).toBe(0)

    await a.settings.completeDataMigration('example-v1')
    expect(await a.settings.dataMigrationComplete('example-v1')).toBe(true)
    expect(await b.settings.dataMigrationComplete('example-v1')).toBe(false)

    await a.settings.recordSetupEnrollment('request', 'receipt-a')
    expect(await a.settings.setupEnrollmentReceipt('request')).toBe('receipt-a')
    expect(await b.settings.setupEnrollmentReceipt('request')).toBeUndefined()

    expect(await a.settings.legacyMutationReceiptCutoff(100)).toBe(100)
    expect(await b.settings.legacyMutationReceiptCutoff(200)).toBe(200)
    expect(await a.settings.legacyMutationReceiptCutoff(300)).toBe(100)

    // The retired solo member is the self-hosted workspace's upgrade fact; another has none.
    expect(await b.settings.retiredSoloMemberId()).toBeNull()
  })

  it('holds the sign-in carry-over end per workspace, written once', async () => {
    const [a, b] = await twoWorkspaces()
    await a.signInCarryOver.writePeriodEndIfAbsent('2026-12-01T00:00:00.000Z')
    await a.signInCarryOver.writePeriodEndIfAbsent('2027-01-01T00:00:00.000Z')
    expect(await a.signInCarryOver.periodEnd()).toBe('2026-12-01T00:00:00.000Z')
    expect(await b.signInCarryOver.periodEnd()).toBeUndefined()
    await b.signInCarryOver.writePeriodEndIfAbsent('2027-02-01T00:00:00.000Z')
    expect(await b.signInCarryOver.periodEnd()).toBe('2027-02-01T00:00:00.000Z')
  })

  it('keeps the identity links receipt an install key, one for every workspace', async () => {
    const [a, b] = await twoWorkspaces()
    await a.run(sql`DELETE FROM meta WHERE key = 'identity.legacyLinksImported'`)
    expect(await b.settings.legacyIdentityLinksImported()).toBe(false)
    await a.settings.recordLegacyIdentityLinksImported()
    expect(await b.settings.legacyIdentityLinksImported()).toBe(true)
    expect(
      await a.all(sql`SELECT value FROM meta WHERE key = 'identity.legacyLinksImported'`),
    ).toEqual([{ value: '1' }])
    expect(
      await a.all(sql`SELECT 1 FROM workspace_meta WHERE key = 'identity.legacyLinksImported'`),
    ).toEqual([])
  })
})
