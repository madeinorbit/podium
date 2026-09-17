/**
 * THE CUSTOMER UPGRADE, server arm [POD-3974]. Acceptance matrix rows (design
 * rev 23, Part B): "Incident fixture", "Already-migrated installation", "Ledger
 * revoke then re-enrol; malformed interior record; rows absent from one store",
 * and the narrower M1 row "snapshot succeeds without ledger".
 *
 * WHAT IS UPGRADED. A database at the release customers run (v0.1.1-edge.4, whose
 * last migration is pinned in the fixture manifest and checked against the real
 * manifest here) with the sanitised rows of the 2026-09-14 incident, plus the
 * enrollment ledger exactly as it was found next to it. The upgrade is the
 * production path — `SessionStore.open` runs the real migration chain and the
 * ledger import inside the exclusive lane — with no repair hook and no seam.
 *
 * THE TWO FIXTURE TRAPS (see retire-the-solo-user.test.ts) are avoided the same
 * way: the database is rewound by applying the real manifest up to the customer
 * release, so `__drizzle_migrations` names a real old ledger and the migrator
 * upgrades rather than baselines; and the seeded row counts are asserted before
 * anything runs, so a pass cannot be vacuous.
 */

import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enrollmentLedger,
  manifest,
  serverRows,
} from '../../../../packages/runtime/src/fixtures/customer-upgrade'
import { LEDGER_IMPORT_MARKER, RETIRED_MEMBER_MAPPING } from '../enrollment-ledger-import'
import { createPortableSnapshot } from '../modules/server-transfer/snapshot'
import { openTestStore } from '../test-support/open-test-store'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const RETIRED = manifest.retiredPrincipal
const HOST = asMachineId(manifest.hostMachineId)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Row = Record<string, string | number | null>
interface MachineRow {
  id: string
  owner_user_id: string | null
  token_hash: string
}

const insert = (db: SqlDatabase, table: string, row: Row) => {
  const names = Object.keys(row)
  db.prepare(
    `INSERT INTO ${table} (${names.map((n) => `\`${n}\``).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...names.map((n) => row[n] as never))
}

const machines = (db: SqlDatabase): MachineRow[] =>
  db.prepare('SELECT id, owner_user_id, token_hash FROM machines ORDER BY id').all() as MachineRow[]
const meta = (db: SqlDatabase, key: string): string | undefined =>
  (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
const feedEpoch = (db: SqlDatabase): string | undefined =>
  (db.prepare('SELECT epoch FROM feed_identity WHERE singleton = 1').get() as { epoch: string } | undefined)?.epoch
const ledgerMachines = () =>
  enrollmentLedger
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; machineId?: string })
    .filter((record) => record.kind === 'enroll')
    .map((record) => record.machineId!)

/** Read the upgraded database on a fresh connection, after the store closed. */
function withDb<T>(root: string, fn: (db: SqlDatabase) => T): T {
  const db = openDatabase(join(root, 'podium.db'))
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/**
 * The customer's disk before the upgrade: a state directory holding
 * `podium.db` at the customer release with the captured rows, and (unless told
 * otherwise) the captured `enrollment.ledger` next to it.
 */
function customerState(options: { ledger?: string | null; extraMachines?: Row[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'podium-customer-upgrade-'))
  roots.push(root)
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name === manifest.customerRelease.lastMigration)
  expect(cut, `pinned customer release migration ${manifest.customerRelease.lastMigration}`).toBeGreaterThan(0)
  const db = openDatabase(join(root, 'podium.db'))
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    // A REAL old ledger, not a first boot (trap 1).
    expect(db.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get()).toEqual({ c: cut + 1 })
    const usersBefore = db.prepare('SELECT id FROM users').all() as { id: string }[]
    expect(usersBefore.map((u) => u.id)).toEqual([RETIRED])
    for (const machine of [...serverRows.machines, ...(options.extraMachines ?? [])]) insert(db, 'machines', machine as Row)
    for (const session of serverRows.sessions) insert(db, 'sessions', session as Row)
    // A customer instance has served a feed: its identity row exists before the upgrade.
    insert(db, 'feed_identity', { singleton: 1, feed_id: 'feed-customer', epoch: 'customer-epoch', minted_at: '2026-08-03T21:37:10.194Z' })
    // Non-vacuous (trap 2): the captured fleet, every row under the retired literal.
    const before = machines(db)
    expect(before.length).toBeGreaterThanOrEqual(6)
    expect(before.every((m) => m.owner_user_id === RETIRED)).toBe(true)
    expect(db.prepare('SELECT count(*) AS c FROM sessions').get()).toEqual({ c: serverRows.sessions.length })
    expect(meta(db, RETIRED_MEMBER_MAPPING)).toBeUndefined()
    expect(meta(db, LEDGER_IMPORT_MARKER)).toBeUndefined()
  } finally {
    db.close()
  }
  const ledger = options.ledger === undefined ? enrollmentLedger : options.ledger
  if (ledger !== null) writeFileSync(join(root, 'enrollment.ledger'), ledger)
  return root
}

/** The production upgrade: migrate + import inside the store's exclusive lane, then boot. */
async function upgrade(root: string): Promise<void> {
  const store = await openTestStore(join(root, 'podium.db'), HOST)
  await store.close()
}

const record = (event: Record<string, unknown>) => JSON.stringify({ v: 1, ...event })
const header = enrollmentLedger.split('\n')[0]!

describe('customer upgrade fixture: server', () => {
  it('is the pinned customer release with the captured, non-vacuous fleet', () => {
    expect(manifest.customerRelease.tag).toBe('v0.1.1-edge.4')
    expect(DRIZZLE_MIGRATIONS.some((m) => m.name === manifest.customerRelease.lastMigration)).toBe(true)
    expect(enrollmentLedger.endsWith('\n')).toBe(true)
    expect(ledgerMachines()).toHaveLength(4)
    const dbIds = new Set(serverRows.machines.map((m) => m.id))
    expect(ledgerMachines().every((id) => dbIds.has(id))).toBe(true)
    // Duplicate hostnames and DB-only rows are part of the captured shape.
    expect(serverRows.machines.filter((m) => m.hostname === 'laptop')).toHaveLength(3)
    expect(serverRows.machines.filter((m) => !ledgerMachines().includes(m.id))).toHaveLength(2)
    expect(serverRows.sessions.some((s) => s.machine_id !== manifest.hostMachineId)).toBe(true)
  })

  it('incident fleet: every machine resolves an owner, no NULLs, no reconcile, one import', async () => {
    const root = customerState()
    await upgrade(root)
    withDb(root, (db) => {
      const member = meta(db, RETIRED_MEMBER_MAPPING)
      expect(member).toBeDefined()
      expect(member).not.toBe(RETIRED)
      const after = machines(db)
      expect(after).toHaveLength(serverRows.machines.length)
      // The incident's signature was NULL owners on exactly the ledger machines.
      expect(after.filter((m) => m.owner_user_id === null)).toEqual([])
      for (const id of ledgerMachines()) {
        expect(after.find((m) => m.id === id)?.owner_user_id, id).toBe(member)
      }
      // DB-only rows keep the owner the retirement migration gave them.
      expect(after.every((m) => m.owner_user_id === member)).toBe(true)
      // Existing credentials survive: nothing was re-enrolled or invented.
      for (const captured of serverRows.machines) {
        expect(after.find((m) => m.id === captured.id)?.token_hash).toBe(captured.token_hash)
      }
      expect(meta(db, LEDGER_IMPORT_MARKER)).toBeDefined()
      expect(feedEpoch(db)).toMatch(/^ledger-import-/)
      expect(db.prepare(`SELECT count(*) AS c FROM sessions WHERE owner_user_id = ?`).get(RETIRED)).toEqual({ c: 0 })
    })
    // The file step: renamed as imported, re-runnable, non-fatal.
    expect(existsSync(join(root, 'enrollment.ledger'))).toBe(false)
    expect(readFileSync(join(root, 'enrollment.ledger.imported'), 'utf8')).toBe(enrollmentLedger)
  })

  it('repeat boot changes nothing', async () => {
    const root = customerState()
    await upgrade(root)
    const first = withDb(root, (db) => ({ machines: machines(db), epoch: feedEpoch(db), marker: meta(db, LEDGER_IMPORT_MARKER) }))
    // A stray ledger appearing later is not re-imported: the marker is authoritative.
    writeFileSync(join(root, 'enrollment.ledger'), enrollmentLedger)
    await upgrade(root)
    const second = withDb(root, (db) => ({ machines: machines(db), epoch: feedEpoch(db), marker: meta(db, LEDGER_IMPORT_MARKER) }))
    expect(second).toEqual(first)
    expect(existsSync(join(root, 'enrollment.ledger'))).toBe(true)
  })

  it("already-migrated installation: the user's fleet maps via the recorded mapping, no reassignment", async () => {
    // The fleet the incident was repaired on: upgraded without the ledger being
    // imported (marker set on a ledger-less boot), owners repaired by hand,
    // then the ledger reappears carrying `owner` events for the minted member.
    const root = customerState({ ledger: null })
    await upgrade(root)
    const { member, before } = withDb(root, (db) => ({ member: meta(db, RETIRED_MEMBER_MAPPING)!, before: machines(db) }))
    withDb(root, (db) => {
      db.prepare('UPDATE machines SET owner_user_id = ? WHERE id = ?').run(member, 'machine-peer')
    })
    writeFileSync(
      join(root, 'enrollment.ledger'),
      `${enrollmentLedger}${record({ kind: 'owner', id: 'owner-host', machineId: 'machine-host', ownerUserId: member, at: '2026-09-14T09:47:00.000Z' })}\n`,
    )
    await upgrade(root)
    withDb(root, (db) => {
      expect(machines(db)).toEqual(before)
      expect(meta(db, RETIRED_MEMBER_MAPPING)).toBe(member)
    })
    expect(existsSync(join(root, 'enrollment.ledger'))).toBe(true)
  })

  it('ledger precedence: revoke then re-enrol stays active; revoke-only is removed; ledger-only and DB-only rows', async () => {
    const root = customerState({
      ledger:
        `${header}\n` +
        [
          record({ kind: 'enroll', id: 'e1', machineId: 'machine-host', serial: 1, ownerUserId: RETIRED, at: '2026-08-01' }),
          record({ kind: 'revoke', id: 'r1', machineId: 'machine-host', serial: 1, by: null, at: '2026-08-02' }),
          record({ kind: 'enroll', id: 'e2', machineId: 'machine-host', serial: 2, ownerUserId: RETIRED, at: '2026-08-03' }),
          record({ kind: 'enroll', id: 'e3', machineId: 'machine-laptop-stale-2', serial: 1, ownerUserId: RETIRED, at: '2026-08-04' }),
          record({ kind: 'revoke', id: 'r3', machineId: 'machine-laptop-stale-2', serial: 1, by: null, at: '2026-08-05' }),
          record({ kind: 'enroll', id: 'e4', machineId: 'machine-ledger-only', serial: 1, ownerUserId: RETIRED, at: '2026-08-06' }),
        ].join('\n') +
        '\n',
    })
    withDb(root, (db) => {
      insert(db, 'grants', {
        resource_kind: 'machine', resource_id: 'machine-laptop-stale-2', grantee: RETIRED, verb: 'use',
        owner: RETIRED, visibility: 'private', created_at: '2026-08-04', actor_kind: 'user', actor_id: RETIRED, on_behalf_of: RETIRED,
      })
    })
    await upgrade(root)
    withDb(root, (db) => {
      const member = meta(db, RETIRED_MEMBER_MAPPING)
      const after = machines(db)
      expect(after.find((m) => m.id === 'machine-host')?.owner_user_id).toBe(member)
      expect(after.find((m) => m.id === 'machine-host')?.token_hash).toBe('hash-host')
      // Revoked in the ledger: deleted with its grants (today's reconcile semantics).
      expect(after.find((m) => m.id === 'machine-laptop-stale-2')).toBeUndefined()
      expect(db.prepare("SELECT count(*) AS c FROM grants WHERE resource_id = 'machine-laptop-stale-2'").get()).toEqual({ c: 0 })
      // Ledger-only: no row invented, no credential invented — the machine pairs again.
      expect(after.find((m) => m.id === 'machine-ledger-only')).toBeUndefined()
      // DB-only (no ledger history): keeps the migrated owner, never NULL.
      expect(after.find((m) => m.id === 'machine-peer')?.owner_user_id).toBe(member)
      expect(after.filter((m) => m.owner_user_id === null)).toEqual([])
    })
  })

  it('malformed interior record refuses the upgrade before any destructive write', async () => {
    const lines = enrollmentLedger.trim().split('\n')
    const root = customerState({ ledger: `${[lines[0], lines[1], '{"v":1,"kind":"enroll"', ...lines.slice(2)].join('\n')}\n` })
    const before = withDb(root, (db) => ({ epoch: feedEpoch(db), count: machines(db).length }))
    await expect(upgrade(root)).rejects.toThrow(/enrollment ledger line 3/)
    withDb(root, (db) => {
      expect(machines(db)).toHaveLength(before.count)
      expect(meta(db, LEDGER_IMPORT_MARKER)).toBeUndefined()
      expect(feedEpoch(db)).not.toMatch(/^ledger-import-/)
    })
    expect(existsSync(join(root, 'enrollment.ledger'))).toBe(true)
    expect(existsSync(join(root, 'enrollment.ledger.imported'))).toBe(false)
  })

  it('a torn trailing append is tolerated and every complete record is imported', async () => {
    const root = customerState({ ledger: `${enrollmentLedger}{"v":1,"kind":"enroll","id":"torn"` })
    await upgrade(root)
    withDb(root, (db) => {
      const member = meta(db, RETIRED_MEMBER_MAPPING)
      for (const id of ledgerMachines()) expect(machines(db).find((m) => m.id === id)?.owner_user_id).toBe(member)
      expect(meta(db, LEDGER_IMPORT_MARKER)).toBeDefined()
    })
  })

  it('M1: the transfer snapshot builds from the upgraded state without the ledger', async () => {
    const root = customerState()
    await upgrade(root)
    writeFileSync(join(root, 'update-signing-key.json'), '{}')
    mkdirSync(join(root, 'transcripts'), { recursive: true })
    const { epoch } = withDb(root, (db) => ({ epoch: feedEpoch(db) ?? '' }))
    const packageDir = join(root, 'transfer-package')
    const snapshot = await createPortableSnapshot({
      stateRoot: root,
      packageDir,
      operationId: 'op-1',
      transferId: 'transfer-1',
      sourceInstanceId: 'instance-1',
      sourceMachineId: HOST,
      targetMachineId: asMachineId('machine-laptop-live'),
      sourceFeedId: 'feed-1',
      sourceFeedEpoch: epoch,
      sourceApplicationVersion: 'fixture',
      sourceSchemaVersion: DRIZZLE_MIGRATIONS.at(-1)!.name,
      checkpoint: () => {},
    })
    const paths = snapshot.files.map((entry) => entry.path)
    expect(paths).toContain('podium.db')
    expect(paths.some((path) => path.includes('enrollment.ledger'))).toBe(false)
    expect(existsSync(join(packageDir, 'podium.db'))).toBe(true)
  })
})
