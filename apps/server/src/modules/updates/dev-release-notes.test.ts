import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateTarget } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { type BuiltDevBundle, devTarget, readReleaseNotesAt } from './dev-bundle'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function commit(root: string, changelog: string | undefined, message: string): string {
  if (changelog !== undefined) writeFileSync(join(root, 'CHANGELOG.md'), changelog)
  else writeFileSync(join(root, 'README.md'), message)
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: root })
  return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'podium-dev-notes-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'notes@test.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Notes Test'], { cwd: root })
  return root
}

const changelog = (unreleased: string) =>
  `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [0.2.0] - 2026-10-12\n\n- Shipped.\n`

describe('dev build release notes', () => {
  it('reads the Unreleased section from the build commit, not from the working tree', () => {
    const root = repo()
    const first = commit(root, changelog('- First preview.\n'), 'first')
    const second = commit(root, changelog('- Second preview.\n'), 'second')
    writeFileSync(join(root, 'CHANGELOG.md'), changelog('- Uncommitted.\n'))

    return Promise.all([
      readReleaseNotesAt(root, first, `0.2.0-dev.1+${first}`),
      readReleaseNotesAt(root, second, `0.2.0-dev.2+${second}`),
    ]).then(([atFirst, atSecond]) => {
      expect(atFirst).toEqual({ summary: '- First preview.' })
      expect(atSecond).toEqual({ summary: '- Second preview.' })
    })
  })

  it('publishes without notes when the commit has no changelog or an empty Unreleased', async () => {
    const root = repo()
    const bare = commit(root, undefined, 'no changelog')
    const empty = commit(root, changelog(''), 'empty unreleased')
    expect(await readReleaseNotesAt(root, bare, `0.2.0-dev.1+${bare}`)).toBeUndefined()
    expect(await readReleaseNotesAt(root, empty, `0.2.0-dev.2+${empty}`)).toBeUndefined()
  })

  it('carries the notes in the published target, which still parses as a feed document', () => {
    const built: BuiltDevBundle = {
      buildId: 'b1',
      version: '0.2.0-dev.3+1234567',
      path: '/tmp/bundle.tar.gz',
      size: 1,
      digest: 'sha256:00',
      signature: 'sig',
      artifacts: [],
    }
    const target = devTarget(built, {
      platform: 'linux-x86_64',
      schemaMigrations: ['20260715135845_baseline'],
      notes: { summary: '- Preview.' },
      changes: {
        branch: 'dev/mw',
        commits: [{ sha: '1234567', summary: 'Preview' }],
        commitCount: 201,
      },
    })
    expect(UpdateTarget.parse(target)).toMatchObject({
      notes: { summary: '- Preview.' },
      branch: 'dev/mw',
      commits: [{ sha: '1234567', summary: 'Preview' }],
      commitCount: 201,
    })
    expect('notes' in devTarget(built, { schemaMigrations: ['20260715135845_baseline'] })).toBe(
      false,
    )
  })
})
