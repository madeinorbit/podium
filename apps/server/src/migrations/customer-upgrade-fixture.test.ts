import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openTestStore } from '../test-support/open-test-store'
import { enrollmentLedger, manifest } from '../../../../packages/runtime/src/fixtures/customer-upgrade'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('customer upgrade fixture: server', () => {
  it('is a pinned, non-vacuous v0.1.1-edge.4 customer state', () => {
    expect(manifest.customerSchema).toBe('v0.1.1-edge.4')
    expect(manifest.migrationLedger).toBe('pinned-to-v0.1.1-edge.4')
    expect(manifest.retiredPrincipal).toBe('user:sole')
    expect(manifest.machines.filter((machine) => machine.owner === manifest.retiredPrincipal)).toHaveLength(3)
    expect(enrollmentLedger.trim().split('\n')).toHaveLength(4)
    expect(enrollmentLedger).toContain('machine-handoff')
  })

  it('upgrades every captured machine owner without boot reconciliation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-customer-upgrade-server-'))
    roots.push(root)
    const path = join(root, 'podium.db')
    const machineId = asMachineId('machine-host')
    await (await openTestStore(path, machineId)).close()
    const db = openDatabase(path)
    db.prepare(
      'INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('machine-host', 'fixture-host', 'fixture-host', 'hash-host', '2026-09-01', '2026-09-01', manifest.retiredPrincipal)
    db.prepare(
      'INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('machine-handoff', 'fixture-handoff', 'fixture-handoff', 'hash-handoff', '2026-09-01', '2026-09-01', manifest.retiredPrincipal)
    db.close()
    writeFileSync(join(root, 'enrollment.ledger'), enrollmentLedger)

    await (await openTestStore(path, machineId)).close()
    const after = openDatabase(path)
    const owners = after.prepare('SELECT id, owner_user_id FROM machines ORDER BY id').all() as { id: string; owner_user_id: string | null }[]
    after.close()

    expect(owners).toHaveLength(2)
    expect(owners.every((row) => row.owner_user_id === manifest.replacementPrincipal)).toBe(true)
    expect(owners.some((row) => row.owner_user_id === null)).toBe(false)
  })
})
