import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateDevPublishVersion, rememberDevArtifact } from './dev-bundle'
import { readDevPublisherState, writeDevPublisherState } from './dev-publisher-state'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-publisher-state-'))
  dirs.push(dir)
  return dir
}

describe('dev publisher state', () => {
  it('persists base, counter, and retained artifacts across reads', () => {
    const dir = tempDir()
    writeDevPublisherState(
      {
        base: '0.1.0-edge.20',
        counter: 5,
        retainedArtifacts: ['podium-headless-0.1.0-dev.5+abc.tar.gz'],
        lastPublishedSha: 'abc1234',
      },
      dir,
    )
    expect(readDevPublisherState(dir)).toEqual({
      base: '0.1.0-edge.20',
      counter: 5,
      retainedArtifacts: ['podium-headless-0.1.0-dev.5+abc.tar.gz'],
      lastPublishedSha: 'abc1234',
    })
  })

  it('refuses a corrupt state file rather than rewinding the counter', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'dev-publisher-version.json'), '{not json\n', { mode: 0o600 })
    expect(() => readDevPublisherState(dir)).toThrow(
      /invalid persisted development publisher state/,
    )
  })

  it('refuses a state file whose base cannot be ordered', () => {
    // Well-formed JSON, plausible shape, unusable base: minting on it produces
    // a version with no provable relation to the last one. Rejecting the file
    // is what turns that into "no release available" at the publisher.
    const dir = tempDir()
    writeFileSync(
      join(dir, 'dev-publisher-version.json'),
      `${JSON.stringify({ base: 'garbage-base', counter: 3, retainedArtifacts: [] })}\n`,
      { mode: 0o600 },
    )
    expect(() => readDevPublisherState(dir)).toThrow(
      /invalid persisted development publisher state/,
    )
  })

  it('accepts the bare-stable next-patch lineage a stable cut leaves behind', () => {
    // `0.1.2` after a `0.1.1` cut is a LEGITIMATE stored base, not a corrupt
    // one, and reading it must not renormalise it upward.
    const dir = tempDir()
    writeDevPublisherState({ base: '0.1.2', counter: 2, retainedArtifacts: [] }, dir)
    expect(readDevPublisherState(dir)?.base).toBe('0.1.2')
    expect(
      allocateDevPublishVersion({ stateDir: dir, checkoutBase: '0.1.1', sha: '3333333' }).version,
    ).toBe('0.1.2-dev.3+3333333')
  })

  it('migrates a legacy label instead of reusing it', () => {
    const dir = tempDir()
    writeDevPublisherState(
      {
        base: '0.1.0-edge.20',
        counter: 5,
        retainedArtifacts: [],
        lastSha: 'abc1234',
        lastVersion: '0.1.0-edge.20.dev.5+abc1234',
      },
      dir,
    )
    const allocated = allocateDevPublishVersion({
      stateDir: dir,
      checkoutBase: '0.1.0-edge.20',
      sha: 'abc1234',
    })
    expect(allocated.version).toBe('0.1.0-dev.6+abc1234')
    expect(readDevPublisherState(dir)?.lastVersion).toBe('0.1.0-dev.6+abc1234')
  })

  it('mints monotonically and remembers artifact basenames for the sweep allowlist', () => {
    const dir = tempDir()
    const first = allocateDevPublishVersion({
      stateDir: dir,
      checkoutBase: '0.1.0-edge.20',
      sha: '1111111',
    })
    expect(first.version).toBe('0.1.0-dev.1+1111111')
    const referenced = rememberDevArtifact({
      stateDir: dir,
      // One publish is one artifact PER PLATFORM (POD-2504); the ledger remembers them
      // together so a sweep cannot reclaim part of a build it just published.
      artifactNames: [
        'podium-headless-0.1.0-dev.1+1111111-linux-x86_64-20260812T182015Z.tar.gz',
      ],
    })
    const second = allocateDevPublishVersion({
      stateDir: dir,
      checkoutBase: '0.1.0-edge.18', // older checkout — publisher base wins
      sha: '2222222',
    })
    expect(second.version).toBe('0.1.0-dev.2+2222222')
    expect(readDevPublisherState(dir)?.counter).toBe(2)
    expect(referenced[0]).toContain('dev.1+1111111')
    // File on disk is valid JSON after the atomic rename.
    expect(JSON.parse(readFileSync(join(dir, 'dev-publisher-version.json'), 'utf8')).base).toBe(
      '0.1.0',
    )
  })

  it('keeps the published range anchor and advances across main → old branch → main', () => {
    const dir = tempDir()
    writeDevPublisherState(
      {
        base: '0.1.0-edge.20',
        counter: 4,
        retainedArtifacts: [],
        lastPublishedSha: 'published',
      },
      dir,
    )

    const vintage = allocateDevPublishVersion({
      stateDir: dir,
      checkoutBase: '0.1.0-edge.12',
      sha: 'branch1',
    })
    const main = allocateDevPublishVersion({
      stateDir: dir,
      checkoutBase: '0.1.0-edge.20',
      sha: 'main222',
    })

    expect(compareVersions(vintage.version, '0.1.0-dev.4+published')).toBe(1)
    expect(compareVersions(main.version, vintage.version)).toBe(1)
    expect(readDevPublisherState(dir)?.lastPublishedSha).toBe('published')
  })
})
