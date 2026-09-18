import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deleteLegacyInstancePasswordFile, readLegacyInstancePasswordHash, stagePasswordForFirstBoot, verifyPasswordHash } from './auth-store'
import { clearPendingGrant, writePendingGrant } from './update-pending'
import { saveConfig } from './config'
import { writeConnectivity } from './connectivity'
import { readMachineState, readOrCreateLocalMachineId } from './local-machine'
import { createMachineCredential, acknowledgeMachineCredentialRotation, machinePublicKeyWire } from './machine-credential'
import { loadSupervisorState, saveSupervisorState } from './machine-supervisor'
import { saveCachedSessionToken } from './session-mint'

const failures = vi.hoisted(() => ({ unlink: undefined as string | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, unlinkSync: (path: import('node:fs').PathLike) => {
    if (path === failures.unlink) throw new Error('simulated cleanup crash')
    return actual.unlinkSync(path)
  } }
})

// Final state after credential rotation; legacy bearer files may remain until acknowledgement.
const ALLOWED_PERSISTENT_FILES = [
  'cli-session.json',
  'config.json',
  'instance.json',
  'machine.json',
  'machine.key',
]
const roots: string[] = []
afterEach(() => {
  failures.unlink = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('fresh machine writers create only the approved five state-root files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-state-layout-'))
  roots.push(dir)
  saveConfig({ mode: 'all-in-one' }, join(dir, 'config.json'))
  const machineId = readOrCreateLocalMachineId(dir)
  createMachineCredential(dir)
  const originalKey = readFileSync(join(dir, 'machine.key'), 'utf8')
  const supervisor = loadSupervisorState(dir)
  expect(supervisor.machineId).toBe(machineId)
  saveSupervisorState(dir, { ...supervisor, generation: 1 })
  writeConnectivity({ state: 'connected', processId: process.pid }, dir)
  writeConnectivity({ state: 'disconnected', processId: process.pid }, dir)
  saveCachedSessionToken({ token: 'test-session', expiresAt: '2099-01-01T00:00:00Z' }, dir)

  // auth.json is the setup → first successful boot handoff, never persistent state.
  await stagePasswordForFirstBoot('layout-test-password', dir)
  expect(readdirSync(dir).sort()).toEqual(['auth.json', ...ALLOWED_PERSISTENT_FILES])
  // Exercise the runtime handoff API here; the real-runtime test proves the
  // server calls deletion only after adopting the credential at first boot.
  const stagedHash = readLegacyInstancePasswordHash(dir)
  expect(await verifyPasswordHash('layout-test-password', stagedHash ?? '')).toBe(true)
  deleteLegacyInstancePasswordFile(dir)
  expect(readdirSync(dir).sort()).toEqual(ALLOWED_PERSISTENT_FILES)

  // Update recovery has its own bounded marker; it is not a permanent seventh file.
  writePendingGrant(dir, { grantId: 'layout', targetVersion: 'next', previousVersion: 'old', attempts: 0, startedAt: 1 })
  expect(readdirSync(dir).sort()).toEqual([...ALLOWED_PERSISTENT_FILES, 'pending-update.json'])
  clearPendingGrant(dir)
  expect(readdirSync(dir).sort()).toEqual(ALLOWED_PERSISTENT_FILES)
  expect(readOrCreateLocalMachineId(dir)).toBe(machineId)
  expect(readFileSync(join(dir, 'machine.key'), 'utf8')).toBe(originalKey)
})

it('imports all four legacy files without changing credentials and removes them only after publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-state-upgrade-'))
  roots.push(dir)
  const daemon = { machineId: 'machine-upgrade', token: 'original-token', updatePubkey: 'original-pin' }
  const supervisor = { ...daemon, generation: 7, assignment: { server: true, agentExecution: true } }
  const connectivity = { state: 'disconnected', updatedAt: '2026-09-01T00:00:00Z', lastHelloOkAt: '2026-08-31T00:00:00Z' }
  writeFileSync(join(dir, 'machine.id'), daemon.machineId)
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify(daemon))
  writeFileSync(join(dir, 'supervisor.json'), JSON.stringify(supervisor))
  writeFileSync(join(dir, 'connectivity.json'), JSON.stringify(connectivity))
  const token = 'original-maintenance-token'
  writeFileSync(join(dir, 'daemon.secret'), token)
  createMachineCredential(dir)
  const key = readFileSync(join(dir, 'machine.key'), 'utf8')

  expect(readOrCreateLocalMachineId(dir)).toBe(daemon.machineId)
  expect(loadSupervisorState(dir)).toEqual(supervisor)
  expect(readMachineState(dir)).toMatchObject({ daemon, supervisor, connectivity })
  expect(readdirSync(dir).sort()).toEqual(['daemon.secret', 'machine.json', 'machine.key'])
  expect(readFileSync(join(dir, 'daemon.secret'), 'utf8')).toBe(token)
  expect(readFileSync(join(dir, 'machine.key'), 'utf8')).toBe(key)
  const persisted = readFileSync(join(dir, 'machine.json'), 'utf8')
  loadSupervisorState(dir)
  expect(readFileSync(join(dir, 'machine.json'), 'utf8')).toBe(persisted)
  // The imported bearer file is allowed only until the host acknowledges its key.
  expect(acknowledgeMachineCredentialRotation(dir, machinePublicKeyWire(createMachineCredential(dir)))).toBe(true)
  expect(readdirSync(dir).sort()).toEqual(['machine.json', 'machine.key'])
  expect(readFileSync(join(dir, 'machine.key'), 'utf8')).toBe(key)
})

it('resumes a crash after durable publication and before legacy removal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-state-crash-'))
  roots.push(dir)
  writeFileSync(join(dir, 'machine.id'), 'machine-crash')
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ machineId: 'machine-crash', token: 'keep-me' }))
  failures.unlink = join(dir, 'machine.id')
  expect(() => readOrCreateLocalMachineId(dir)).toThrow('simulated cleanup crash')
  expect(readMachineState(dir)?.machineId).toBe('machine-crash')
  expect(readFileSync(join(dir, 'machine.id'), 'utf8')).toBe('machine-crash')
  failures.unlink = undefined
  expect(readOrCreateLocalMachineId(dir)).toBe('machine-crash')
  expect(readMachineState(dir)?.daemon?.token).toBe('keep-me')
  expect(readdirSync(dir)).toEqual(['machine.json'])
})

it('refuses changed cleanup inputs instead of deleting data written after publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-state-changed-'))
  roots.push(dir)
  writeFileSync(join(dir, 'machine.id'), 'machine-original')
  failures.unlink = join(dir, 'machine.id')
  expect(() => readOrCreateLocalMachineId(dir)).toThrow('simulated cleanup crash')
  failures.unlink = undefined
  writeFileSync(join(dir, 'machine.id'), 'machine-replaced')
  expect(() => readOrCreateLocalMachineId(dir)).toThrow('legacy machine state changed')
  expect(readFileSync(join(dir, 'machine.id'), 'utf8')).toBe('machine-replaced')
  expect(readMachineState(dir)?.machineId).toBe('machine-original')
})

it('resolves disagreeing legacy identities by credential: supervisor, then daemon, then machine.id', () => {
  // ludovico's real state root on 2026-09-18: machine.id and supervisor.json name the
  // server's row, daemon.json a stale row from an earlier pairing. The dev.166 daemon
  // refused this shape at first boot and every updated machine went dark.
  const dir = mkdtempSync(join(tmpdir(), 'podium-state-disagree-'))
  roots.push(dir)
  writeFileSync(join(dir, 'machine.id'), 'host-id')
  writeFileSync(join(dir, 'supervisor.json'), JSON.stringify({ machineId: 'host-id', token: 's' }))
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ machineId: 'stale-daemon-id', token: 'd' }))
  expect(readOrCreateLocalMachineId(dir)).toBe('host-id')
  const state = readMachineState(dir)
  expect(state?.machineId).toBe('host-id')
  expect(state?.daemon).toEqual({ machineId: 'stale-daemon-id', token: 'd' })
  expect(state?.supervisor).toEqual({ machineId: 'host-id', token: 's' })

  // flatblock's real state root: a re-paired legacy daemon with no supervisor keeps a
  // stale machine.id while daemon.json names the live row. The credential wins.
  const dir2 = mkdtempSync(join(tmpdir(), 'podium-state-disagree2-'))
  roots.push(dir2)
  writeFileSync(join(dir2, 'machine.id'), 'stale-machine-id')
  writeFileSync(join(dir2, 'daemon.json'), JSON.stringify({ machineId: 'live-row', token: 't' }))
  expect(readOrCreateLocalMachineId(dir2)).toBe('live-row')
  expect(readMachineState(dir2)?.daemon).toEqual({ machineId: 'live-row', token: 't' })
  expect(readMachineState(dir2)?.legacy).toEqual({ machineId: 'stale-machine-id' })

  // Supervisor alone disagreeing with machine.id: the supervisor's credential identity wins.
  const dir3 = mkdtempSync(join(tmpdir(), 'podium-state-disagree3-'))
  roots.push(dir3)
  writeFileSync(join(dir3, 'machine.id'), 'old-id')
  writeFileSync(join(dir3, 'supervisor.json'), JSON.stringify({ machineId: 'sup-id' }))
  expect(readOrCreateLocalMachineId(dir3)).toBe('sup-id')
})

it('preserves malformed legacy inputs without publishing a replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-state-refusal-'))
  roots.push(dir)
  writeFileSync(join(dir, 'machine.id'), 'host-id')
  writeFileSync(join(dir, 'daemon.json'), '{broken')
  expect(() => readOrCreateLocalMachineId(dir)).toThrow()
  expect(readdirSync(dir).sort()).toEqual(['daemon.json', 'machine.id'])
})

it('a simultaneous cold start publishes one complete identity with no staging files left', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-state-race-'))
  roots.push(dir)
  const modulePath = new URL('./local-machine.ts', import.meta.url).pathname
  const source = `import { readOrCreateLocalMachineId } from ${JSON.stringify(modulePath)}; console.log(readOrCreateLocalMachineId(${JSON.stringify(dir)}))`
  const ids = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn('bun', ['--conditions=@podium/source', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { errors += data })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errors)))
  })))
  expect(new Set(ids).size).toBe(1)
  expect(readMachineState(dir)?.machineId).toBe(ids[0])
  expect(readdirSync(dir)).toEqual(['machine.json'])
}, 15_000)
