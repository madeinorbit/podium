import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  timeReleaseBuildTask,
  type ReleaseBuildTimingDeps,
} from '@podium/runtime/release-build-timing'
import { devBuildCommand } from './build-scope'

const execFileAsync = promisify(execFile)

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  })
  return stdout
}

function shortSha(raw: string): string {
  return raw.trim().slice(0, 7)
}

async function assertSnapshotIdentity(root: string, approvedSha: string): Promise<void> {
  const [head, changed] = await Promise.all([
    git(root, ['rev-parse', '--short=7', 'HEAD']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=no']),
  ])
  if (shortSha(head) !== shortSha(approvedSha)) {
    throw new Error(
      `approved source snapshot moved from ${shortSha(approvedSha)} to ${shortSha(head)}; refusing to publish`,
    )
  }
  if (changed.trim().length > 0) {
    throw new Error(
      `approved source snapshot ${shortSha(approvedSha)} changed while building; refusing to publish:\n${changed.trim()}`,
    )
  }
}

export type BunInstall = (snapshotRoot: string, args: readonly string[]) => Promise<void>

const runBunInstall: BunInstall = async (snapshotRoot, args) => {
  await execFileAsync(devBuildCommand(process.env), [...args], {
    cwd: snapshotRoot,
    env: { ...process.env },
  })
}

function isOfflineCacheMiss(error: unknown): boolean {
  const text = [
    error instanceof Error ? error.message : String(error),
    (error as { stderr?: unknown } | null)?.stderr,
  ]
    .filter((part) => typeof part === 'string')
    .join('\n')
  return /--offline: .* is not in the cache/.test(text)
}

/**
 * Install the snapshot's dependencies from the lockfile.
 *
 * The offline install is the fast path: it links straight from the global bun
 * cache. A lockfile bump the build host has never installed (a new expo set,
 * say) is not in that cache yet, and the offline install refuses outright. Only
 * then does it fetch: still `--frozen-lockfile`, so every package is pinned to
 * the lockfile's integrity hash, and the fetch fills the cache for next time.
 */
export async function installSnapshotDependencies(
  snapshotRoot: string,
  install: BunInstall = runBunInstall,
): Promise<void> {
  try {
    await install(snapshotRoot, ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'])
  } catch (error) {
    if (!isOfflineCacheMiss(error)) throw error
    await install(snapshotRoot, ['install', '--frozen-lockfile', '--ignore-scripts'])
  }
}

export type DevBuildSnapshot = <T>(
  approvedSha: string,
  build: (snapshotRoot: string) => Promise<T>,
) => Promise<T>

/**
 * Run a release build in a detached worktree fixed at the approved commit.
 *
 * The live checkout can move while this runs without changing a single build
 * input. A final tracked-tree check catches a build tool (or test adversary)
 * that edits its own snapshot before any result becomes publishable.
 */
export async function withDevBuildSnapshot<T>(
  input: {
    sourceRoot: string
    approvedSha: string
    install?: (snapshotRoot: string) => Promise<void>
    releaseVersion?: string
    timing?: ReleaseBuildTimingDeps
  },
  build: (snapshotRoot: string) => Promise<T>,
): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), 'podium-dev-release-'))
  const snapshotRoot = join(parent, 'checkout')
  let attached = false
  let failed = false
  const timed = async <T>(phase: string, task: string, run: () => Promise<T> | T): Promise<T> =>
    await timeReleaseBuildTask(
      {
        phase,
        task,
        channel: 'dev',
        ...(input.releaseVersion ? { version: input.releaseVersion } : {}),
        sourceSha: input.approvedSha,
      },
      run,
      input.timing,
    )
  try {
    await timed('checkout', 'detached-worktree', async () =>
      await git(input.sourceRoot, [
        'worktree',
        'add',
        '--detach',
        '--force',
        snapshotRoot,
        input.approvedSha,
      ]),
    )
    attached = true
    await timed('validation', 'initial-source-identity', async () =>
      await assertSnapshotIdentity(snapshotRoot, input.approvedSha),
    )
    await timed('dependency-preparation', 'bun-install', async () => {
      await (input.install ?? installSnapshotDependencies)(snapshotRoot)
    })
    const result = await build(snapshotRoot)
    await timed('validation', 'final-source-identity', async () =>
      await assertSnapshotIdentity(snapshotRoot, input.approvedSha),
    )
    return result
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (attached) {
      try {
        await timed('checkout', 'remove-detached-worktree', async () =>
          await git(input.sourceRoot, ['worktree', 'remove', '--force', snapshotRoot]),
        )
      } catch (error) {
        await rm(snapshotRoot, { recursive: true, force: true })
        await git(input.sourceRoot, ['worktree', 'prune']).catch(() => {})
        if (!failed) throw error
      }
    }
    // The worktree removal above is timed; the temp PARENT it lived in is a separate
    // recursive delete, and an untimed one made the envelope look larger than its phases.
    await timed('checkout', 'snapshot-teardown', async () => await rm(parent, { recursive: true, force: true }))
  }
}
