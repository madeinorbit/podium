import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withDevBuildSnapshot } from './dev-build-snapshot'

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
