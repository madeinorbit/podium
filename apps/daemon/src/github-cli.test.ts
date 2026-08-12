import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { githubCliClone, githubCliList, githubCliStatus, type GitHubExec } from './github-cli'

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
      return {
        stdout: JSON.stringify([
          {
            nameWithOwner: 'octocat/hello-world',
            description: 'Hello',
            isPrivate: true,
            url: 'https://github.com/octocat/hello-world',
            pushedAt: '2026-08-12T12:00:00.000Z',
          },
        ]),
        stderr: '',
      }
    })

    const result = await githubCliList(exec)
    expect(result.status).toEqual({ state: 'ready', login: 'octocat' })
    expect(result.repositories?.[0]?.nameWithOwner).toBe('octocat/hello-world')
    expect(JSON.stringify(result)).not.toMatch(/token|oauth/iu)
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
