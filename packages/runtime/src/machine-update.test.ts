import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginMachineUpdateMigrations,
  MachineUpdateExecutor,
  machineUpdateJournalPath,
  machineUpdateMigrationsPath,
  readAppliedUpdateMigrations,
  readMachineUpdateJournal,
  type MachineUpdateAdapter,
} from './machine-update'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const adapter: MachineUpdateAdapter = {
  runningVersion: () => '2.0.0',
  runningDigest: () => 'new',
  prepare: async () => ({ digest: 'new', releaseHadMigrations: true }),
  activate: async () => {},
  restart: async () => 'handover-pending',
  discard: async () => {},
}
async function fixture() {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'podium-migration-journal-'))
  roots.push(runtimeDir)
  const executor = new MachineUpdateExecutor({ runtimeDir, adapter, report: () => {} })
  await executor.accept({
    type: 'updateGrant',
    grantId: 'grant-one',
    issuedAt: 1,
    target: { version: '2.0.0', critical: false, artifacts: {} },
  })
  return { runtimeDir, executor }
}

describe('machine update migration journal', () => {
  it('exposes fresh server receipts in an already-running executor and persists them on transition', async () => {
    const { runtimeDir, executor } = await fixture()
    expect(executor.snapshot()?.appliedMigrations).toEqual([])
    beginMachineUpdateMigrations(runtimeDir, 'grant-one', 'unused.db', ['migration-a'])([
      'migration-a',
    ])
    const expected = [{ id: 'migration-a', appliedAt: expect.any(Number) }]
    expect(executor.snapshot()?.appliedMigrations).toEqual(expected)
    await executor.confirmBoot(true)
    expect(
      JSON.parse(readFileSync(machineUpdateJournalPath(runtimeDir), 'utf8')).appliedMigrations,
    ).toEqual(expected)
    expect(readMachineUpdateJournal(runtimeDir)?.appliedMigrations).toEqual(expected)
    expect(
      new MachineUpdateExecutor({ runtimeDir, adapter, report: () => {} }).snapshot()
        ?.appliedMigrations,
    ).toEqual(expected)
  })

  it('keeps migration receipts per grant, including across later grants and restarts', async () => {
    const { runtimeDir, executor } = await fixture()
    beginMachineUpdateMigrations(runtimeDir, 'grant-one', 'unused.db', ['migration-a'])([
      'migration-a',
    ])
    await executor.confirmBoot(true)
    await executor.accept({
      type: 'updateGrant',
      grantId: 'grant-two',
      issuedAt: 2,
      target: { version: '2.0.0', critical: false, artifacts: {} },
    })
    expect(executor.snapshot()?.appliedMigrations).toEqual([])
    expect(readMachineUpdateJournal(runtimeDir)?.appliedMigrations).toEqual([])
    expect(readAppliedUpdateMigrations(runtimeDir, 'grant-one').map((m) => m.id)).toEqual([
      'migration-a',
    ])
  })

  it('retains earlier batches and timestamps without duplicating migration IDs', async () => {
    const { runtimeDir } = await fixture()
    beginMachineUpdateMigrations(runtimeDir, 'grant-one', 'unused.db', ['migration-a'])([
      'migration-a',
    ])
    const first = readAppliedUpdateMigrations(runtimeDir, 'grant-one')[0]
    beginMachineUpdateMigrations(runtimeDir, 'grant-one', 'unused.db', [
      'migration-a',
      'migration-b',
    ])(['migration-a', 'migration-b'])
    expect(readAppliedUpdateMigrations(runtimeDir, 'grant-one')).toEqual([
      first,
      { id: 'migration-b', appliedAt: expect.any(Number) },
    ])
  })

  it('defaults older journals to empty execution when no receipt exists', async () => {
    const { runtimeDir } = await fixture()
    const journal = JSON.parse(readFileSync(machineUpdateJournalPath(runtimeDir), 'utf8'))
    delete journal.appliedMigrations
    writeFileSync(machineUpdateJournalPath(runtimeDir), JSON.stringify(journal))
    expect(readMachineUpdateJournal(runtimeDir)?.appliedMigrations).toEqual([])
  })

  it('retains a checkpointed applied list if the server receipt file is lost', async () => {
    const { runtimeDir, executor } = await fixture()
    beginMachineUpdateMigrations(runtimeDir, 'grant-one', 'unused.db', ['migration-a'])([
      'migration-a',
    ])
    await executor.confirmBoot(true)
    rmSync(machineUpdateMigrationsPath(runtimeDir, 'grant-one'))
    expect(
      readMachineUpdateJournal(runtimeDir)?.appliedMigrations.map((entry) => entry.id),
    ).toEqual(['migration-a'])
    expect(executor.snapshot()?.appliedMigrations.map((entry) => entry.id)).toEqual(['migration-a'])
  })

  it('never treats a corrupt or mismatched receipt as empty execution', async () => {
    const { runtimeDir } = await fixture()
    beginMachineUpdateMigrations(runtimeDir, 'grant-one', 'unused.db', [])([])
    const path = machineUpdateMigrationsPath(runtimeDir, 'grant-one')
    writeFileSync(path, '{')
    expect(() => readMachineUpdateJournal(runtimeDir)).toThrow()
    writeFileSync(path, JSON.stringify({ grantId: 'another-grant', appliedMigrations: [] }))
    expect(() => readMachineUpdateJournal(runtimeDir)).toThrow(/grant mismatch/)
  })

  it('snapshots cannot mutate the executor checkpoint', async () => {
    const { runtimeDir, executor } = await fixture()
    beginMachineUpdateMigrations(runtimeDir, 'grant-one', 'unused.db', ['migration-a'])([
      'migration-a',
    ])
    await executor.confirmBoot(true)
    const snapshot = executor.snapshot()!
    snapshot.appliedMigrations[0]!.id = 'tampered'
    expect(executor.snapshot()?.appliedMigrations[0]?.id).toBe('migration-a')
  })

  it('contains opaque grant IDs inside the receipt directory', async () => {
    const { runtimeDir } = await fixture()
    expect(dirname(machineUpdateMigrationsPath(runtimeDir, '../../elsewhere'))).toBe(
      join(runtimeDir, 'machine-update-migrations'),
    )
  })
})
