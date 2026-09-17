import { DRIZZLE_MIGRATIONS } from '../../server/src/migrations/drizzle-manifest.generated'
/**
 * THE CUSTOMER UPGRADE, daemon arm [POD-3974]. Acceptance matrix rows (design
 * rev 23, Part B): "Incident fixture … no whole-daemon barrier", "Live process
 * on an unconfirmed or moved binding", the receipt-for-a-deleted-session half
 * of the oldest-daemon row, and the recovery-skipped half of "new daemon + old
 * server".
 *
 * WHAT IS RECOVERED. The binding store of the incident host as it was on disk:
 * one healthy binding, the three bindings that were exported to other machines
 * and left behind (the residue that took the whole daemon offline on
 * 2026-09-14), a codex receipt for a session the server no longer has, and the
 * inert `.tmp` residue of an interrupted atomic write. The placement facts come
 * from the REAL server store — the same `bindingConfirmations` the handshake
 * answers with — over the sessions the shared fixture places on those machines.
 *
 * Recovery states are CONNECTION-LOCAL (rev 23, "Supervisor and daemon"): the
 * assertions are on observable behaviour — what is quarantined and counted,
 * what serves, what is left on disk — never on a persisted state field.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asAgentIdentityId,
  asMachineId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
} from '@podium/model'
import type { BindingConfirmations } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bindingFileName,
  daemonBindings,
  daemonReceipts,
  manifest,
  serverRows,
} from '../../../packages/runtime/src/fixtures/customer-upgrade'
import { openTestStore } from '../../server/src/test-support/open-test-store'
import { BindingStore } from './binding-store'

const MACHINE = asMachineId(manifest.daemon.machineId)
const HEALTHY = asSessionId('session-healthy')
const RETIRED = manifest.retiredPrincipal
const RESIDUE = ['session-moved-peer-a', 'session-moved-peer-b', 'session-exported-stale'] as const

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** The incident host's daemon state, byte-for-byte from the fixture. */
async function daemonState(): Promise<{ stateDir: string; storeDir: string; receiptDir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'podium-customer-upgrade-daemon-'))
  roots.push(stateDir)
  const storeDir = join(stateDir, 'runtime', 'session-bindings')
  const receiptDir = join(stateDir, 'runtime', 'codex-identity-receipts')
  await mkdir(join(storeDir, 'bindings'), { recursive: true })
  await mkdir(receiptDir, { recursive: true })
  await writeFile(join(stateDir, 'daemon.json'), JSON.stringify({ machineId: MACHINE }))
  await writeFile(
    join(storeDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 3,
      createdAt: '2026-08-03T21:37:10.194Z',
      legacyMigration: null,
      codexReceiptFold: null,
    }),
  )
  for (const [sessionId, record] of Object.entries(daemonBindings)) {
    await writeFile(join(storeDir, 'bindings', bindingFileName(sessionId)), JSON.stringify(record))
  }
  await writeFile(join(storeDir, 'bindings', 'inert.json.123.dead.tmp'), RETIRED)
  for (const [name, receipt] of Object.entries(daemonReceipts)) {
    await writeFile(join(receiptDir, name), JSON.stringify(receipt))
  }
  return { stateDir, storeDir, receiptDir }
}

const snapshotFiles = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const name of (await readdir(dir)).sort())
    out[name] = await readFile(join(dir, name), 'utf8')
  return out
}

/**
 * What the upgraded server answers at connect for the ids the daemon holds:
 * the real `bindingConfirmations` over the shared fixture's session placements,
 * owned by the member the upgrade minted. Not a table typed into this test.
 */
async function serverFacts(
  ids: readonly string[],
): Promise<{ facts: BindingConfirmations; member: string }> {
  const root = await mkdtemp(join(tmpdir(), 'podium-customer-upgrade-server-'))
  roots.push(root)
  const path = join(root, 'podium.db')
  await (await openTestStore(path)).close()
  const member = firstAdminMemberId()
  const db = openDatabase(path)
  try {
    for (const session of serverRows.sessions) {
      const row = { ...session, owner_user_id: member }
      const names = Object.keys(row)
      db.prepare(
        `INSERT INTO sessions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      ).run(...names.map((n) => row[n as keyof typeof row] as never))
    }
    // Rows above reproduce the old database after the test store installed its
    // schema. Run the real new data migration over them, not a fixture mapping.
    const migration = DRIZZLE_MIGRATIONS.find((m) => m.name.endsWith('_session-delegation-record'))
    if (!migration) throw new Error('delegation migration missing')
    for (const statement of migration.sql.split('--> statement-breakpoint').slice(1))
      db.exec(statement)
  } finally {
    db.close()
  }
  const store = await openTestStore(path)
  try {
    return { facts: await store.sessions.bindingConfirmations(ids), member }
  } finally {
    await store.close()
  }
}

describe('customer upgrade fixture: daemon', () => {
  it('holds the captured residue: exported-elsewhere bindings under the retired literal, a receipt with no session', () => {
    for (const id of RESIDUE) {
      const record = daemonBindings[id]
      expect(record.state).toBe('exported')
      expect(record.claimantMachineId).toBe(MACHINE)
      expect(record.transfer?.toMachineId).not.toBe(MACHINE)
      expect(record.delegationHistory.map((d) => d.onBehalfOf)).toEqual([RETIRED])
    }
    expect(daemonBindings['session-healthy'].state).toBe('bound')
    expect(Object.keys(daemonReceipts)).toEqual(['session-deleted.json'])
    expect(serverRows.sessions.some((s) => s.id === 'session-deleted')).toBe(false)
  })

  it('opening the store before connect recovers nothing and rewrites nothing', async () => {
    const { storeDir } = await daemonState()
    const before = await snapshotFiles(join(storeDir, 'bindings'))
    const store = await BindingStore.open({ dir: storeDir })
    expect(store.quarantinedCount).toBe(0)
    expect(await snapshotFiles(join(storeDir, 'bindings'))).toEqual(before)
  })

  it('incident fleet: each stray binding is quarantined on its own, counted, and the healthy session serves', async () => {
    const { stateDir, storeDir, receiptDir } = await daemonState()
    const store = await BindingStore.open({ dir: storeDir })
    const ids = await store.inventory(receiptDir)
    // Everything the daemon holds is asked about; the inert tmp file is not a binding.
    expect(ids).toEqual([
      'session-deleted',
      'session-exported-stale',
      'session-healthy',
      'session-moved-peer-a',
      'session-moved-peer-b',
    ])
    const { facts, member } = await serverFacts(ids)
    expect(facts['session-deleted']).toEqual({ owner: null, machineId: null, closed: false })
    expect(facts['session-moved-peer-a']?.machineId).toBe('machine-peer')

    store.confirmInventory(MACHINE, facts)
    // The whole-daemon barrier of the incident is gone: exactly the strays, no more.
    expect(
      manifest.daemon.expectedQuarantined.filter((id) => store.isQuarantined(asSessionId(id))),
    ).toEqual(manifest.daemon.expectedQuarantined)
    expect(store.quarantinedCount).toBe(manifest.daemon.expectedQuarantined.length)
    expect(store.isQuarantined(HEALTHY)).toBe(false)

    // The connected daemon's recovery, exactly as host-runtime runs it.
    const legacyDelegationForSession = (id: string) => {
      const fact = facts[id]
      return !store.isQuarantined(asSessionId(id)) ? fact?.delegation : undefined
    }
    await store.recoverLegacyState({
      dir: storeDir,
      legacyStateDir: stateDir,
      codexReceiptDir: receiptDir,
      legacyDelegationForSession,
    })
    // The healthy binding was re-keyed through the server's answer, nothing inferred.
    expect((await store.read(HEALTHY))?.delegation?.onBehalfOf).toBe(member)
    // Strays are left alone on disk, still carrying the literal; the receipt survives.
    for (const id of RESIDUE) {
      expect((await store.read(asSessionId(id)))?.delegationHistory.at(-1)?.onBehalfOf).toBe(
        RETIRED,
      )
    }
    expect(await readFile(join(receiptDir, 'session-deleted.json'), 'utf8')).toContain(
      'native-thread-deleted',
    )
    expect(await store.read(asSessionId('session-deleted'))).toBeNull()

    // No new stray work: a quarantined id stays quarantined; unrelated new work proceeds.
    const fresh = await store.ensureBinding({
      sessionId: asSessionId('session-new-after-upgrade'),
      agentKind: 'codex',
      claimantMachineId: MACHINE,
      delegation: {
        revision: 1,
        actor: asAgentIdentityId('session-new-after-upgrade'),
        onBehalfOf: asUserId(member),
        grantedScope: { kind: 'all' },
        parentBindingId: null,
      },
    })
    expect(await store.read(fresh.sessionId)).not.toBeNull()
    expect(store.isQuarantined(fresh.sessionId)).toBe(false)
    expect(store.quarantinedCount).toBe(manifest.daemon.expectedQuarantined.length)
  })

  it('live process on a moved binding: retained while alive, counted; removed only after closed and gone', async () => {
    const { storeDir, receiptDir } = await daemonState()
    const store = await BindingStore.open({ dir: storeDir })
    const ids = await store.inventory(receiptDir)
    const { facts } = await serverFacts(ids)
    store.confirmInventory(MACHINE, facts)
    const before = await snapshotFiles(join(storeDir, 'bindings'))
    const alive = async () => true
    await store.reapQuarantined(alive, receiptDir)
    expect(await snapshotFiles(join(storeDir, 'bindings'))).toEqual(before)
    expect(store.quarantinedCount).toBe(manifest.daemon.expectedQuarantined.length)

    // The server later says one moved session is closed; its process is still alive: kept.
    await store.inventory(receiptDir)
    store.confirmInventory(MACHINE, {
      ...facts,
      'session-moved-peer-a': { ...facts['session-moved-peer-a']!, closed: true },
    })
    await store.reapQuarantined(alive, receiptDir)
    expect(await store.read(asSessionId('session-moved-peer-a'))).not.toBeNull()
    // Process gone: cleaned up. The other strays and the receipt are untouched.
    await store.reapQuarantined(async () => false, receiptDir)
    expect(await store.read(asSessionId('session-moved-peer-a'))).toBeNull()
    expect(await store.read(asSessionId('session-moved-peer-b'))).not.toBeNull()
    expect(await store.read(asSessionId('session-exported-stale'))).not.toBeNull()
    expect(await readFile(join(receiptDir, 'session-deleted.json'), 'utf8')).toContain(
      'native-thread-deleted',
    )
    expect(store.quarantinedCount).toBe(manifest.daemon.expectedQuarantined.length - 1)
  })

  it('new daemon + old server: no confirmations means recovery is skipped, never quarantine', async () => {
    const { stateDir, storeDir, receiptDir } = await daemonState()
    const store = await BindingStore.open({ dir: storeDir })
    const before = await snapshotFiles(join(storeDir, 'bindings'))
    await store.inventory(receiptDir)
    store.confirmInventory(MACHINE, undefined)
    expect(store.quarantinedCount).toBe(0)
    expect(store.isQuarantined(HEALTHY)).toBe(false)
    await store.recoverLegacyState({
      dir: storeDir,
      legacyStateDir: stateDir,
      codexReceiptDir: receiptDir,
    })
    expect(await snapshotFiles(join(storeDir, 'bindings'))).toEqual(before)
    expect(await readFile(join(receiptDir, 'session-deleted.json'), 'utf8')).toContain(
      'native-thread-deleted',
    )
  })

  it('long-offline return: a second connect reaches the same result', async () => {
    const { stateDir, storeDir, receiptDir } = await daemonState()
    const store = await BindingStore.open({ dir: storeDir })
    const { facts, member } = await serverFacts(await store.inventory(receiptDir))
    const connect = async () => {
      await store.inventory(receiptDir)
      store.confirmInventory(MACHINE, facts)
      await store.recoverLegacyState({
        dir: storeDir,
        legacyStateDir: stateDir,
        codexReceiptDir: receiptDir,
        legacyDelegationForSession: (id) =>
          !store.isQuarantined(id) ? facts[id]?.delegation : undefined,
      })
    }
    await connect()
    const first = {
      count: store.quarantinedCount,
      files: await snapshotFiles(join(storeDir, 'bindings')),
    }
    await connect()
    expect(store.quarantinedCount).toBe(first.count)
    expect(await snapshotFiles(join(storeDir, 'bindings'))).toEqual(first.files)
    expect((await store.read(HEALTHY))?.delegation?.onBehalfOf).toBe(member)
  })
})
