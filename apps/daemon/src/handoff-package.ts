import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  claudeProjectSlug,
  locateClaudeSessionFile,
  resolvePinnedCodexRollout,
} from '@podium/agent-bridge'
import { HandoffManifest, type HandoffManifest as HandoffManifestType } from '@podium/protocol'

const runFile = promisify(execFile)
const HANDOFF_REF_ROOT = 'refs/podium/handoff'

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await runFile('git', args, { cwd, env: { ...process.env, ...env } })
  return stdout.trim()
}

export async function buildSnapshotCommit(
  cwd: string,
  sessionId: string,
): Promise<{
  headSha: string
  snapshotSha: string | null
  handoffRef: string
}> {
  const scratch = await mkdtemp(join(tmpdir(), 'podium-handoff-index-'))
  const env = { GIT_INDEX_FILE: join(scratch, 'index') }
  const handoffRef = `${HANDOFF_REF_ROOT}/${sessionId}`
  try {
    const headSha = await git(cwd, ['rev-parse', 'HEAD'])
    await git(cwd, ['read-tree', 'HEAD'], env)
    await git(cwd, ['add', '-A'], env)
    const tree = await git(cwd, ['write-tree'], env)
    const headTree = await git(cwd, ['rev-parse', 'HEAD^{tree}'])
    if (tree === headTree) return { headSha, snapshotSha: null, handoffRef }
    const snapshotSha = await git(
      cwd,
      ['commit-tree', tree, '-p', headSha, '-m', `Podium handoff snapshot ${sessionId}`],
      env,
    )
    await git(cwd, ['update-ref', handoffRef, snapshotSha])
    return { headSha, snapshotSha, handoffRef }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export function codexTranscriptPlacement(
  home: string,
  relativeDir: string | undefined,
  filename: string,
): string {
  const safeDir = (relativeDir ?? '').split(/[\\/]+/u).filter((part) => part && part !== '..')
  return join(home, '.codex', 'sessions', ...safeDir, basename(filename))
}

export function transcriptPlacement(
  manifest: HandoffManifestType,
  newCwd: string,
  home: string,
): string {
  return manifest.agentKind === 'claude-code'
    ? join(home, '.claude', 'projects', claudeProjectSlug(newCwd), `${manifest.resume.value}.jsonl`)
    : codexTranscriptPlacement(home, manifest.transcriptRelativeDir, manifest.transcriptFilename)
}

async function transcriptForExport(input: {
  agentKind: 'claude-code' | 'codex'
  cwd: string
  resumeValue: string
  home: string
}): Promise<{ path: string; relativeDir?: string }> {
  if (input.agentKind === 'claude-code') {
    const path = await locateClaudeSessionFile({
      cwd: input.cwd,
      resumeValue: input.resumeValue,
      homeDir: input.home,
    })
    if (!path) throw new Error('Claude transcript not found')
    return { path }
  }
  const found = await resolvePinnedCodexRollout(input.resumeValue, input.home)
  if (!found) throw new Error('Codex transcript not found')
  const rel = relative(join(input.home, '.codex', 'sessions'), dirname(found.path))
  if (rel.startsWith('..')) throw new Error('Codex transcript is outside the sessions root')
  return { path: found.path, ...(rel ? { relativeDir: rel } : {}) }
}

export async function exportHandoffPackage(input: {
  sessionId: string
  cwd: string
  agentKind: 'claude-code' | 'codex'
  resume: HandoffManifestType['resume']
  branch: string
  baseShas: string[]
  repoId: string
  title?: string
  issueId?: string
  sourceMachineId: string
  homeDir?: string
}): Promise<{ manifest: HandoffManifestType; stagePath: string; sizeBytes: number }> {
  const home = input.homeDir ?? homedir()
  const stageDir = join(home, '.podium', 'handoff')
  await mkdir(stageDir, { recursive: true, mode: 0o700 })
  const packageDir = await mkdtemp(join(stageDir, `${input.sessionId}-`))
  const stagePath = join(stageDir, `${input.sessionId}.tgz`)
  const snapshot = await buildSnapshotCommit(input.cwd, input.sessionId)
  try {
    const actualBranch = await git(input.cwd, ['branch', '--show-current'])
    if (!actualBranch) throw new Error('detached HEAD cannot be handed off')
    const transcript = await transcriptForExport({
      agentKind: input.agentKind,
      cwd: input.cwd,
      resumeValue: input.resume.value,
      home,
    })
    const manifest = HandoffManifest.parse({
      format: 1,
      sessionId: input.sessionId,
      agentKind: input.agentKind,
      resume: input.resume,
      transcriptFilename: basename(transcript.path),
      ...(transcript.relativeDir ? { transcriptRelativeDir: transcript.relativeDir } : {}),
      repoId: input.repoId,
      branch: actualBranch,
      headSha: snapshot.headSha,
      snapshotSha: snapshot.snapshotSha,
      snapshotFlattened: true,
      worktreeName: basename(input.cwd),
      bundleBase: input.baseShas,
      ...(input.title ? { title: input.title } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      sourceMachineId: input.sourceMachineId,
      exportedAt: new Date().toISOString(),
    })
    await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await copyFile(transcript.path, join(packageDir, 'transcript.jsonl'))
    if (snapshot.snapshotSha || !input.baseShas.includes(snapshot.headSha)) {
      const revs = [
        actualBranch,
        ...(snapshot.snapshotSha ? [snapshot.handoffRef] : []),
        ...input.baseShas.map((sha) => `^${sha}`),
      ]
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

function stagePathFor(home: string, sessionId: string): string {
  return join(home, '.podium', 'handoff', `${basename(sessionId)}.tgz`)
}

export async function appendImportChunk(input: {
  homeDir?: string
  sessionId: string
  offset: number
  data: Buffer
}): Promise<number> {
  const path = stagePathFor(input.homeDir ?? homedir(), input.sessionId)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, input.offset === 0 ? 'w' : 'r+')
  try {
    await handle.write(input.data, 0, input.data.length, input.offset)
    return (await handle.stat()).size
  } finally {
    await handle.close()
  }
}

export async function readExportChunk(input: {
  homeDir?: string
  stagePath: string
  offset: number
  length: number
}): Promise<{ data: Buffer; sizeBytes: number; eof: boolean }> {
  const root = resolve(input.homeDir ?? homedir(), '.podium', 'handoff')
  const path = resolve(input.stagePath)
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('denied')
  const handle = await open(path, 'r')
  let result: { data: Buffer; sizeBytes: number; eof: boolean }
  try {
    const sizeBytes = (await handle.stat()).size
    const data = Buffer.alloc(Math.min(input.length, Math.max(0, sizeBytes - input.offset)))
    const { bytesRead } = await handle.read(data, 0, data.length, input.offset)
    result = {
      data: data.subarray(0, bytesRead),
      sizeBytes,
      eof: input.offset + bytesRead >= sizeBytes,
    }
  } finally {
    await handle.close()
  }
  if (result.eof) await rm(path, { force: true })
  return result
}

export async function importHandoffPackage(input: {
  homeDir?: string
  sessionId: string
  repoPath: string
  worktreeName: string
}): Promise<{ manifest: HandoffManifestType; newCwd: string }> {
  const home = input.homeDir ?? homedir()
  const archive = stagePathFor(home, input.sessionId)
  const unpacked = await mkdtemp(join(tmpdir(), 'podium-handoff-import-'))
  const newCwd = join(input.repoPath, '.worktrees', basename(input.worktreeName))
  try {
    await runFile('tar', ['-xzf', archive, '-C', unpacked])
    const manifest = HandoffManifest.parse(
      JSON.parse(await readFile(join(unpacked, 'manifest.json'), 'utf8')),
    )
    if (manifest.sessionId !== input.sessionId) throw new Error('package session id mismatch')
    const bundle = join(unpacked, 'repo.bundle')
    let hasBundle = true
    try {
      await stat(bundle)
    } catch {
      hasBundle = false
    }
    if (hasBundle) {
      await git(input.repoPath, ['bundle', 'verify', bundle])
      const refs = [`+refs/heads/${manifest.branch}:refs/heads/${manifest.branch}`]
      if (manifest.snapshotSha)
        refs.push(
          `${HANDOFF_REF_ROOT}/${manifest.sessionId}:${HANDOFF_REF_ROOT}/${manifest.sessionId}`,
        )
      await git(input.repoPath, ['fetch', bundle, ...refs])
    } else if (
      manifest.snapshotSha ||
      !(
        await git(input.repoPath, ['rev-parse', '--verify', `${manifest.headSha}^{commit}`])
      ).includes(manifest.headSha)
    ) {
      throw new Error('package omitted required git bundle')
    }
    await mkdir(dirname(newCwd), { recursive: true })
    await git(input.repoPath, ['worktree', 'add', newCwd, manifest.branch])
    if (manifest.snapshotSha)
      await git(newCwd, [
        'restore',
        `--source=${HANDOFF_REF_ROOT}/${manifest.sessionId}`,
        '--worktree',
        '--',
        '.',
      ])
    const transcriptTarget = transcriptPlacement(manifest, newCwd, home)
    await mkdir(dirname(transcriptTarget), { recursive: true, mode: 0o700 })
    await copyFile(join(unpacked, 'transcript.jsonl'), transcriptTarget)
    await git(input.repoPath, [
      'update-ref',
      '-d',
      `${HANDOFF_REF_ROOT}/${manifest.sessionId}`,
    ]).catch(() => '')
    await rm(archive, { force: true })
    return { manifest, newCwd }
  } catch (error) {
    await git(input.repoPath, ['worktree', 'remove', '--force', newCwd]).catch(() => '')
    await rm(newCwd, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await rm(unpacked, { recursive: true, force: true })
  }
}
