import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  advanceOutcome,
  type BuildRecord,
  buildBundlesDir,
  buildRecordArtifactsPresent,
  buildRecordDir,
  listBuildRecords,
  listUnrecordedBuildDirs,
  mintBuildId,
  prepareBuildRecordDir,
  readBuildRecord,
  releaseTimingStagingDir,
  selectBuildRecordSweep,
  sweepBuildRecords,
  writeBuildRecord,
} from './build-record'

const state = (): string => mkdtempSync(join(tmpdir(), 'podium-ledger-'))

const record = (id: string, overrides: Partial<BuildRecord> = {}): BuildRecord => ({
  recordVersion: 1,
  buildId: id,
  approvedSha: 'dc0a8cf',
  version: '0.1.1-dev.15+dc0a8cf',
  platforms: ['linux-x86_64'],
  client: {
    rootDigest: 'a'.repeat(64),
    sourceCommit: 'dc0a8cf',
    version: '0.1.1-dev.15+dc0a8cf',
    tasks: {
      '@podium/web#build': { hash: 'h1', cache: 'HIT' },
      '@podium/mobile#build': { hash: 'h2', cache: 'MISS' },
    },
  },
  artifacts: [
    {
      platform: 'linux-x86_64',
      file: `podium-headless-0.1.1-linux-x86_64-${id}.tar.gz`,
      size: 12,
      digest: 'b'.repeat(64),
      signature: 'sig',
    },
  ],
  signingKeyFingerprint: 'fp',
  startedAt: '2026-08-28T13:15:00.000Z',
  outcome: 'signed',
  outcomeAt: '2026-08-28T13:15:30.000Z',
  ...overrides,
})

/** Write a record together with the bytes it names, the way a real build leaves them. */
const publishInto = (dir: string, entry: BuildRecord): BuildRecord => {
  prepareBuildRecordDir(dir, entry.buildId)
  for (const artifact of entry.artifacts) {
    writeFileSync(join(buildBundlesDir(dir, entry.buildId), artifact.file), 'tarball')
  }
  writeBuildRecord(dir, entry)
  return entry
}

describe('build ids', () => {
  it('names when and of what', () => {
    expect(mintBuildId('20260828T131500Z', 'dc0a8cf')).toBe('20260828T131500Z-dc0a8cf')
  })

  it('refuses an id that cannot name both', () => {
    expect(() => mintBuildId('', 'dc0a8cf')).toThrow(/stamp and a commit/)
  })
})

describe('writing and reading a record', () => {
  it('round-trips and leaves no partial file behind', () => {
    const dir = state()
    writeBuildRecord(dir, record('20260828T131500Z-dc0a8cf'))
    expect(readBuildRecord(dir, '20260828T131500Z-dc0a8cf')).toEqual(
      record('20260828T131500Z-dc0a8cf'),
    )
    expect(
      readdirSync(buildRecordDir(dir, '20260828T131500Z-dc0a8cf')).some((n) => n.includes('.tmp')),
    ).toBe(false)
  })

  it('reads nothing for a record that does not name its own directory', () => {
    const dir = state()
    mkdirSync(buildRecordDir(dir, 'b-1'), { recursive: true })
    writeFileSync(
      join(buildRecordDir(dir, 'b-1'), 'manifest.json'),
      JSON.stringify(record('somewhere-else')),
    )
    expect(readBuildRecord(dir, 'b-1')).toBeNull()
  })

  it('reads nothing for an unreadable or future record', () => {
    const dir = state()
    mkdirSync(buildRecordDir(dir, 'b-2'), { recursive: true })
    writeFileSync(join(buildRecordDir(dir, 'b-2'), 'manifest.json'), '{ not json')
    mkdirSync(buildRecordDir(dir, 'b-3'), { recursive: true })
    writeFileSync(
      join(buildRecordDir(dir, 'b-3'), 'manifest.json'),
      JSON.stringify({ ...record('b-3'), recordVersion: 2 }),
    )
    expect(readBuildRecord(dir, 'b-2')).toBeNull()
    expect(readBuildRecord(dir, 'b-3')).toBeNull()
    expect(listBuildRecords(dir)).toEqual([])
  })

  it('lists newest first', () => {
    const dir = state()
    writeBuildRecord(dir, record('20260828T130000Z-aaaaaaa'))
    writeBuildRecord(dir, record('20260828T131500Z-bbbbbbb'))
    expect(listBuildRecords(dir).map((r) => r.buildId)).toEqual([
      '20260828T131500Z-bbbbbbb',
      '20260828T130000Z-aaaaaaa',
    ])
  })

  it('separates a build in flight from a build that stated an outcome', () => {
    const dir = state()
    prepareBuildRecordDir(dir, 'in-flight')
    writeBuildRecord(dir, record('recorded'))
    expect(listBuildRecords(dir).map((r) => r.buildId)).toEqual(['recorded'])
    expect(listUnrecordedBuildDirs(dir)).toEqual(['in-flight'])
  })
})

describe('outcomes only advance', () => {
  it('walks validated → signed → published', () => {
    const dir = state()
    writeBuildRecord(dir, record('x-1', { outcome: 'validated' }))
    expect(advanceOutcome(dir, 'x-1', 'signed').outcome).toBe('signed')
    const published = advanceOutcome(dir, 'x-1', 'published')
    expect(published.outcome).toBe('published')
    expect(published.outcomeAt).not.toBe(record('x-1').outcomeAt)
  })

  it('refuses to walk a publish back', () => {
    const dir = state()
    writeBuildRecord(dir, record('x-1', { outcome: 'published' }))
    expect(() => advanceOutcome(dir, 'x-1', 'signed')).toThrow(
      /cannot move build x-1 from published back to signed/,
    )
    expect(() => writeBuildRecord(dir, record('x-1', { outcome: 'signed' }))).toThrow(
      /cannot move build x-1 from published back to signed/,
    )
  })

  it('lets a live outcome fail, and keeps a failure terminal', () => {
    const dir = state()
    writeBuildRecord(dir, record('x-2', { outcome: 'signed' }))
    expect(advanceOutcome(dir, 'x-2', 'failed:publish').outcome).toBe('failed:publish')
    expect(() => advanceOutcome(dir, 'x-2', 'signed')).toThrow(/is terminal/)
    expect(() => advanceOutcome(dir, 'x-2', 'failed:publish')).not.toThrow()
  })

  it('refuses to advance a record that does not exist', () => {
    expect(() => advanceOutcome(state(), 'nope', 'published')).toThrow(/no build record nope/)
  })
})

describe('retention counts records', () => {
  it('keeps the newest N and dooms the rest', () => {
    const records = ['b4', 'b3', 'b2', 'b1'].map((id) => record(id))
    expect(selectBuildRecordSweep(records, { retain: 2 })).toEqual(['b2', 'b1'])
  })

  it('never dooms a referenced build, however old', () => {
    const records = ['b4', 'b3', 'b2', 'b1'].map((id) => record(id))
    expect(selectBuildRecordSweep(records, { retain: 2, referenced: ['b1'] })).toEqual(['b2'])
  })

  it('does not let failed attempts age out the last release that worked', () => {
    const records = [
      record('f3', { outcome: 'failed:verify' }),
      record('f2', { outcome: 'failed:sign' }),
      record('f1', { outcome: 'failed:verify' }),
      record('good2'),
      record('good1', { outcome: 'published' }),
    ]
    const doomed = selectBuildRecordSweep(records, { retain: 2 })
    expect(doomed).toEqual(['f1'])
    expect(doomed).not.toContain('good1')
    expect(doomed).not.toContain('good2')
  })
})

describe('a sweep never deletes an artifact a kept release still names', () => {
  it('leaves the referenced build whole while reclaiming the rest', () => {
    const dir = state()
    const kept = publishInto(dir, record('20260828T100000Z-aaaaaaa', { outcome: 'published' }))
    for (const id of [
      '20260828T110000Z-bbbbbbb',
      '20260828T120000Z-ccccccc',
      '20260828T130000Z-ddddddd',
    ]) {
      publishInto(dir, record(id))
    }
    const keptArtifact = join(
      buildBundlesDir(dir, kept.buildId),
      (kept.artifacts[0] as { file: string }).file,
    )
    expect(existsSync(keptArtifact)).toBe(true)

    const removed = sweepBuildRecords(dir, { retain: 2, referenced: [kept.buildId] })

    // The oldest record is the one a stamp-ordered sweep would have taken first. It is
    // the one the fleet is still being served, and its bytes are still here.
    expect(removed).toEqual(['20260828T110000Z-bbbbbbb'])
    expect(existsSync(keptArtifact)).toBe(true)
    expect(buildRecordArtifactsPresent(dir, kept)).toBe(true)
    expect(readBuildRecord(dir, kept.buildId)?.outcome).toBe('published')
    expect(existsSync(buildRecordDir(dir, '20260828T110000Z-bbbbbbb'))).toBe(false)
  })

  it('protects the build being written right now', () => {
    const dir = state()
    for (const id of ['b1', 'b2', 'b3']) publishInto(dir, record(id))
    // retain 1 keeps b3 and dooms b2 and b1; b1 is the directory being written.
    expect(sweepBuildRecords(dir, { retain: 1, protect: ['b1'] })).toEqual(['b2'])
    expect(existsSync(buildRecordDir(dir, 'b1'))).toBe(true)
    expect(sweepBuildRecords(dir, { retain: 1 })).toEqual(['b1'])
  })

  it('reclaims a record-less directory only once it is past the grace window', () => {
    const dir = state()
    prepareBuildRecordDir(dir, 'crashed')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(buildRecordDir(dir, 'crashed'), old, old)

    expect(sweepBuildRecords(dir, { retain: 2, unrecordedGraceMs: 4 * 60 * 60 * 1000 })).toEqual([])
    expect(existsSync(buildRecordDir(dir, 'crashed'))).toBe(true)

    expect(sweepBuildRecords(dir, { retain: 2 })).toEqual(['crashed'])
    expect(existsSync(buildRecordDir(dir, 'crashed'))).toBe(false)
  })

  it("never touches the ledger's own staging directory", () => {
    const dir = state()
    mkdirSync(releaseTimingStagingDir(dir), { recursive: true })
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(releaseTimingStagingDir(dir), old, old)
    writeFileSync(join(releaseTimingStagingDir(dir), '0.1.0-dev.1+abc.jsonl'), '{}\n')

    // Old, record-less, and squarely inside `builds/` — every signal a sweep uses to
    // decide a directory is abandoned. It is the sink a release in flight is appending
    // to, and deleting it would lose that release's timing under it.
    expect(sweepBuildRecords(dir, { retain: 2 })).toEqual([])
    expect(listBuildRecords(dir)).toEqual([])
    expect(listUnrecordedBuildDirs(dir)).toEqual([])
    expect(existsSync(releaseTimingStagingDir(dir))).toBe(true)
  })

  it('is a no-op on a state directory that has never built', () => {
    expect(sweepBuildRecords(state(), { retain: 2 })).toEqual([])
    expect(listBuildRecords(state())).toEqual([])
  })
})
