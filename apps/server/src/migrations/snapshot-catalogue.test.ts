/**
 * The catalogue is the cheap half of POD-3068: everything a request path is
 * allowed to know about a recovery snapshot without opening it. These tests pin
 * the two properties that make that safe — a record is only usable while the
 * file still has the identity it was proved under, and retention never drops
 * the record that is currently serving as the fallback.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readSnapshotCatalogue,
  retainSnapshotRecords,
  type SnapshotIdentity,
  type SnapshotRecord,
  sameSnapshotIdentity,
  snapshotCataloguePath,
  snapshotIdentity,
  upsertSnapshotRecord,
  verificationCandidates,
  verifiedFallback,
  writeSnapshotCatalogue,
} from './snapshot-catalogue'

const tempDirs: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-snapshot-catalogue-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function record(overrides: Partial<SnapshotRecord> & { path: string }): SnapshotRecord {
  return {
    size: 10,
    mtimeMs: 1,
    sidecars: '-wal:missing',
    outcome: 'verified',
    correlationId: 'corr',
    recordedAtMs: 1,
    ...overrides,
  }
}

describe('snapshot catalogue publication', () => {
  it('round-trips records through an atomically published file', () => {
    const dir = tmpDir()
    const dbPath = join(dir, 'podium.db')
    const row = record({ path: join(dir, 'podium.db.backup-va') })

    writeSnapshotCatalogue(dbPath, [row])

    expect(snapshotCataloguePath(dbPath)).toBe(`${dbPath}.snapshots.json`)
    expect(readSnapshotCatalogue(dbPath)).toEqual([row])
  })

  it('treats a missing, unparsable or foreign-version file as "nothing is known"', () => {
    const dir = tmpDir()
    const dbPath = join(dir, 'podium.db')

    expect(readSnapshotCatalogue(dbPath)).toEqual([])

    writeFileSync(snapshotCataloguePath(dbPath), 'not json at all')
    expect(readSnapshotCatalogue(dbPath)).toEqual([])

    writeFileSync(snapshotCataloguePath(dbPath), JSON.stringify({ version: 99, records: [{}] }))
    expect(readSnapshotCatalogue(dbPath)).toEqual([])
  })

  it('survives a restart: a published verified record is read back and used', () => {
    const dir = tmpDir()
    const dbPath = join(dir, 'podium.db')
    const snapshot = join(dir, 'podium.db.backup-vupdate')
    writeFileSync(snapshot, 'sqlite bytes')
    const identity = snapshotIdentity(snapshot) as SnapshotIdentity

    writeSnapshotCatalogue(dbPath, [record({ ...identity, outcome: 'verified' })])

    // A fresh process reads only the file — no in-memory state carried over.
    expect(verifiedFallback(readSnapshotCatalogue(dbPath))?.path).toBe(snapshot)
  })
})

describe('identity invalidation', () => {
  it('stops advertising a verified record once its file changes', () => {
    const dir = tmpDir()
    const snapshot = join(dir, 'podium.db.backup-va')
    writeFileSync(snapshot, 'original bytes')
    const identity = snapshotIdentity(snapshot) as SnapshotIdentity
    const records = [record({ ...identity, outcome: 'verified' })]

    expect(verifiedFallback(records)?.path).toBe(snapshot)

    writeFileSync(snapshot, 'rewritten bytes of a different length')
    expect(verifiedFallback(records)).toBeUndefined()
    // ...and the changed file becomes the thing worth verifying again.
    expect(verificationCandidates(records).map((row) => row.path)).toEqual([snapshot])
  })

  it('counts a sidecar appearing or vanishing as a different candidate', () => {
    const dir = tmpDir()
    const snapshot = join(dir, 'podium.db.backup-va')
    writeFileSync(snapshot, 'bytes')
    const before = snapshotIdentity(snapshot) as SnapshotIdentity

    writeFileSync(`${snapshot}-wal`, 'wal bytes')
    const after = snapshotIdentity(snapshot) as SnapshotIdentity

    expect(sameSnapshotIdentity(before, after)).toBe(false)
    expect(verifiedFallback([record({ ...before, outcome: 'verified' })])).toBeUndefined()
  })

  it('never advertises a pending, invalid or failed record', () => {
    const dir = tmpDir()
    const snapshot = join(dir, 'podium.db.backup-va')
    writeFileSync(snapshot, 'bytes')
    const identity = snapshotIdentity(snapshot) as SnapshotIdentity

    for (const outcome of ['pending', 'invalid', 'failed'] as const) {
      expect(verifiedFallback([record({ ...identity, outcome })])).toBeUndefined()
    }
  })

  it('offers a pending record for verification but not a decided, unchanged one', () => {
    const dir = tmpDir()
    const pending = join(dir, 'podium.db.backup-vpending')
    const invalid = join(dir, 'podium.db.backup-vinvalid')
    writeFileSync(pending, 'bytes')
    writeFileSync(invalid, 'bytes')
    const records = [
      record({ ...(snapshotIdentity(pending) as SnapshotIdentity), outcome: 'pending' }),
      record({ ...(snapshotIdentity(invalid) as SnapshotIdentity), outcome: 'invalid' }),
    ]

    expect(verificationCandidates(records).map((row) => row.path)).toEqual([pending])
  })

  it('skips a record whose file is gone rather than queueing a doomed verification', () => {
    const dir = tmpDir()
    const missing = join(dir, 'podium.db.backup-vgone')

    expect(verificationCandidates([record({ path: missing, outcome: 'pending' })])).toEqual([])
  })
})

describe('finite retention', () => {
  it('keeps the newest records and never drops the active fallback', () => {
    const rows = [1, 2, 3, 4, 5].map((n) =>
      record({ path: `/state/podium.db.backup-v${n}`, recordedAtMs: n }),
    )

    const kept = retainSnapshotRecords(rows, 3, '/state/podium.db.backup-v1')

    expect(kept.map((row) => row.path)).toEqual([
      '/state/podium.db.backup-v5',
      '/state/podium.db.backup-v4',
      '/state/podium.db.backup-v3',
      // The oldest survives ONLY because it is the proof currently in use.
      '/state/podium.db.backup-v1',
    ])
  })

  it('drops the oldest once it is no longer the active fallback', () => {
    const rows = [1, 2, 3, 4].map((n) =>
      record({ path: `/state/podium.db.backup-v${n}`, recordedAtMs: n }),
    )

    expect(retainSnapshotRecords(rows, 3, undefined).map((row) => row.path)).toEqual([
      '/state/podium.db.backup-v4',
      '/state/podium.db.backup-v3',
      '/state/podium.db.backup-v2',
    ])
  })

  it('replaces the record for a path rather than accumulating one per verification', () => {
    const first = record({ path: '/state/a', outcome: 'pending', recordedAtMs: 1 })
    const second = record({ path: '/state/a', outcome: 'verified', recordedAtMs: 2 })

    const next = upsertSnapshotRecord([first], second)

    expect(next).toHaveLength(1)
    expect(next[0]?.outcome).toBe('verified')
  })
})
