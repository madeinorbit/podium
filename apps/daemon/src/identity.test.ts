import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadIdentity, savePairingToken, savePinnedUpdatePubkey, saveToken } from './identity'

// POD-518 [spec:SP-0be7]: every mkdtemp in this file is tracked and removed when the file's
// tests finish, so a suite run leaves nothing behind in tmp.
const tmpDirs: string[] = []
function trackTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})


describe('daemon identity', () => {
  it('presents the daemon credential row, never the root id with the daemon token (flatblock shape)', () => {
    // flatblock 2026-09-18: machine.id = 74812716… from an earlier pairing, daemon.json =
    // the live row c2ba4db0… with its token, no supervisor.json. dev.166/167 sent the stale
    // id with the live token and the server refused it.
    const dir = trackTmp('podium-id-flatblock-')
    writeFileSync(join(dir, 'machine.id'), 'stale-machine-id')
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ machineId: 'live-row', token: 'live-token', updatePubkey: 'k' }))
    const identity = loadIdentity({ dir })
    expect(identity).toEqual({ machineId: 'live-row', token: 'live-token', updatePubkey: 'k' })
    saveToken('rotated', { dir })
    expect(loadIdentity({ dir })).toEqual({ machineId: 'live-row', token: 'rotated', updatePubkey: 'k' })
  })

  it('creates a stable uuid machineId on first load and reuses it', () => {
    const dir = trackTmp('podium-id-')
    const first = loadIdentity({ dir })
    expect(first.machineId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.token).toBeUndefined()
    // The file now exists with that id.
    const onDisk = JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8')) as {
      machineId: string
    }
    expect(onDisk.machineId).toBe(first.machineId)
    // A second load returns the same id (stable join key).
    const second = loadIdentity({ dir })
    expect(second.machineId).toBe(first.machineId)
  })

  it('persists a token via saveToken and returns it on the next load', () => {
    const dir = trackTmp('podium-id-')
    const { machineId } = loadIdentity({ dir })
    saveToken('secret-token', { dir })
    const after = loadIdentity({ dir })
    expect(after.machineId).toBe(machineId) // saveToken must not disturb the id
    expect(after.token).toBe('secret-token')
  })

  it('saveToken before any loadIdentity still preserves a later-generated id (token kept)', () => {
    const dir = trackTmp('podium-id-')
    saveToken('t0', { dir })
    const id = loadIdentity({ dir })
    expect(id.token).toBe('t0')
    expect(id.machineId).toMatch(/^[0-9a-f-]{36}$/)
    // The token survives the id-generating write.
    expect(loadIdentity({ dir }).token).toBe('t0')
  })

  it('replaces the update-key pin only through pairing persistence', () => {
    const dir = trackTmp('podium-id-')
    loadIdentity({ dir })

    savePairingToken('token-1', 'server-key-1', { dir })
    expect(loadIdentity({ dir })).toMatchObject({ token: 'token-1', updatePubkey: 'server-key-1' })

    // A token-only write represents a reconnect/legacy caller and preserves the pin.
    saveToken('token-2', { dir })
    expect(loadIdentity({ dir }).updatePubkey).toBe('server-key-1')

    savePairingToken('token-3', 'server-key-2', { dir })
    expect(loadIdentity({ dir })).toMatchObject({ token: 'token-3', updatePubkey: 'server-key-2' })

    // Pairing to a server that cannot publish a key must not retain the old server's key.
    savePairingToken('token-4', undefined, { dir })
    expect(loadIdentity({ dir }).updatePubkey).toBeUndefined()
  })
  it('persists a bootstrap server key without inventing a token', () => {
    const dir = trackTmp('podium-id-')
    loadIdentity({ dir })
    savePinnedUpdatePubkey('server-key-bootstrap', { dir })
    expect(loadIdentity({ dir })).toMatchObject({
      updatePubkey: 'server-key-bootstrap',
    })
    expect(loadIdentity({ dir }).token).toBeUndefined()
  })
})
