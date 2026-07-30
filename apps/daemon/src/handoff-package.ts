import { execFile } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { claudeProjectSlug, locateClaudeSessionFile, resolvePinnedCodexRollout } from '@podium/harness'
import type { Attribution, SessionId } from '@podium/model'
import { HandoffManifest, HandoffManifest as HandoffManifestType } from '@podium/model'
import { gitWorktree } from './worktree-resolve'

const runFile = promisify(execFile)
const HANDOFF_REF_ROOT = 'refs/podium/handoff'

/** Bundle file formats this reader can interpret, newest last. Widening this
 *  list is the same act as adding an arm to `HandoffManifest` — it is here only
 *  so the refusal below can NAME what it supports. */
const READABLE_BUNDLE_FORMATS = [1, 2] as const

/**
 * What a bundle header says, read uniformly across file formats — **the one
 * place in the daemon that knows a manifest has versions** (POD-1153).
 *
 * The v1 -> v2 lift lives HERE, in the read path, and the shape of this type is
 * the whole reason it is not just `HandoffManifest`:
 *
 *   - `exportedAt` normalises v1's flat key and v2's `exported.at` to one
 *     reading, so a caller never spells the export time two ways.
 *   - `attribution` is `null` FOR A V1 BUNDLE, and that null is load-bearing. A
 *     v1 file never recorded a principal, so there is nothing to lift; the
 *     tempting move — synthesizing an actor so every bundle looks uniform —
 *     would write invented provenance into the one record whose entire job is to
 *     say who really did this (ADR 9 D5 A3, and ADR 9 D8 S5 forbids defaulting
 *     the on-behalf-of half to an operator or an owner). "Not recorded" and
 *     "recorded as nobody" are different facts and this keeps them apart.
 *   - `claimedOwner` is named for what it is. **It is PROVENANCE and it is NEVER
 *     an authorization input.** A bundle is payload from a machine outside this
 *     trust domain, so ADR 3 D7 is absolute: the import path decides ownership
 *     and visibility from its OWN authenticated transport principal, and a file
 *     claiming an owner confers nothing — not ownership, not visibility, not a
 *     right. A field called `owner` in scope at an import site invites exactly
 *     the wrong reading, so the name carries the warning that a comment alone
 *     would not.
 */
export interface HandoffBundleHeader {
  manifest: HandoffManifestType
  /** The export timestamp, wherever this format keeps it. */
  exportedAt: string
  /** WHO exported it, inseparably from WHEN — or `null` for a v1 bundle, which
   *  never carried a principal. Never synthesized. */
  attribution: { at: string; by: Attribution } | null
  /** PROVENANCE ONLY — see the type's docs. Never an authorization input. */
  claimedOwner: string | null
}

/**
 * Parse a bundle manifest of any readable format into one reading.
 *
 * Fails CLOSED on anything it cannot interpret, including a format newer than
 * this reader: guessing at an unknown version is how a reader silently drops a
 * key it did not know was load-bearing. The refusal names the format so an
 * operator can tell "your Podium is older than this bundle" from "this bundle is
 * corrupt", which are the same empty failure otherwise.
 */
export function readHandoffManifest(raw: unknown): HandoffBundleHeader {
  const parsed = HandoffManifest.safeParse(raw)
  if (!parsed.success) {
    const format = (raw as { format?: unknown } | null)?.format
    if (typeof format === 'number' && !READABLE_BUNDLE_FORMATS.includes(format as 1 | 2))
      throw new Error(
        `handoff bundle format ${format} is not readable by this Podium (supports ${READABLE_BUNDLE_FORMATS.join(', ')})`,
      )
    throw new Error(`unreadable handoff manifest: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  }
  const manifest = parsed.data
  if (manifest.format === 2)
    return {
      manifest,
      exportedAt: manifest.exported.at,
      attribution: manifest.exported,
      claimedOwner: manifest.owner,
    }
  return {
    manifest,
    exportedAt: manifest.exportedAt,
    // v1 recorded neither, and this reader does not invent either.
    attribution: null,
    claimedOwner: null,
  }
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await runFile('git', args, { cwd, env: { ...process.env, ...env } })
  return stdout.trim()
}

/** The root of the LINKED worktree containing `cwd`, or null (main checkout, or
 *  not a repo). POD-657 and POD-665 each built this classification independently
 *  and hit the same trap — `git rev-parse` echoes an unknown flag and exits 0, so
 *  a shifted parse reads every main checkout as a worktree, failing OPEN on the
 *  one rule [spec:SP-3f7a] forbids. Collapsed here onto `gitWorktree`, the single
 *  hardened primitive, as both branches' commit bodies agreed. */
async function linkedWorktreeRoot(cwd: string): Promise<string | null> {
  const info = await gitWorktree(cwd)
  return info?.kind === 'worktree' ? info.root : null
}

/**
 * The worktree this export moves, and where the agent sits inside it.
 *
 * Two layers ([spec:SP-3f7a]), mirroring the client's `handoffSource` gate but
 * decided here against git truth: the worktree CONTAINING the session's cwd, or
 * — when that cwd has drifted off any worktree — the attached issue's worktree,
 * which is still the session's home. Neither may be a main checkout.
 */
export async function resolveExportSource(
  cwd: string,
  fallbackCwd?: string,
): Promise<{ worktreeRoot: string; subpath: string }> {
  const contained = await linkedWorktreeRoot(cwd)
  if (contained) {
    const subpath = relative(contained, cwd)
    return { worktreeRoot: contained, subpath: subpath.startsWith('..') ? '' : subpath }
  }
  const anchored = fallbackCwd ? await linkedWorktreeRoot(fallbackCwd) : null
  if (anchored) return { worktreeRoot: anchored, subpath: '' }
  throw new Error('only worktree sessions can be handed off')
}

/** The subdir to resume in on the target: the same place inside the worktree the
 *  agent was working, when the imported tree actually has it. A branch that never
 *  created that directory must not fail the whole handoff — land at the root. */
async function landingCwd(worktreeRoot: string, subpath?: string): Promise<string> {
  const parts = (subpath ?? '')
    .split(/[\\/]+/u)
    .filter((part) => part && part !== '.' && part !== '..')
  if (parts.length === 0) return worktreeRoot
  const target = join(worktreeRoot, ...parts)
  const exists = await stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  )
  return exists ? target : worktreeRoot
}

export async function buildSnapshotCommit(
  cwd: string,
  /**
   * NOT AN ID — a git snapshot REF NAME, and renamed to say so (POD-362).
   *
   * It was `sessionId: string`, but its two callers pass different things: the
   * handoff path passes a session id, the workspace-fetch path passes a
   * `ws-<uuid>` fetch id. Both are only ever interpolated into a ref, so neither
   * is wrong — what was wrong was the NAME claiming an id space. Branding it
   * would have laundered the fetch id; widening it to a union would have implied
   * the ref cares which one it got. It does not.
   */
  snapshotTag: string,
): Promise<{
  headSha: string
  snapshotSha: string | null
  treeSha: string
  handoffRef: string
}> {
  const scratch = await mkdtemp(join(tmpdir(), 'podium-handoff-index-'))
  const env = { GIT_INDEX_FILE: join(scratch, 'index') }
  const handoffRef = `${HANDOFF_REF_ROOT}/${snapshotTag}`
  try {
    const headSha = await git(cwd, ['rev-parse', 'HEAD'])
    await git(cwd, ['read-tree', 'HEAD'], env)
    await git(cwd, ['add', '-A'], env)
    const tree = await git(cwd, ['write-tree'], env)
    const headTree = await git(cwd, ['rev-parse', 'HEAD^{tree}'])
    if (tree === headTree) return { headSha, snapshotSha: null, treeSha: tree, handoffRef }
    const snapshotSha = await git(
      cwd,
      ['commit-tree', tree, '-p', headSha, '-m', `Podium handoff snapshot ${snapshotTag}`],
      env,
    )
    await git(cwd, ['update-ref', handoffRef, snapshotSha])
    return { headSha, snapshotSha, treeSha: tree, handoffRef }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Preserve an in-repository worktree's location across machines. Worktrees
 * outside the primary checkout cannot be mapped safely, so old-package placement
 * under `.worktrees/` remains their fallback [spec:SP-3f7a]. */
function repositoryRelativeWorktreePath(
  repoRoot: string,
  worktreeRoot: string,
): string | undefined {
  const path = relative(repoRoot, worktreeRoot)
  if (!path || path === '..' || path.startsWith(`..${sep}`)) return undefined
  return path.split(sep).join('/')
}

function importedWorktreeRoot(
  repoPath: string,
  manifest: HandoffManifestType,
  fallbackName: string,
): string {
  const parts = manifest.worktreeRelativePath?.split('/')
  return parts?.length
    ? join(repoPath, ...parts)
    : join(repoPath, '.worktrees', basename(fallbackName))
}

interface RegisteredWorktree {
  path: string
  branch?: string
}

function registeredWorktrees(porcelain: string): RegisteredWorktree[] {
  return porcelain
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n')
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      const branch = lines
        .find((line) => line.startsWith('branch refs/heads/'))
        ?.slice('branch refs/heads/'.length)
      return path ? { path, ...(branch ? { branch } : {}) } : null
    })
    .filter((entry): entry is RegisteredWorktree => entry !== null)
}

function worktreeContains(root: string, cwd: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCwd = resolve(cwd)
  return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}${sep}`)
}

interface HandoffResidue {
  format: 1
  sessionId: SessionId
  repoId: string
  branch: string
  worktreeRoot: string
  treeSha: string
}

function residuePathFor(home: string, sessionId: SessionId): string {
  return join(home, '.podium', 'handoff-residue', `${basename(sessionId)}.json`)
}

async function readResidue(home: string, sessionId: SessionId): Promise<HandoffResidue | null> {
  try {
    const value = JSON.parse(
      await readFile(residuePathFor(home, sessionId), 'utf8'),
    ) as Partial<HandoffResidue>
    if (
      value.format !== 1 ||
      value.sessionId !== sessionId ||
      typeof value.repoId !== 'string' ||
      typeof value.branch !== 'string' ||
      typeof value.worktreeRoot !== 'string' ||
      typeof value.treeSha !== 'string'
    )
      return null
    return value as HandoffResidue
  } catch {
    return null
  }
}

async function writeResidue(home: string, residue: HandoffResidue): Promise<void> {
  const path = residuePathFor(home, residue.sessionId)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(residue, null, 2), { mode: 0o600 })
}

/** Hash tracked + untracked worktree contents without touching the real index. */
async function currentWorktreeTree(cwd: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'podium-handoff-check-'))
  const env = { GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    await git(cwd, ['read-tree', 'HEAD'], env)
    await git(cwd, ['add', '-A'], env)
    return await git(cwd, ['write-tree'], env)
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

/** Bundle bases are verified on the TARGET (bundle verify needs its prerequisites
 *  present there), but `git bundle create ^<sha>` also needs each base to exist on
 *  the SOURCE — e.g. the target's freshly-fetched origin/main may be unknown here.
 *  Keep only the intersection; an unknown ^sha aborts the whole bundle. */
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

/** Where both handoff packages (`<sessionId>.tgz`) and workspace-fetch packages
 *  (`<fetchId>.tgz`, POD-658) are staged for transfer. */
export function stageDirFor(home: string): string {
  return join(home, '.podium', 'handoff')
}

/** How long a staged package may sit untouched before a sweep reclaims it.
 *  Deliberately ~120x the worst in-flight window: a transfer pulls the file in
 *  8MB chunks whose per-chunk RPC times out at 30s (machines/rpc.ts), and a
 *  timed-out chunk aborts the whole transfer — so a package still legitimately
 *  being read is at most 30s-per-remaining-chunk from its last write, never an
 *  hour. Anything past this has no reader left. */
export const STAGE_TTL_MS = 3600_000 // 1 hour

/**
 * Delete abandoned staged packages ([POD-742]).
 *
 * Only the happy path frees a stage file — the source's is deleted when the
 * chunk reader hits EOF, the target's when the import succeeds. A handoff that
 * dies AFTER export (transfer, import, or bundle verify) leaves the source's
 * behind forever: the source never learns the transfer failed, so nothing there
 * can delete it deterministically and only a TTL sweep can reclaim it.
 *
 * Files only, and only `.tgz`: an in-flight export's `packageDir` is an
 * mkdtemp DIRECTORY in this same dir, removed by its own `finally`. Skipping
 * directories keeps this sweep off it regardless of how long an export runs.
 */
export async function sweepHandoffStage(input?: {
  homeDir?: string
  ttlMs?: number
  nowMs?: number
}): Promise<string[]> {
  const stageDir = stageDirFor(input?.homeDir ?? homedir())
  const ttlMs = input?.ttlMs ?? STAGE_TTL_MS
  const now = input?.nowMs ?? Date.now()
  const entries = await readdir(stageDir).catch(() => [] as string[])
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.tgz')) continue
    const path = join(stageDir, entry)
    const info = await stat(path).catch(() => null)
    // Writes bump mtime, reads do not: age is time since the last chunk landed
    // (target, mid-import) or since tar finished (source, awaiting transfer).
    if (!info?.isFile() || now - info.mtimeMs <= ttlMs) continue
    await rm(path, { force: true }).catch(() => undefined)
    removed.push(path)
  }
  return removed
}

export async function exportHandoffPackage(input: {
  sessionId: SessionId
  cwd: string
  fallbackCwd?: string
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
  const stageDir = stageDirFor(home)
  await mkdir(stageDir, { recursive: true, mode: 0o700 })
  // Reclaim packages abandoned by earlier failed handoffs. Here (and at daemon
  // start) rather than on a timer of its own: staging is the only thing that
  // fills this dir, so an export is exactly when a stale neighbour matters.
  await sweepHandoffStage({ homeDir: home })
  const packageDir = await mkdtemp(join(stageDir, `${input.sessionId}-`))
  const stagePath = join(stageDir, `${input.sessionId}.tgz`)
  // Every git operation below belongs to the WORKTREE, not the session's cwd:
  // the cwd may be a subdir of it, or (after drift) somewhere else entirely.
  const source = await resolveExportSource(input.cwd, input.fallbackCwd)
  const cwd = source.worktreeRoot
  const snapshot = await buildSnapshotCommit(cwd, input.sessionId)
  try {
    const actualBranch = await git(cwd, ['branch', '--show-current'])
    if (!actualBranch) throw new Error('detached HEAD cannot be handed off')
    const baseShas = await sourceKnownShas(cwd, input.baseShas)
    if (baseShas.length === 0)
      throw new Error('no bundle base shared between source and target repositories')
    const transcript = await transcriptForExport({
      agentKind: input.agentKind,
      // Claude buckets transcripts by cwd, so look in the bucket the agent ran
      // in — the drifted cwd reconstructed from the worktree root + subpath.
      cwd: join(cwd, source.subpath),
      resumeValue: input.resume.value,
      home,
    })
    const sourceInfo = await gitWorktree(cwd)
    const worktreeRelativePath = sourceInfo?.repoRoot
      ? repositoryRelativeWorktreePath(sourceInfo.repoRoot, cwd)
      : undefined
    const manifest = HandoffManifest.parse({
      // STILL FORMAT 1, deliberately (POD-1153). A `format: 2` manifest must
      // carry the attribution pair and the owner, and those may only be stamped
      // from an AUTHENTICATED TRANSPORT PRINCIPAL (ADR 3 D7) — which the handoff
      // export request frame does not carry, so there is nothing here to stamp
      // from. Writing a guess would put fabricated provenance in a durable file,
      // which is worse than recording none. Threading the principal into the
      // export request belongs to POD-644 (transfer path) / POD-1075 (principal
      // module); the READ path above already opens v2.
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
      worktreeName: basename(cwd),
      ...(worktreeRelativePath ? { worktreeRelativePath } : {}),
      ...(source.subpath ? { cwdSubpath: source.subpath } : {}),
      bundleBase: baseShas,
      ...(input.title ? { title: input.title } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      sourceMachineId: input.sourceMachineId,
      exportedAt: new Date().toISOString(),
    })
    await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await copyFile(transcript.path, join(packageDir, 'transcript.jsonl'))
    if (snapshot.snapshotSha || !baseShas.includes(snapshot.headSha)) {
      const revs = [
        actualBranch,
        ...(snapshot.snapshotSha ? [snapshot.handoffRef] : []),
        ...baseShas.map((sha) => `^${sha}`),
      ]
      await git(cwd, ['bundle', 'create', join(packageDir, 'repo.bundle'), ...revs])
    }
    await rm(stagePath, { force: true })
    await runFile('tar', ['-czf', stagePath, '-C', packageDir, '.'])
    await writeResidue(home, {
      format: 1,
      sessionId: input.sessionId,
      repoId: input.repoId,
      branch: actualBranch,
      worktreeRoot: cwd,
      treeSha: snapshot.treeSha,
    })
    return { manifest, stagePath, sizeBytes: (await stat(stagePath)).size }
  } finally {
    await git(cwd, ['update-ref', '-d', snapshot.handoffRef]).catch(() => '')
    await rm(packageDir, { recursive: true, force: true })
  }
}

function stagePathFor(home: string, sessionId: SessionId): string {
  return join(stageDirFor(home), `${basename(sessionId)}.tgz`)
}

export async function appendImportChunk(input: {
  homeDir?: string
  sessionId: SessionId
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
  sessionId: SessionId
  repoPath: string
  worktreeName: string
  occupiedWorktreePaths?: string[]
}): Promise<{ manifest: HandoffManifestType; newCwd: string; worktreeRoot: string }> {
  const home = input.homeDir ?? homedir()
  const archive = stagePathFor(home, input.sessionId)
  const unpacked = await mkdtemp(join(tmpdir(), 'podium-handoff-import-'))
  let worktreeRoot = join(input.repoPath, '.worktrees', basename(input.worktreeName))
  let createdWorktree = false
  try {
    await runFile('tar', ['-xzf', archive, '-C', unpacked])
    // Every format arrives through the one reader (POD-1153): a v2 bundle from a
    // newer peer opens here, and a v1 bundle on disk keeps opening. The header's
    // `claimedOwner` is deliberately NOT consulted below — ADR 3 D7: the
    // importing side owns what it imports, whatever the file claims.
    const { manifest } = readHandoffManifest(
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
    // The bundle records refs/heads/<branch> only when the tip is NOT already
    // excluded as a base (a dirty-only handoff whose branch sits exactly on a
    // shared base ships just the snapshot ref). And on a round trip the branch
    // is typically still checked out in the abandoned source worktree, where
    // `git fetch` refuses to update it — so fetch through a temp incoming ref
    // and move the branch explicitly below.
    const incomingRef = `refs/podium/handoff-incoming/${manifest.sessionId}`
    let incomingTip = manifest.headSha
    if (hasBundle) {
      await git(input.repoPath, ['bundle', 'verify', bundle])
      const heads = await git(input.repoPath, ['bundle', 'list-heads', bundle])
      const refs: string[] = []
      if (heads.includes(`refs/heads/${manifest.branch}`))
        refs.push(`+refs/heads/${manifest.branch}:${incomingRef}`)
      if (manifest.snapshotSha)
        refs.push(
          `${HANDOFF_REF_ROOT}/${manifest.sessionId}:${HANDOFF_REF_ROOT}/${manifest.sessionId}`,
        )
      if (refs.length > 0) await git(input.repoPath, ['fetch', bundle, ...refs])
      if (heads.includes(`refs/heads/${manifest.branch}`))
        incomingTip = await git(input.repoPath, ['rev-parse', '--verify', incomingRef])
    }
    const tipKnown = await git(input.repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${incomingTip}^{commit}`,
    ]).then(
      () => true,
      () => false,
    )
    if (!tipKnown) throw new Error('package omitted required git bundle')

    const desiredRoot = importedWorktreeRoot(input.repoPath, manifest, input.worktreeName)
    const worktrees = registeredWorktrees(
      await git(input.repoPath, ['worktree', 'list', '--porcelain']),
    )
    const exact = worktrees.find((entry) => resolve(entry.path) === resolve(desiredRoot))
    const byBranch = worktrees.find((entry) => entry.branch === manifest.branch)
    const existingWorktree = exact ?? byBranch
    worktreeRoot = existingWorktree?.path ?? desiredRoot
    if (existingWorktree) {
      // A return handoff reclaims the checkout the source deliberately retained,
      // even when an older hop converted `.claude/worktrees/...` to `.worktrees/...`.
      // Identity + state guards make the destructive sync specific to this residue.
      const checkedOut = await git(worktreeRoot, ['branch', '--show-current'])
      if (checkedOut !== manifest.branch)
        throw new Error(
          `existing worktree has branch ${checkedOut || '(detached)'}, package expects ${manifest.branch}`,
        )
      const occupied = (input.occupiedWorktreePaths ?? []).find((cwd) =>
        worktreeContains(worktreeRoot, cwd),
      )
      if (occupied)
        throw new Error(`target worktree is still used by another session: ${worktreeRoot}`)
      const residue = await readResidue(home, input.sessionId)
      if (residue) {
        if (
          residue.repoId !== manifest.repoId ||
          residue.branch !== manifest.branch ||
          resolve(residue.worktreeRoot) !== resolve(worktreeRoot)
        )
          throw new Error(
            `target worktree is not the retained residue for this session: ${worktreeRoot}`,
          )
        if ((await currentWorktreeTree(worktreeRoot)) !== residue.treeSha)
          throw new Error(`target worktree changed after handoff: ${worktreeRoot}`)
      } else {
        // Compatibility for residues exported before fingerprints existed (including
        // POD-1012): only an unchanged checkout is safe to adopt automatically.
        const dirty = await git(worktreeRoot, ['status', '--porcelain'])
        if (dirty) throw new Error(`target worktree has unrecorded changes: ${worktreeRoot}`)
      }
      await git(worktreeRoot, ['reset', '--hard', incomingTip])
      await git(worktreeRoot, ['clean', '-fd'])
    } else {
      const branchTip = await git(input.repoPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${manifest.branch}`,
      ]).catch(() => '')
      if (branchTip && branchTip !== incomingTip) {
        const fastForward = await git(input.repoPath, [
          'merge-base',
          '--is-ancestor',
          branchTip,
          incomingTip,
        ]).then(
          () => true,
          () => false,
        )
        if (!fastForward)
          throw new Error(`target branch ${manifest.branch} has diverged from the package`)
      }
      await git(input.repoPath, ['update-ref', `refs/heads/${manifest.branch}`, incomingTip])
      await mkdir(dirname(worktreeRoot), { recursive: true })
      await git(input.repoPath, ['worktree', 'add', worktreeRoot, manifest.branch])
      createdWorktree = true
    }
    await git(input.repoPath, ['update-ref', '-d', incomingRef]).catch(() => '')
    if (manifest.snapshotSha)
      await git(worktreeRoot, [
        'restore',
        `--source=${HANDOFF_REF_ROOT}/${manifest.sessionId}`,
        '--worktree',
        '--',
        '.',
      ])
    // Land where the agent was working; the transcript must follow the cwd it
    // resumes in, since Claude buckets transcripts by cwd.
    const newCwd = await landingCwd(worktreeRoot, manifest.cwdSubpath)
    const transcriptTarget = transcriptPlacement(manifest, newCwd, home)
    await mkdir(dirname(transcriptTarget), { recursive: true, mode: 0o700 })
    await copyFile(join(unpacked, 'transcript.jsonl'), transcriptTarget)
    await git(input.repoPath, [
      'update-ref',
      '-d',
      `${HANDOFF_REF_ROOT}/${manifest.sessionId}`,
    ]).catch(() => '')
    await rm(residuePathFor(home, input.sessionId), { force: true })
    return { manifest, newCwd, worktreeRoot }
  } catch (error) {
    // Only unwind a worktree WE created — a reused round-trip worktree predates
    // this import and must survive a failed attempt.
    if (createdWorktree) {
      await git(input.repoPath, ['worktree', 'remove', '--force', worktreeRoot]).catch(() => '')
      await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  } finally {
    // The archive dies with the attempt, won or lost ([POD-742]) — deleting it
    // only on success left every failed import (bundle verify, diverged branch,
    // id mismatch) staged forever. Nothing resumes a half-done import: the
    // server re-exports and re-transfers from offset 0 on the next try.
    // Mirrors importWorkspaceSnapshot, which already frees it in its finally.
    await rm(archive, { force: true })
    await rm(unpacked, { recursive: true, force: true })
  }
}
