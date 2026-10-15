import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReleaseBuildTimingRecord } from '@podium/runtime/release-build-timing'
import { afterEach, describe, expect, it } from 'vitest'
import { installSnapshotDependencies, withDevBuildSnapshot } from './dev-build-snapshot'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function repository(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'podium-snapshot-test-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'snapshot@test.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Snapshot Test'], { cwd: root })
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'release.ts'), 'export const release = "approved"\n')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', 'approved'], { cwd: root })
  const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  return { root, sha }
}

describe('approved development build snapshot', () => {
  it('keeps live-checkout changes out of the approved build inputs', async () => {
    const { root, sha } = repository()
    await expect(
      withDevBuildSnapshot(
        { sourceRoot: root, approvedSha: sha, install: async () => {} },
        async (snapshotRoot) => {
          writeFileSync(join(root, 'src', 'release.ts'), 'export const release = "new HEAD"\n')
          return readFileSync(join(snapshotRoot, 'src', 'release.ts'), 'utf8')
        },
      ),
    ).resolves.toContain('approved')
  })

  it('refuses the build result when tracked source bytes change inside the snapshot', async () => {
    const { root, sha } = repository()
    await expect(
      withDevBuildSnapshot(
        { sourceRoot: root, approvedSha: sha, install: async () => {} },
        async (snapshotRoot) => {
          writeFileSync(
            join(snapshotRoot, 'src', 'release.ts'),
            'export const release = "mutated during platform compile"\n',
          )
          return 'would-be-published bytes'
        },
      ),
    ).rejects.toThrow(/snapshot .* changed while building; refusing to publish/i)
  })
})
describe('approved development build timing evidence', () => {
  it('measures the real checkout, validation, and install commands', async () => {
    const { root, sha } = repository()
    const records: ReleaseBuildTimingRecord[] = []
    let tick = 0

    await withDevBuildSnapshot(
      {
        sourceRoot: root,
        approvedSha: sha,
        releaseVersion: `0.1.0-dev.1+${sha}`,
        install: async () => {},
        timing: {
          enabled: true,
          now: () => ++tick,
          emit: (record) => records.push(record),
        },
      },
      async () => 'built',
    )

    expect(
      records
        .filter((record) => record.granularity === 'task')
        .map((record) => [record.phase, record.task, record.outcome]),
    ).toEqual([
      ['checkout', 'detached-worktree', 'success'],
      ['validation', 'initial-source-identity', 'success'],
      ['dependency-preparation', 'bun-install', 'success'],
      ['validation', 'final-source-identity', 'success'],
      ['checkout', 'remove-detached-worktree', 'success'],
      ['checkout', 'snapshot-teardown', 'success'],
    ])
  })

  it('records failed preparation and still records checkout cleanup', async () => {
    const { root, sha } = repository()
    const records: ReleaseBuildTimingRecord[] = []
    let tick = 0

    await expect(
      withDevBuildSnapshot(
        {
          sourceRoot: root,
          approvedSha: sha,
          install: async () => {
            throw new Error('offline install failed')
          },
          timing: {
            enabled: true,
            now: () => ++tick,
            emit: (record) => records.push(record),
          },
        },
        async () => 'must not build',
      ),
    ).rejects.toThrow('offline install failed')

    const tasks = records.filter((record) => record.granularity === 'task')
    expect(tasks).toContainEqual(
      expect.objectContaining({
        phase: 'dependency-preparation',
        task: 'bun-install',
        outcome: 'failure',
      }),
    )
    expect(tasks.map((record) => record.task)).toContain('remove-detached-worktree')
    // The temp parent's delete closes the phase record set, so nothing between the
    // worktree removal and the last byte leaving disk is unattributed.
    expect(tasks.at(-1)).toEqual(
      expect.objectContaining({
        phase: 'checkout',
        task: 'snapshot-teardown',
        outcome: 'success',
      }),
    )
  })
})

describe('approved development build dependency install', () => {
  const offline = ['install', '--frozen-lockfile', '--offline', '--ignore-scripts']
  const fetching = ['install', '--frozen-lockfile', '--ignore-scripts']

  it('installs from the cache alone when the cache holds the lockfile', async () => {
    const calls: string[][] = []
    await installSnapshotDependencies('/snapshot', async (_root, args) => {
      calls.push([...args])
    })
    expect(calls).toEqual([offline])
  })

  it('fetches the lockfile packages the cache has never seen', async () => {
    const calls: string[][] = []
    await installSnapshotDependencies('/snapshot', async (_root, args) => {
      calls.push([...args])
      if (args.includes('--offline')) {
        throw Object.assign(new Error('Command failed: bun install --frozen-lockfile --offline'), {
          stderr: 'error: --offline: "expo" is not in the cache\n',
        })
      }
    })
    expect(calls).toEqual([offline, fetching])
  })

  it('does not retry an install that failed for any other reason', async () => {
    const calls: string[][] = []
    await expect(
      installSnapshotDependencies('/snapshot', async (_root, args) => {
        calls.push([...args])
        throw Object.assign(new Error('Command failed: bun install'), {
          stderr: 'error: lockfile had changes, but lockfile is frozen\n',
        })
      }),
    ).rejects.toThrow(/Command failed/)
    expect(calls).toEqual([offline])
  })
})
