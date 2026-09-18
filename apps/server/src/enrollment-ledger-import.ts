import { readFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MachineId, UserId } from '@podium/model'
import { createLogger } from '@podium/logger'
import type { SqlDatabase } from '@podium/runtime/sqlite'

const log = createLogger('server:enrollment-import')
const VERSION = 1
export const RETIRED_MEMBER_MAPPING = 'retired_solo_member_id'
export const LEDGER_IMPORT_MARKER = 'enrollment_ledger_imported'

export type ValidatedLedgerEvent =
  | { kind: 'enroll'; id: string; machineId: MachineId; serial: number; ownerUserId: UserId | null; at: string }
  | { kind: 'revoke'; id: string; machineId: MachineId; serial: number; by: string | null; at: string }
  | { kind: 'owner'; id: string; machineId: MachineId; ownerUserId: UserId; at: string }

export interface ValidatedLedgerSnapshot {
  pairingRoot: string
  events: ValidatedLedgerEvent[]
}

function fail(line: number, message: string): never {
  throw new Error(`enrollment ledger line ${line}: ${message}`)
}

function stringField(value: unknown, name: string, line: number): string {
  if (typeof value !== 'string' || value.length === 0) fail(line, `${name} must be a non-empty string`)
  return value
}

function serialField(value: unknown, line: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(line, 'serial must be a positive integer')
  return value as number
}

/** Parse the complete prefix of a ledger. Only an incomplete final JSON line
 * without a newline is tolerated; every interior or complete malformed record
 * refuses before the caller can mutate the database. */
export function readValidatedEnrollmentLedger(path: string): ValidatedLedgerSnapshot {
  const text = readFileSync(path, 'utf8')
  const rawLines = text.split('\n')
  const trailingTorn = rawLines.length > 1 && rawLines.at(-1) !== ''
  const seen = new Set<string>()
  let pairingRoot: string | undefined
  const events: ValidatedLedgerEvent[] = []
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]!.trim()
    if (raw === '') continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      if (trailingTorn && i === rawLines.length - 1) break
      fail(i + 1, 'invalid JSON record')
    }
    if (!value || typeof value !== 'object') fail(i + 1, 'record must be an object')
    const record = value as Record<string, unknown>
    if (record.v !== VERSION) fail(i + 1, 'unsupported version')
    if (record.kind !== 'header' && pairingRoot === undefined) fail(i + 1, 'header must be first')
    if (record.kind === 'header') {
      if (pairingRoot !== undefined) fail(i + 1, 'duplicate header')
      pairingRoot = stringField(record.pairingRoot, 'pairingRoot', i + 1)
      continue
    }
    const id = stringField(record.id, 'id', i + 1)
    if (seen.has(id)) fail(i + 1, `duplicate event id ${id}`)
    seen.add(id)
    const machineId = stringField(record.machineId, 'machineId', i + 1) as MachineId
    const at = stringField(record.at, 'at', i + 1)
    if (record.kind === 'enroll') {
      if (record.ownerUserId !== null && typeof record.ownerUserId !== 'string') fail(i + 1, 'ownerUserId must be string or null')
      events.push({ kind: 'enroll', id, machineId, serial: serialField(record.serial, i + 1), ownerUserId: record.ownerUserId as UserId | null, at })
    } else if (record.kind === 'revoke') {
      if (record.by !== null && typeof record.by !== 'string') fail(i + 1, 'by must be string or null')
      events.push({ kind: 'revoke', id, machineId, serial: serialField(record.serial, i + 1), by: record.by as string | null, at })
    } else if (record.kind === 'owner') {
      events.push({ kind: 'owner', id, machineId, ownerUserId: stringField(record.ownerUserId, 'ownerUserId', i + 1) as UserId, at })
    } else {
      fail(i + 1, 'unknown record kind')
    }
  }
  if (pairingRoot === undefined) throw new Error('enrollment ledger has no header')
  return { pairingRoot, events }
}

function latestState(snapshot: ValidatedLedgerSnapshot): Map<string, { serial: number; revoked: boolean; owner: string | null | undefined }> {
  const state = new Map<string, { serial: number; revoked: boolean; owner: string | null | undefined }>()
  for (const event of snapshot.events) {
    const current = state.get(event.machineId) ?? { serial: 0, revoked: false, owner: undefined }
    if (event.kind === 'enroll') {
      if (event.serial >= current.serial) {
        current.serial = event.serial
        current.revoked = false
        current.owner = event.ownerUserId
      }
    } else if (event.kind === 'revoke') {
      if (event.serial >= current.serial) current.revoked = true
    } else if (!current.revoked) {
      current.owner = event.ownerUserId
    }
    state.set(event.machineId, current)
  }
  return state
}

/** Apply a validated snapshot atomically. Rows absent from the database are
 * deliberately ignored: the machine must pair again, so no credential is
 * invented. The caller owns the exclusive upgrade lane. */
export function importEnrollmentLedger(db: SqlDatabase, stateDir: string): boolean {
  const marker = db.prepare('SELECT value FROM meta WHERE key = ?').get(LEDGER_IMPORT_MARKER) as { value: string } | undefined
  if (marker) return false
  const path = join(stateDir, 'enrollment.ledger')
  if (!existsSync(path)) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(LEDGER_IMPORT_MARKER, new Date().toISOString())
    return false
  }
  const snapshot = readValidatedEnrollmentLedger(path)
  const mapping = (db.prepare('SELECT value FROM meta WHERE key = ?').get(RETIRED_MEMBER_MAPPING) as { value: string } | undefined)?.value
  const users = new Set((db.prepare('SELECT id FROM users').all() as { id: string }[]).map((row) => row.id))
  const states = latestState(snapshot)
  const unmappedOwners = new Set<string>()
  const importedUnowned: string[] = []
  for (const [machineId, state] of states) {
    if (state.owner === 'user:sole') {
      // Missing provenance cannot authorize any member. Boot still completes:
      // existing machines become explicitly unowned and admins may adopt them.
      state.owner = mapping || null
      if (!mapping) unmappedOwners.add(machineId)
    }
    if (state.owner !== undefined && state.owner !== null && !users.has(state.owner)) {
      throw new Error(`enrollment ledger owner '${state.owner}' has no matching member`)
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [machineId, state] of states) {
      if (state.revoked) {
        db.prepare('DELETE FROM grants WHERE resource_kind = ? AND resource_id = ?').run('machine', machineId)
        db.prepare('DELETE FROM machines WHERE id = ?').run(machineId)
      } else if (state.owner !== undefined) {
        // A ledger-only id has no row to hold custody: the old column update was a no-op
        // for it, and a grant edge without a machine would be an orphan.
        const exists = db.prepare('SELECT 1 AS one FROM machines WHERE id = ?').get(machineId)
        if (!exists) continue
        if (unmappedOwners.has(machineId)) importedUnowned.push(machineId)
        // Custody is a personal grant edge (S5, POD-4151): the manage edge with custody=1
        // plus a use edge, written exactly as 20260917212210_machine-custody-grant-edges
        // wrote them from the old owner column. The previous custodian, if any, loses
        // both edges; shares held by others stay as records.
        const previous = db.prepare(
          'SELECT grantee FROM grants WHERE resource_kind = ? AND resource_id = ? AND custody = 1',
        ).get('machine', machineId) as { grantee: string } | undefined
        if (previous && previous.grantee !== state.owner) {
          db.prepare("DELETE FROM grants WHERE resource_kind = ? AND resource_id = ? AND grantee = ? AND verb IN ('use', 'manage')")
            .run('machine', machineId, previous.grantee)
        }
        if (state.owner === null) {
          if (previous) db.prepare("DELETE FROM grants WHERE resource_kind = ? AND resource_id = ? AND grantee = ? AND verb IN ('use', 'manage')")
            .run('machine', machineId, previous.grantee)
        } else {
          const createdAt = new Date().toISOString()
          for (const verb of ['use', 'manage'] as const) {
            db.prepare(
              'INSERT INTO grants (resource_kind, resource_id, grantee, verb, owner, visibility, created_at, actor_kind, actor_id, on_behalf_of, custody) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(resource_kind, resource_id, grantee, verb) DO UPDATE SET custody = excluded.custody',
            ).run('machine', machineId, state.owner, verb, state.owner, 'owned-compute', createdAt, 'user', state.owner, state.owner, verb === 'manage' ? 1 : 0)
          }
          db.prepare(
            'INSERT INTO grant_audiences (resource_kind, resource_id, grantee) VALUES (?, ?, ?) ON CONFLICT(resource_kind, resource_id, grantee) DO NOTHING',
          ).run('machine', machineId, state.owner)
        }
      }
    }
    db.prepare('UPDATE feed_identity SET epoch = ? WHERE singleton = 1').run(`ledger-import-${Date.now()}`)
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(LEDGER_IMPORT_MARKER, new Date().toISOString())
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  // Publish only committed outcomes, never names from a rolled-back import.
  if (importedUnowned.length > 0) log.warn('enrollment ledger imported machines as unowned', {
    key: RETIRED_MEMBER_MAPPING,
    reason: 'retired principal mapping is absent; administrator adoption required',
    machineIds: importedUnowned.sort(),
  })
  try {
    renameSync(path, `${path}.imported`)
  } catch {
    // The marker makes the file operation safely re-runnable and non-fatal.
  }
  return true
}
