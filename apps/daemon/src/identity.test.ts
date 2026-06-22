import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadIdentity, saveToken } from './identity'

describe('daemon identity', () => {
  it('creates a stable uuid machineId on first load and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-id-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'podium-id-'))
    const { machineId } = loadIdentity({ dir })
    saveToken('secret-token', { dir })
    const after = loadIdentity({ dir })
    expect(after.machineId).toBe(machineId) // saveToken must not disturb the id
    expect(after.token).toBe('secret-token')
  })

  it('saveToken before any loadIdentity still preserves a later-generated id (token kept)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-id-'))
    saveToken('t0', { dir })
    const id = loadIdentity({ dir })
    expect(id.token).toBe('t0')
    expect(id.machineId).toMatch(/^[0-9a-f-]{36}$/)
    // The token survives the id-generating write.
    expect(loadIdentity({ dir }).token).toBe('t0')
  })
})
