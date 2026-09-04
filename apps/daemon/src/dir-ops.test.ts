import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hermeticChildEnv } from '../../../test-hermetic-env'
import { runDirOp, segmentError } from './dir-ops'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'podium-dir-ops-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const options = (
  env: NodeJS.ProcessEnv = hermeticChildEnv(),
): { homePath: string; machine: string; env: NodeJS.ProcessEnv } => ({
  homePath: home,
  machine: 'test-machine',
  env,
})

const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim()

describe('segment validation', () => {
  it('accepts an ordinary folder name', () => {
    expect(segmentError('flight-planner')).toBeNull()
    expect(segmentError('  spaced  ')).toBeNull()
  })

  it('refuses anything that is a PATH rather than a name', () => {
    // The containment story: these are refused as names, before any join, so
    // there is nothing for path normalisation to get subtly wrong.
    expect(segmentError('../etc')).toContain('"/"')
    expect(segmentError('a/b')).toContain('"/"')
    expect(segmentError('..')).toContain('not a folder name')
    expect(segmentError('.')).toContain('not a folder name')
  })

  it('refuses an empty name, a leading dash, and an over-long one', () => {
    expect(segmentError('   ')).toContain('Enter a name')
    // A leading dash must never reach a git argv slot as something that parses
    // as an option.
    expect(segmentError('-rf')).toContain('"-"')
    expect(segmentError('x'.repeat(256))).toContain('too long')
  })
})

describe('createFolder', () => {
  it('creates the folder inside the parent and answers with its path', async () => {
    const result = await runDirOp('createFolder', { parentPath: home, name: 'projects' }, options())
    expect(result.error).toBeUndefined()
    expect(result.path).toBe(join(home, 'projects'))
    expect(existsSync(join(home, 'projects'))).toBe(true)
  })

  it('refuses a name already taken, and leaves what is there alone', async () => {
    mkdirSync(join(home, 'taken'))
    writeFileSync(join(home, 'taken', 'keep.txt'), 'keep me')
    const result = await runDirOp('createFolder', { parentPath: home, name: 'taken' }, options())
    expect(result.error).toContain('already here')
    expect(result.path).toBeUndefined()
    expect(existsSync(join(home, 'taken', 'keep.txt'))).toBe(true)
  })

  it('refuses a traversing name without touching the filesystem', async () => {
    const result = await runDirOp(
      'createFolder',
      { parentPath: join(home, 'inner'), name: '../escaped' },
      options(),
    )
    mkdirSync(join(home, 'inner'))
    expect(result.error).toContain('"/"')
    expect(existsSync(join(home, 'escaped'))).toBe(false)
  })

  it('refuses a parent that is not a directory', async () => {
    writeFileSync(join(home, 'file.txt'), 'x')
    const result = await runDirOp(
      'createFolder',
      { parentPath: join(home, 'file.txt'), name: 'child' },
      options(),
    )
    expect(result.error).toContain('is not a folder')
  })
})

describe('renameFolder', () => {
  it('renames in place', async () => {
    mkdirSync(join(home, 'before'))
    const result = await runDirOp(
      'renameFolder',
      { parentPath: home, currentName: 'before', name: 'after' },
      options(),
    )
    expect(result.path).toBe(join(home, 'after'))
    expect(existsSync(join(home, 'after'))).toBe(true)
    expect(existsSync(join(home, 'before'))).toBe(false)
  })

  it('refuses when the new name is taken, and does not merge the two', async () => {
    mkdirSync(join(home, 'a'))
    mkdirSync(join(home, 'b'))
    writeFileSync(join(home, 'b', 'theirs.txt'), 'theirs')
    const result = await runDirOp(
      'renameFolder',
      { parentPath: home, currentName: 'a', name: 'b' },
      options(),
    )
    expect(result.error).toContain('already here')
    expect(existsSync(join(home, 'a'))).toBe(true)
    expect(existsSync(join(home, 'b', 'theirs.txt'))).toBe(true)
  })

  it('is a no-op when the name did not change', async () => {
    mkdirSync(join(home, 'same'))
    const result = await runDirOp(
      'renameFolder',
      { parentPath: home, currentName: 'same', name: 'same' },
      options(),
    )
    expect(result.error).toBeUndefined()
    expect(result.path).toBe(join(home, 'same'))
  })

  it('reports a source that is not there', async () => {
    const result = await runDirOp(
      'renameFolder',
      { parentPath: home, currentName: 'ghost', name: 'other' },
      options(),
    )
    expect(result.error).toContain('Could not open')
  })
})

/**
 * THE POINT OF THE WHOLE FEATURE, and the two ways it silently fails.
 *
 * Both tests below run against a git with NO identity and NO global config —
 * which is the state of the machine this feature exists for — by pointing
 * git's config lookups at nothing for the duration.
 */
describe('createRepo', () => {
  let gitEnv: NodeJS.ProcessEnv
  beforeAll(() => {
    // Use explicit child state: the worker's process.env is not a child boundary under Bun.
    gitEnv = hermeticChildEnv({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    })
  })

  it('leaves a repository that can already take a worktree', async () => {
    const result = await runDirOp(
      'createRepo',
      { parentPath: home, name: 'planner' },
      options(gitEnv),
    )
    expect(result.error).toBeUndefined()
    const repo = result.path as string

    // The seed commit is what makes the next line possible. Without it HEAD is
    // unborn, `git worktree add -b` fails, and onboarding hands the user a repo
    // that breaks on their first task — which is exactly the bug this asserts
    // against, so it is checked by DOING the thing rather than by reading a log.
    expect(git(repo, gitEnv, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(git(repo, gitEnv, 'rev-list', '--count', 'HEAD')).toBe('1')
    git(repo, gitEnv, 'worktree', 'add', '-b', 'issue/1-x', join(home, 'wt'))
    expect(existsSync(join(home, 'wt', 'README.md'))).toBe(true)
  })

  it('uses the supplied environment for git config', async () => {
    const gitConfig = join(home, 'gitconfig')
    writeFileSync(gitConfig, '[user]\n  name = Configured User\n  email = configured@example.com\n')
    const env = hermeticChildEnv({
      ...gitEnv,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: '/dev/null',
    })
    const result = await runDirOp(
      'createRepo',
      { parentPath: home, name: 'configured' },
      options(env),
    )
    expect(result.error).toBeUndefined()
    expect(git(result.path as string, env, 'log', '-1', '--format=%an <%ae>')).toBe(
      'Configured User <configured@example.com>',
    )
  })

  it('names the README after the folder', async () => {
    const result = await runDirOp(
      'createRepo',
      { parentPath: home, name: 'weather-tiles' },
      options(gitEnv),
    )
    const repo = result.path as string
    expect(git(repo, gitEnv, 'show', '--name-only', '--format=', 'HEAD')).toBe('README.md')
    expect(git(repo, gitEnv, 'show', 'HEAD:README.md')).toBe('# weather-tiles')
  })

  it('refuses the name before creating anything when it is not a name', async () => {
    const result = await runDirOp('createRepo', { parentPath: home, name: 'a/b' }, options(gitEnv))
    expect(result.error).toContain('"/"')
    expect(result.path).toBeUndefined()
  })

  /**
   * THE POSITIVE CONTROL for the two tests above: with no identity fallback the
   * seed commit is exactly what fails, so this proves the environment above
   * really is identity-less and the passes are not vacuous.
   */
  it('would fail to commit here without the identity fallback', () => {
    const bare = join(home, 'bare')
    mkdirSync(bare)
    git(bare, gitEnv, 'init', '-b', 'main')
    writeFileSync(join(bare, 'README.md'), '# bare\n')
    git(bare, gitEnv, 'add', '-A')
    expect(() => git(bare, gitEnv, 'commit', '-m', 'Initial commit')).toThrow()
  })
})
