import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { commitShaFromDevVersion, type ReleaseProposalCommit } from '@podium/protocol'

const execFileAsync = promisify(execFile)
const MIGRATIONS_TREE = 'apps/server/src/migrations/drizzle'

export interface ReleaseProposalFacts {
  branch: string
  commits: ReleaseProposalCommit[]
  addedMigrations: string[]
}

export interface ReleaseProposalGit {
  (args: readonly string[]): Promise<string>
}

function gitAt(root: string): ReleaseProposalGit {
  return async (args) => {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env },
    })
    return stdout
  }
}

function parseCommits(raw: string): ReleaseProposalCommit[] {
  const fields = raw.split('\0')
  const commits: ReleaseProposalCommit[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const sha = fields[index]?.trim()
    if (!sha) continue
    commits.push({ sha: sha.slice(0, 7), summary: fields[index + 1] ?? '' })
  }
  return commits
}

function migrationNames(raw: string): string[] {
  const names = raw
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => {
      const relative = path.startsWith(`${MIGRATIONS_TREE}/`)
        ? path.slice(MIGRATIONS_TREE.length + 1)
        : path
      return relative.split('/')[0] ?? basename(path)
    })
  return [...new Set(names)]
}

async function resolveBaselineSha(
  input: { runningSha?: string; runningVersion?: string; sinceSha?: string },
  run: ReleaseProposalGit,
): Promise<string> {
  if (input.runningSha) return input.runningSha
  if (input.runningVersion) {
    const embeddedSha = commitShaFromDevVersion(input.runningVersion)
    if (embeddedSha) return embeddedSha
    for (const ref of [`v${input.runningVersion}`, input.runningVersion]) {
      try {
        const candidate = (await run(['rev-parse', '--verify', `${ref}^{commit}`])).trim()
        if (candidate) return candidate
      } catch {
        // A checkout may carry a version without the corresponding tag. Try
        // the unprefixed spelling before failing closed below.
      }
    }
    throw new Error(`could not resolve the running release ${input.runningVersion} to a commit`)
  }
  if (input.sinceSha) return input.sinceSha
  throw new Error('could not determine the running release baseline for the proposal')
}

/**
 * Read the human-facing facts for HEAD relative to this server's RUNNING commit.
 *
 * A proposal is recomputed from HEAD on every read, so rapid commits collapse
 * naturally. Endpoint comparison (not ancestry) makes branch hops first-class:
 * an older-based branch still shows the commits and migrations it adds.
 */
export async function releaseProposalFacts(input: {
  root: string
  headSha: string
  /** Commit currently running on this server, when it is known directly. */
  runningSha?: string
  /** Product version currently running on this server, resolved to a commit when needed. */
  runningVersion?: string
  /** Last published commit, retained as provenance and a compatibility fallback. */
  sinceSha?: string
  git?: ReleaseProposalGit
}): Promise<ReleaseProposalFacts> {
  const run = input.git ?? gitAt(input.root)
  const rangeBase = await resolveBaselineSha(input, run)
  const range = `${rangeBase}..${input.headSha}`
  const [branchRaw, commitsRaw, migrationsRaw] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['log', '-z', '--format=%H%x00%s', range]),
    run([
      'diff',
      '--diff-filter=A',
      '--name-only',
      '-z',
      rangeBase,
      input.headSha,
      '--',
      MIGRATIONS_TREE,
    ]),
  ])
  return {
    branch:
      branchRaw.trim() === 'HEAD' || branchRaw.trim() === ''
        ? `detached@${input.headSha.slice(0, 7)}`
        : branchRaw.trim(),
    commits: parseCommits(commitsRaw),
    addedMigrations: migrationNames(migrationsRaw),
  }
}
