import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
  },
  build: (snapshotRoot: string) => Promise<T>,
): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), 'podium-dev-release-'))
  const snapshotRoot = join(parent, 'checkout')
  let attached = false
  let failed = false
  try {
    await git(input.sourceRoot, [
      'worktree',
      'add',
      '--detach',
      '--force',
      snapshotRoot,
      input.approvedSha,
    ])
    attached = true
    await assertSnapshotIdentity(snapshotRoot, input.approvedSha)
    if (input.install) {
      await input.install(snapshotRoot)
    } else {
      await execFileAsync(
        devBuildCommand(process.env),
        ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'],
        { cwd: snapshotRoot, env: { ...process.env } },
      )
    }
    const result = await build(snapshotRoot)
    await assertSnapshotIdentity(snapshotRoot, input.approvedSha)
    return result
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (attached) {
      try {
        await git(input.sourceRoot, ['worktree', 'remove', '--force', snapshotRoot])
      } catch (error) {
        await rm(snapshotRoot, { recursive: true, force: true })
        await git(input.sourceRoot, ['worktree', 'prune']).catch(() => {})
        if (!failed) throw error
      }
    }
    await rm(parent, { recursive: true, force: true })
  }
}
