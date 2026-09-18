import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { MachineId } from '@podium/model'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { stateDir } from './config'

export { stateDir }
export const MACHINE_STATE_FILE = 'machine.json'
const LEGACY_FILES = ['machine.id', 'daemon.json', 'supervisor.json', 'connectivity.json'] as const

export class LocalMachineIdentityConflictError extends Error {
  constructor(readonly expected: MachineId, readonly observed: MachineId) {
    super(`machine identity ${observed} conflicts with ${expected}`)
    this.name = 'LocalMachineIdentityConflictError'
  }
}

/** One persistence owner for box-bound machine state. Role adapters own only their section. */
export interface MachineState {
  version: 1
  machineId: MachineId
  daemon?: Record<string, unknown>
  supervisor?: Record<string, unknown>
  connectivity?: Record<string, unknown>
  /** Exact legacy inputs committed with the replacement; cleanup can resume after a crash. */
  importedFiles: Partial<Record<(typeof LEGACY_FILES)[number], string>>
}
function readOptional(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function object(raw: string, path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid machine state at ${path}`)
  return value as Record<string, unknown>
}
function digest(raw: string): string { return createHash('sha256').update(raw).digest('hex') }
function sync(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function parseMachine(raw: string, path: string): MachineState {
  const value = object(raw, path)
  if (value.version !== 1 || typeof value.machineId !== 'string' || !value.machineId.trim()
    || !value.importedFiles || typeof value.importedFiles !== 'object') throw new Error(`invalid machine state at ${path}`)
  return value as unknown as MachineState
}

/** Read-only: never mints identity or imports legacy state. */
export function readMachineState(dir = stateDir()): MachineState | undefined {
  const path = join(dir, MACHINE_STATE_FILE)
  const raw = readOptional(path)
  return raw === undefined ? undefined : parseMachine(raw, path)
}

/** Verify replacement bytes before any legacy input is removed. */
function finishImport(dir: string, state: MachineState): void {
  let removed = false
  for (const name of LEGACY_FILES) {
    const expected = state.importedFiles[name]
    if (expected === undefined) continue
    const path = join(dir, name)
    const raw = readOptional(path)
    if (raw === undefined) continue
    if (digest(raw) !== expected) throw new Error(`legacy machine state changed during migration: ${path}`)
    try { unlinkSync(path); removed = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (removed) sync(dir)
}

/** Atomic publish: wx staging + hard-link prevents a cold-start loser overwriting the winner. */
function persist(dir: string, state: MachineState, exclusive: boolean): void {
  const path = join(dir, MACHINE_STATE_FILE)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    sync(temporary)
    if (exclusive) linkSync(temporary, path)
    else renameSync(temporary, path)
    sync(dir)
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** One-time file import, not database reconciliation or owner inference. */
export function loadMachineState(dir = stateDir(), expectedId?: MachineId, allowCreate = true): MachineState {
  mkdirSync(dir, { recursive: true })
  let current = readMachineState(dir)
  if (!current) {
    const importedFiles: MachineState['importedFiles'] = {}
    const sections: Partial<Pick<MachineState, 'daemon' | 'supervisor' | 'connectivity'>> = {}
    // The root identity is the one a credential authenticates: the supervisor's row
    // when the box is supervised, else the daemon's own credential row. `machine.id`
    // is the bare pre-consolidation id file and the weakest witness: a re-paired box
    // keeps a stale one (flatblock: machine.id from an earlier pairing, daemon.json the
    // live row), and a supervised box keeps a dead daemon.json (ludovico). Disagreement
    // is ordinary, never a refusal; every section is kept verbatim.
    const legacyIds: Partial<Record<'supervisor.json' | 'machine.id' | 'daemon.json', string>> = {}
    for (const name of LEGACY_FILES) {
      const raw = readOptional(join(dir, name))
      if (raw === undefined) continue
      importedFiles[name] = digest(raw)
      if (name === 'machine.id') {
        if (!raw.trim()) throw new Error('empty legacy machine identity')
        legacyIds['machine.id'] = raw.trim()
      } else {
        const data = object(raw, join(dir, name))
        const section = name.slice(0, -5) as 'daemon' | 'supervisor' | 'connectivity'
        sections[section] = data
        if (section !== 'connectivity') {
          if (typeof data.machineId !== 'string' || !data.machineId.trim()) throw new Error(`invalid legacy identity in ${name}`)
          legacyIds[section === 'daemon' ? 'daemon.json' : 'supervisor.json'] = data.machineId
        }
      }
    }
    const legacyId = legacyIds['supervisor.json'] ?? legacyIds['daemon.json'] ?? legacyIds['machine.id']
    if (legacyId === undefined && !expectedId && !allowCreate) throw new Error('machine identity is missing')
    const machineId = (legacyId ?? expectedId ?? randomUUID()) as MachineId
    if (expectedId !== undefined && machineId !== expectedId) throw new LocalMachineIdentityConflictError(expectedId, machineId)
    const candidate: MachineState = { version: 1, machineId, ...sections, importedFiles }
    let published = false
    try { persist(dir, candidate, true); published = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    current = readMachineState(dir)
    if (!current) throw new Error('machine state publication failed')
    if (published && !isDeepStrictEqual(current, candidate)) throw new Error('machine state verification failed')
    // A winner may have imported a different snapshot. Never delete inputs on that basis.
    for (const [name, hash] of Object.entries(importedFiles)) {
      if (current.importedFiles[name as keyof typeof importedFiles] !== hash) throw new Error('concurrent machine migration input changed')
    }
  }
  if (expectedId !== undefined && current.machineId !== expectedId) throw new LocalMachineIdentityConflictError(expectedId, current.machineId)
  finishImport(dir, current)
  return current
}

/** All role writers merge through this owner, preserving unrelated sections and import receipts. */
export function updateMachineState(dir: string, change: (state: MachineState) => void, expectedId?: MachineId): MachineState {
  const state = loadMachineState(dir, expectedId)
  const id = state.machineId
  change(state)
  if (state.machineId !== id) throw new Error('machine identity is immutable')
  persist(dir, state, false)
  return state
}

export function readOrCreateLocalMachineId(dir: string = stateDir()): MachineId {
  return loadMachineState(dir).machineId
}

/** Transitional box-bound maintenance token. S7 machine.key remains a separate keypair.
 * POD-4197 owns replacement of the remaining maintenance consumers; never migrate this
 * bearer onto machine.key or regenerate it as part of the state-file consolidation.
 */
export function readOrCreateDaemonSecret(dir: string = stateDir()): string {
  const path = join(dir, 'daemon.secret')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return existing
  } catch {
    // not created yet — fall through and create it
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dir, { recursive: true })
  try {
    // `wx`: fail if the file already exists, so a server/daemon startup race can't have
    // one clobber the other's secret — the loser re-reads the winner's value.
    writeFileSync(path, secret, { mode: 0o600, flag: 'wx' })
    return secret
  } catch {
    return readFileSync(path, 'utf8').trim()
  }
}
