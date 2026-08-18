import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type GitHubExec, githubCliClone, githubCliList, githubCliStatus } from './github-cli'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GitHub CLI intake adapter', () => {
  it('distinguishes a missing CLI from a logged-out CLI', async () => {
    const missing: GitHubExec = vi.fn(async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    })
    const loggedOut: GitHubExec = vi.fn(async () => {
      throw new Error('not logged into any GitHub hosts')
    })

    expect(await githubCliStatus(missing)).toEqual({ state: 'missing' })
    expect(await githubCliStatus(loggedOut)).toEqual({ state: 'logged-out' })
  })

  it('lists accessible repositories without reading or returning a token', async () => {
    const exec: GitHubExec = vi.fn(async (args) => {
      if (args[0] === 'auth') return { stdout: '', stderr: '' }
      if (args.includes('user')) return { stdout: 'octocat\n', stderr: '' }
      // One page per line, exactly as `gh api --paginate --jq '… | @json'` prints it.
      return {
        stdout: `${[
          {
            nameWithOwner: 'octocat/hello-world',
            description: 'Hello',
            isPrivate: true,
            url: 'https://github.com/octocat/hello-world',
            pushedAt: '2026-08-12T12:00:00.000Z',
          },
          {
            nameWithOwner: 'octocat/spoon-knife',
            description: null,
            isPrivate: false,
            url: 'https://github.com/octocat/spoon-knife',
            pushedAt: '2026-08-11T12:00:00.000Z',
          },
        ]
          .map((repository) => JSON.stringify(repository))
          .join('\n')}\n`,
        stderr: '',
      }
    })

    const result = await githubCliList(exec)
    expect(result.status).toEqual({ state: 'ready', login: 'octocat' })
    expect(result.repositories?.map((repository) => repository.nameWithOwner)).toEqual([
      'octocat/hello-world',
      'octocat/spoon-knife',
    ])
    expect(JSON.stringify(result)).not.toMatch(/token|oauth/iu)
  })

  // `--slurp` is unknown to gh before 2.44 and refused alongside `--jq` after it,
  // so the listing that reached people simply failed (POD-1323).
  it('lists without the one flag older GitHub CLIs reject', async () => {
    const listArgs: string[][] = []
    const exec: GitHubExec = vi.fn(async (args) => {
      if (args[0] === 'auth') return { stdout: '', stderr: '' }
      if (args.includes('user')) return { stdout: 'octocat\n', stderr: '' }
      listArgs.push(args)
      return { stdout: '', stderr: '' }
    })

    const result = await githubCliList(exec)
    expect(result.error).toBeUndefined()
    expect(result.repositories).toEqual([])
    expect(listArgs).toHaveLength(1)
    expect(listArgs[0]).not.toContain('--slurp')
    expect(listArgs[0]).toContain('--paginate')
  })

  it('reports a refusing GitHub CLI instead of an empty repository list', async () => {
    const exec: GitHubExec = vi.fn(async (args) => {
      if (args[0] === 'auth') return { stdout: '', stderr: '' }
      if (args.includes('user')) return { stdout: 'octocat\n', stderr: '' }
      throw new Error('unknown flag: --slurp')
    })

    const result = await githubCliList(exec)
    expect(result.repositories).toBeUndefined()
    expect(result.error).toMatch(/Could not list GitHub repositories/u)
  })

  it('clones with fixed argv and terminal prompting disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-gh-intake-'))
    roots.push(root)
    const destination = join(root, 'repos', 'hello-world')
    const exec: GitHubExec = vi.fn(async (args) => {
      if (args[0] === 'auth' || args.includes('user')) {
        return { stdout: args.includes('user') ? 'octocat\n' : '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await githubCliClone('octocat/hello-world', destination, exec)

    expect(result.path).toBe(destination)
    expect(exec).toHaveBeenLastCalledWith(
      ['repo', 'clone', 'octocat/hello-world', destination],
      expect.objectContaining({ env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }) }),
    )
  })
})
