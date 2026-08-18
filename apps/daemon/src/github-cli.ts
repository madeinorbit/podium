import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import {
  type GitHubCliResultMessage,
  type GitHubCliStatusWire,
  GitHubRepositoryWire,
} from '@podium/protocol'

const execFileAsync = promisify(execFile)

type Result = Omit<GitHubCliResultMessage, 'type' | 'requestId'>
export type GitHubExec = (
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>

const liveExec: GitHubExec = async (args, options = {}) => {
  const { stdout, stderr } = await execFileAsync('gh', args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  })
  return { stdout, stderr }
}

const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Probe the host's existing `gh` login without reading or returning a token. */
export async function githubCliStatus(exec: GitHubExec = liveExec): Promise<GitHubCliStatusWire> {
  try {
    await exec(['auth', 'status', '--hostname', 'github.com'])
  } catch (error) {
    return isMissing(error) ? { state: 'missing' } : { state: 'logged-out' }
  }
  try {
    const { stdout } = await exec(['api', 'user', '--jq', '.login'])
    const login = stdout.trim()
    return login ? { state: 'ready', login } : { state: 'ready' }
  } catch {
    // Auth status is authoritative. Identity is presentation-only and may fail
    // on a restricted enterprise account without making cloning unavailable.
    return { state: 'ready' }
  }
}

/**
 * One repository per line, because `--paginate` runs the `--jq` filter once per
 * PAGE. `--slurp` would join the pages into one array first, but it is the one
 * flag that cannot be relied on: `gh` older than 2.44 has never heard of it, and
 * the versions after that refused it in the same command as `--jq` — either way
 * the whole listing fails on a perfectly good CLI (POD-1323). `@json` makes each
 * repository a string, which `gh` prints raw, so a description containing a
 * newline still arrives on a single line.
 */
export function parseGitHubRepositoryLines(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

export async function githubCliList(exec: GitHubExec = liveExec): Promise<Result> {
  const status = await githubCliStatus(exec)
  if (status.state !== 'ready') return { status }
  try {
    const { stdout } = await exec([
      'api',
      'user/repos',
      '--method',
      'GET',
      '--paginate',
      '-f',
      'per_page=100',
      '-f',
      'sort=pushed',
      '-f',
      'affiliation=owner,collaborator,organization_member',
      '--jq',
      '.[] | {nameWithOwner: .full_name, description, isPrivate: .private, url: .html_url, pushedAt: .pushed_at} | @json',
    ])
    const repositories = GitHubRepositoryWire.array().parse(parseGitHubRepositoryLines(stdout))
    return { status, repositories }
  } catch (error) {
    return { status, error: `Could not list GitHub repositories: ${errorText(error)}` }
  }
}

export async function githubCliClone(
  repository: string | undefined,
  destination: string | undefined,
  exec: GitHubExec = liveExec,
): Promise<Result> {
  const status = await githubCliStatus(exec)
  if (status.state !== 'ready') return { status }
  if (!repository || !repositoryName.test(repository)) {
    return { status, error: 'Choose a GitHub repository to clone.' }
  }
  if (!destination || !isAbsolute(destination)) {
    return { status, error: 'Clone destination must be an absolute path.' }
  }
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await exec(['repo', 'clone', repository, destination], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { status, path: destination }
  } catch (error) {
    return { status, error: `Could not clone ${repository}: ${errorText(error)}` }
  }
}
