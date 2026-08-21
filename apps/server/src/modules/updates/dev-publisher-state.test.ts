import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allocateDevPublishVersion,
  rememberDevArtifact,
} from './dev-bundle'
import {
  readDevPublisherState,
  writeDevPublisherState,
} from './dev-publisher-state'

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
        retainedArtifacts: ['podium-headless-0.1.0-edge.20.dev.5+abc.tar.gz'],
      },
      dir,
    )
    expect(readDevPublisherState(dir)).toEqual({
      base: '0.1.0-edge.20',
      counter: 5,
      retainedArtifacts: ['podium-headless-0.1.0-edge.20.dev.5+abc.tar.gz'],
    })
  })

  it('refuses a corrupt state file rather than rewinding the counter', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'dev-publisher-version.json'), '{not json\n', { mode: 0o600 })
    expect(() => readDevPublisherState(dir)).toThrow(/invalid persisted development publisher state/)
  })

  it('mints monotonically and remembers artifact basenames for the sweep allowlist', () => {
    const dir = tempDir()
    const first = allocateDevPublishVersion({
      stateDir: dir,
      checkoutBase: '0.1.0-edge.20',
      sha: '1111111',
    })
    expect(first.version).toBe('0.1.0-edge.20.dev.1+1111111')
    const referenced = rememberDevArtifact({
      stateDir: dir,
      artifactName: 'podium-headless-0.1.0-edge.20.dev.1+1111111-20260812T182015Z.tar.gz',
    })
    const second = allocateDevPublishVersion({
      stateDir: dir,
      checkoutBase: '0.1.0-edge.18', // older checkout — publisher base wins
      sha: '2222222',
    })
    expect(second.version).toBe('0.1.0-edge.20.dev.2+2222222')
    expect(readDevPublisherState(dir)?.counter).toBe(2)
    expect(referenced[0]).toContain('dev.1+1111111')
    // File on disk is valid JSON after the atomic rename.
    expect(JSON.parse(readFileSync(join(dir, 'dev-publisher-version.json'), 'utf8')).base).toBe(
      '0.1.0-edge.20',
    )
  })
})
