import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearPendingGrant,
  finalizePendingGrant,
  readPendingGrant,
  writePendingGrant,
} from './pending-grant'

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

  it('owns and creates a missing runtime directory before publishing', () => {
    const runtimeDir = join(dir, 'state', 'runtime')
    expect(existsSync(runtimeDir)).toBe(false)

    writePendingGrant(runtimeDir, grant)

    expect(readPendingGrant(runtimeDir)).toEqual(grant)
    expect(existsSync(join(runtimeDir, 'pending-update.json.tmp'))).toBe(false)
  })

  it('finalizes only the target the complete parent gate proved', () => {
    writePendingGrant(dir, grant)

    expect(finalizePendingGrant(dir, '0.4.3')).toBe(false)
    expect(readPendingGrant(dir)).toEqual(grant)

    expect(finalizePendingGrant(dir, grant.targetVersion)).toBe(true)
    expect(readPendingGrant(dir)).toBeNull()
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

/**
 * A TORN MARKER IS A SILENTLY LOST UPDATE (POD-2099).
 *
 * `writePendingGrant` runs in the last moments of the daemon's life — the grant
 * runner writes it and then exits on purpose. If the process dies mid-write the
 * old implementation left a half document at the real path; it parses as null,
 * boot reconciliation skips, and a failed update is reported as nothing having
 * happened, with the rollback target gone.
 *
 * A crash is modelled as a writer that lays down some bytes and then never
 * returns. That is exactly the filesystem state a killed process leaves — some
 * prefix on disk, nothing after it — and it is deterministic, so this needs no
 * timing, no sleep and no real signal.
 */
describe('a write interrupted by the exit that follows it', () => {
  const target = () => join(dir, 'pending-update.json')

  /** Dies after `bytes` bytes, at whatever path the implementation gave it. */
  const diesAfter = (bytes: number) => (path: string, data: string) => {
    writeFileSync(path, data.slice(0, bytes))
    throw new Error('process died mid-write')
  }

  /** The PRE-POD-2099 implementation, kept here as the oracle: the property
   *  below has to be able to fail, and this is what failing looks like. */
  const writeDirect = (writeBytes: (path: string, data: string) => void, g: typeof grant) =>
    writeBytes(target(), JSON.stringify(g))

  const later = { ...grant, grantId: 'g2', targetVersion: '0.4.3', previousVersion: '0.4.2' }

  it('leaves the previous marker readable, with its rollback target intact', () => {
    writePendingGrant(dir, grant)
    expect(() => writePendingGrant(dir, later, diesAfter(12))).toThrow()

    expect(readPendingGrant(dir)).toEqual(grant)
  })

  it('is the failure the direct write had — same crash, marker destroyed', () => {
    writePendingGrant(dir, grant)
    expect(() => writeDirect(diesAfter(12), later)).toThrow()

    // Not "the old grant" and not even "absent" in the honest sense: the file
    // is THERE and unparseable, which is how boot reconciliation came to skip.
    expect(readFileSync(target(), 'utf8')).toBe(JSON.stringify(later).slice(0, 12))
    expect(readPendingGrant(dir)).toBeNull()
  })

  it('leaves no marker at all when the first write ever is the one that dies', () => {
    // Nothing to preserve here — the point is that the debris is not mistaken
    // for a marker, so the daemon boots as a daemon with no pending grant.
    expect(() => writePendingGrant(dir, grant, diesAfter(12))).toThrow()
    expect(readPendingGrant(dir)).toBeNull()
    expect(existsSync(target())).toBe(false)
  })

  it('publishes through a staging file and leaves none behind on success', () => {
    const written: string[] = []
    writePendingGrant(dir, grant, (path, data) => {
      written.push(path)
      writeFileSync(path, data)
    })
    // The bytes are never laid down at the path a reader opens; the rename is.
    expect(written).toEqual([join(dir, 'pending-update.json.tmp')])
    expect(existsSync(join(dir, 'pending-update.json.tmp'))).toBe(false)
    expect(readPendingGrant(dir)).toEqual(grant)
  })

  it('clears the staging debris along with the marker', () => {
    expect(() => writePendingGrant(dir, grant, diesAfter(12))).toThrow()
    clearPendingGrant(dir)
    expect(existsSync(join(dir, 'pending-update.json.tmp'))).toBe(false)
  })
})
