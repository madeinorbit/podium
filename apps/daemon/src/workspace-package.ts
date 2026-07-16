import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { WorkspaceManifest, type WorkspaceManifest as WorkspaceManifestType } from '@podium/protocol'
import { buildSnapshotCommit } from './handoff-package'

const runFile = promisify(execFile)
/** Peek worktrees land under a dedicated directory so `workspace clean` can
 *  enumerate and remove exactly what fetch materialized, nothing else. */
export const PEEK_DIR = '.worktrees/.peek'

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runFile('git', args, { cwd })
  return stdout.trim()
}

/** Bases are verified on the FETCHER; `git bundle create ^<sha>` additionally
 *  needs each base present HERE on the source — keep the intersection. */
async function sourceKnownShas(cwd: string, shas: string[]): Promise<string[]> {
  const known: string[] = []
  for (const sha of shas) {
    const ok = await git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).then(
      () => true,
      () => false,
    )
    if (ok) known.push(sha)
  }
  return known
}

/**
 * Snapshot the CURRENT working tree (dirty + untracked, gitignore respected)
 * and stage a thin bundle for transfer. Fully lazy [POD-658]: the snapshot ref
 * is created and deleted inside this call — nothing survives but the staged
 * archive, which the chunk reader deletes at EOF. The worktree and any live
 * session in it are untouched (temp index, no checkout, no kill).
 */
export async function exportWorkspaceSnapshot(input: {
  fetchId: string
  cwd: string
  baseShas: string[]
  repoId: string
  sourceMachineId: string
  homeDir?: string
}): Promise<{ manifest: WorkspaceManifestType; stagePath: string; sizeBytes: number }> {
  const home = input.homeDir ?? homedir()
  const stageDir = join(home, '.podium', 'handoff')
  await mkdir(stageDir, { recursive: true, mode: 0o700 })
  const packageDir = await mkdtemp(join(stageDir, `${input.fetchId}-`))
  const stagePath = join(stageDir, `${input.fetchId}.tgz`)
  // fetchId is unique per request, so the snapshot ref can never collide with a
  // concurrent handoff of the same session.
  const snapshot = await buildSnapshotCommit(input.cwd, input.fetchId)
  try {
    const branch = await git(input.cwd, ['branch', '--show-current'])
    const baseShas = await sourceKnownShas(input.cwd, input.baseShas)
    if (baseShas.length === 0)
      throw new Error('no bundle base shared between source and fetching repositories')
    const manifest = WorkspaceManifest.parse({
      format: 1,
      fetchId: input.fetchId,
      repoId: input.repoId,
      branch,
      headSha: snapshot.headSha,
      snapshotSha: snapshot.snapshotSha,
      worktreeName: basename(input.cwd),
      bundleBase: baseShas,
      sourceMachineId: input.sourceMachineId,
      exportedAt: new Date().toISOString(),
    })
    await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    if (snapshot.snapshotSha || !baseShas.includes(snapshot.headSha)) {
      // Bundles record REFS, not raw shas — for a clean tree with unpushed
      // commits point the (otherwise unused) snapshot ref at HEAD so the tip
      // still ships. The ref is deleted in the finally either way.
      if (!snapshot.snapshotSha)
        await git(input.cwd, ['update-ref', snapshot.handoffRef, snapshot.headSha])
      const revs = [snapshot.handoffRef, ...baseShas.map((sha) => `^${sha}`)]
      await git(input.cwd, ['bundle', 'create', join(packageDir, 'repo.bundle'), ...revs])
    }
    await rm(stagePath, { force: true })
    await runFile('tar', ['-czf', stagePath, '-C', packageDir, '.'])
    return { manifest, stagePath, sizeBytes: (await stat(stagePath)).size }
  } finally {
    await git(input.cwd, ['update-ref', '-d', snapshot.handoffRef]).catch(() => '')
    await rm(packageDir, { recursive: true, force: true })
  }
}

/**
 * Materialize a fetched workspace snapshot as a READ-ONLY peek: a detached
 * worktree under `.worktrees/.peek/` checked out at the snapshot commit (which
 * carries the source's dirty + untracked state as tracked content). Detached on
 * purpose — no branch ref is created or moved, so the fetcher's own branches
 * can never collide with or be clobbered by someone else's state. No refs are
 * left behind: the detached worktree HEAD keeps the commits gc-reachable.
 */
export async function importWorkspaceSnapshot(input: {
  fetchId: string
  repoPath: string
  homeDir?: string
}): Promise<{ manifest: WorkspaceManifestType; path: string }> {
  const home = input.homeDir ?? homedir()
  const archive = join(home, '.podium', 'handoff', `${basename(input.fetchId)}.tgz`)
  const unpacked = await mkdtemp(join(tmpdir(), 'podium-workspace-import-'))
  const incomingRef = `refs/podium/workspace-incoming/${input.fetchId}`
  try {
    await runFile('tar', ['-xzf', archive, '-C', unpacked])
    const manifest = WorkspaceManifest.parse(
      JSON.parse(await readFile(join(unpacked, 'manifest.json'), 'utf8')),
    )
    if (manifest.fetchId !== input.fetchId) throw new Error('package fetch id mismatch')
    const tip = manifest.snapshotSha ?? manifest.headSha
    const bundle = join(unpacked, 'repo.bundle')
    const hasBundle = await stat(bundle).then(
      () => true,
      () => false,
    )
    if (hasBundle) {
      await git(input.repoPath, ['bundle', 'verify', bundle])
      const heads = await git(input.repoPath, ['bundle', 'list-heads', bundle])
      const shipped = heads
        .split('\n')
        .map((line) => line.split(' ')[1])
        .filter(Boolean)
      if (shipped.length > 0)
        await git(input.repoPath, [
          'fetch',
          bundle,
          ...shipped.map((ref) => `+${ref}:${incomingRef}`),
        ])
    }
    const tipKnown = await git(input.repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${tip}^{commit}`,
    ]).then(
      () => true,
      () => false,
    )
    if (!tipKnown) throw new Error('package omitted required git bundle')
    const shortTip = tip.slice(0, 12)
    const path = join(input.repoPath, PEEK_DIR, `${manifest.worktreeName}-${shortTip}`)
    const worktrees = await git(input.repoPath, ['worktree', 'list', '--porcelain'])
    const exists = worktrees
      .split('\n\n')
      .some((block) => block.split('\n').includes(`worktree ${path}`))
    if (!exists) {
      await mkdir(join(input.repoPath, PEEK_DIR), { recursive: true })
      await git(input.repoPath, ['worktree', 'add', '--detach', path, tip])
    }
    return { manifest, path }
  } finally {
    await git(input.repoPath, ['update-ref', '-d', incomingRef]).catch(() => '')
    await rm(archive, { force: true })
    await rm(unpacked, { recursive: true, force: true })
  }
}

/** Remove every peek worktree fetch materialized under this repo. */
export async function cleanWorkspacePeeks(repoPath: string): Promise<string[]> {
  const dir = join(repoPath, PEEK_DIR)
  const entries = await readdir(dir).catch(() => [] as string[])
  const removed: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry)
    await git(repoPath, ['worktree', 'remove', '--force', path]).catch(() => '')
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
    removed.push(path)
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  return removed
}
