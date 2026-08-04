import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearPendingGrant, readPendingGrant, writePendingGrant } from './pending-grant'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-grant-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const grant = {
  grantId: 'g1',
  targetVersion: '0.4.2',
  previousVersion: '0.4.1',
  attempts: 1,
  startedAt: 1_000,
}

describe('pending grant marker', () => {
  it('is null when there is none', () => {
    expect(readPendingGrant(dir)).toBeNull()
  })

  it('round-trips', () => {
    writePendingGrant(dir, grant)
    expect(readPendingGrant(dir)).toEqual(grant)
  })

  it('clears', () => {
    writePendingGrant(dir, grant)
    clearPendingGrant(dir)
    expect(readPendingGrant(dir)).toBeNull()
  })

  it('reads a corrupt marker as absent rather than throwing', () => {
    writeFileSync(join(dir, 'pending-update.json'), '{ not json')
    expect(readPendingGrant(dir)).toBeNull()
  })

  it('reads a marker missing required fields as absent', () => {
    writeFileSync(join(dir, 'pending-update.json'), JSON.stringify({ grantId: 'g1' }))
    expect(readPendingGrant(dir)).toBeNull()
  })
})
