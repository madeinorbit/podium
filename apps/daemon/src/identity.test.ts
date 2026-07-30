import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadIdentity, saveToken } from './identity'

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
  it('creates a stable uuid machineId on first load and reuses it', () => {
    const dir = trackTmp('podium-id-')
    const first = loadIdentity({ dir })
    expect(first.machineId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.token).toBeUndefined()
    // The file now exists with that id.
    const onDisk = JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8')) as {
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
})
