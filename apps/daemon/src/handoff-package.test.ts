import { asRepoId, asSessionId, type SessionId } from '@podium/model'
import { execFileSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { claudeProjectSlug } from '@podium/harness'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSnapshotCommit,
  codexTranscriptPlacement,
  exportHandoffPackage,
  importHandoffPackage,
  readExportChunk,
  readHandoffManifest,
  resolveExportSource,
  STAGE_TTL_MS,
  sweepHandoffStage,
  transcriptPlacement,
} from './handoff-package'

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
async function repo(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `podium-${name}-`))
  roots.push(path)
  git(path, 'init', '-b', 'main')
  git(path, 'config', 'user.email', 'test@podium.local')
  git(path, 'config', 'user.name', 'Podium Test')
  await writeFile(join(path, 'tracked.txt'), 'base\n')
  git(path, 'add', '.')
  git(path, 'commit', '-m', 'base')
  return path
}
/** A linked worktree — the only thing a handoff may move ([spec:SP-3f7a]). Lives
 *  under the repo, so the `repo()` cleanup takes it with it. */
async function worktreeAt(repoPath: string, branch: string, relativePath: string): Promise<string> {
  const path = join(repoPath, relativePath)
  await mkdir(dirname(path), { recursive: true })
  git(repoPath, 'worktree', 'add', '-b', branch, path)
  return path
}
async function worktree(repoPath: string, branch: string): Promise<string> {
  return worktreeAt(repoPath, branch, join('.worktrees', branch.replace(/[^a-zA-Z0-9]/gu, '-')))
}
/** Seed the Claude transcript in the bucket for `cwd` (Claude buckets by cwd). */
async function seedTranscript(home: string, cwd: string, resumeValue: string, body = '{}\n') {
  const path = join(home, '.claude', 'projects', claudeProjectSlug(cwd), `${resumeValue}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
  return path
}
async function home(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `podium-home-${name}-`))
  roots.push(path)
  return path
}
/** Bun resolves `access` to null where Node resolves undefined — assert on a boolean. */
const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )
/** A staged package of a given age — the sweep reads mtime, so back-date it. */
async function stageFile(home: string, name: string, ageMs: number): Promise<string> {
  const path = join(home, '.podium', 'handoff', name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'staged package\n')
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
  return path
}
afterEach(() => {
  for (const root of roots.splice(0)) execFileSync('rm', ['-rf', root])
})

describe('handoff package', () => {
  it('builds a tracked+untracked snapshot without touching the real index', async () => {
    const source = await repo('snapshot')
    await writeFile(join(source, 'tracked.txt'), 'dirty\n')
    await writeFile(join(source, 'new.txt'), 'new\n')
    git(source, 'add', 'tracked.txt')
    const before = git(source, 'ls-files', '--stage')
    const result = await buildSnapshotCommit(source, 'session-snapshot')
    expect(result.snapshotSha).toBeTruthy()
    expect(git(source, 'ls-files', '--stage')).toBe(before)
    expect(git(source, 'show', `${result.snapshotSha}:tracked.txt`)).toBe('dirty')
    expect(git(source, 'show', `${result.snapshotSha}:new.txt`)).toBe('new')
  })

  it('places Claude by new cwd slug and preserves Codex date path + filename', () => {
    const common = {
      format: 1 as const,
      sessionId: asSessionId('s'),
      repoId: asRepoId('r'),
      branch: 'b',
      headSha: 'a'.repeat(40),
      snapshotSha: null,
      snapshotFlattened: true as const,
      worktreeName: 'w',
      bundleBase: ['a'.repeat(40)],
      sourceMachineId: 'm',
      exportedAt: new Date(0).toISOString(),
    }
    const claude = {
      ...common,
      agentKind: 'claude-code' as const,
      resume: { kind: 'claude-session' as const, value: 'native' },
      transcriptFilename: 'native.jsonl',
    }
    expect(transcriptPlacement(claude, '/new/worktree', '/home/t')).toBe(
      join('/home/t/.claude/projects', claudeProjectSlug('/new/worktree'), 'native.jsonl'),
    )
    expect(codexTranscriptPlacement('/home/t', '2026/07/14', '../rollout-verbatim.jsonl')).toBe(
      '/home/t/.codex/sessions/2026/07/14/rollout-verbatim.jsonl',
    )
  })

  it('drops target-verified bases the source repo does not know', async () => {
    // Target-verified bases can be unknown to the source (e.g. the target's
    // freshly-fetched origin/main after a reverse handoff): `git bundle create
    // ^<unknown>` aborts with "bad object", so export must keep the intersection.
    const origin = await repo('base-intersect')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/intersect')
    const sourceHome = await home('intersect')
    const resumeValue = 'claude-intersect-id'
    await seedTranscript(sourceHome, source, resumeValue)
    const foreign = '1234567890abcdef1234567890abcdef12345678'
    const exported = await exportHandoffPackage({
      sessionId: asSessionId('handoff-intersect'),
      cwd: source,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [foreign, base],
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: sourceHome,
    })
    expect(exported.manifest.bundleBase).toEqual([base])
    await expect(
      exportHandoffPackage({
        sessionId: asSessionId('handoff-intersect-none'),
        cwd: source,
        agentKind: 'claude-code',
        resume: { kind: 'claude-session', value: resumeValue },
        branch: 'ignored',
        baseShas: [foreign],
        repoId: 'repo',
        sourceMachineId: 'source',
        homeDir: sourceHome,
      }),
    ).rejects.toThrow(/no bundle base shared/)
  })

  it('imports a dirty-only package (branch tip on a shared base) and reuses an existing worktree', async () => {
    // A branch with no commits beyond the shared base bundles ONLY the snapshot
    // ref (git bundle drops refs pointing at excluded bases) — import must
    // create the branch from headSha. Importing again must reuse the existing
    // worktree (round trip) and hard-sync it to the package state.
    const origin = await repo('dirty-only')
    const base = git(origin, 'rev-parse', 'HEAD')
    const target = await mkdtemp(join(tmpdir(), 'podium-target-dirty-'))
    roots.push(target)
    execFileSync('git', ['clone', origin, target])
    git(target, 'config', 'user.email', 'test@podium.local')
    git(target, 'config', 'user.name', 'Podium Test')
    const source = await worktree(origin, 'feat/dirty-only')
    await writeFile(join(source, 'untracked.txt'), 'v1\n')

    const sourceHome = await home('dirty')
    const targetHome = await home('dirty-target')
    const resumeValue = 'claude-dirty-only'
    await seedTranscript(sourceHome, source, resumeValue)
    const exported = await exportHandoffPackage({
      sessionId: asSessionId('handoff-dirty-only'),
      cwd: source,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: sourceHome,
    })
    const stage = join(targetHome, '.podium', 'handoff', 'handoff-dirty-only.tgz')
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    const first = await importHandoffPackage({
      sessionId: asSessionId('handoff-dirty-only'),
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    expect(git(first.newCwd, 'branch', '--show-current')).toBe('feat/dirty-only')
    expect(await readFile(join(first.newCwd, 'untracked.txt'), 'utf8')).toBe('v1\n')

    // Round trip: stale residue in the existing worktree is superseded.
    await writeFile(join(first.newCwd, 'untracked.txt'), 'stale residue\n')
    await writeFile(join(first.newCwd, 'residue.txt'), 'left behind\n')
    await copyFile(exported.stagePath, stage)
    await expect(
      importHandoffPackage({
        sessionId: asSessionId('handoff-dirty-only'),
        repoPath: target,
        worktreeName: exported.manifest.worktreeName,
        homeDir: targetHome,
      }),
    ).rejects.toThrow(/unrecorded changes/)
    expect(await readFile(join(first.newCwd, 'untracked.txt'), 'utf8')).toBe('stale residue\n')
    expect(await readFile(join(first.newCwd, 'residue.txt'), 'utf8')).toBe('left behind\n')
  })

  it('preserves a Claude-owned worktree path on the target', async () => {
    const origin = await repo('path-origin')
    const base = git(origin, 'rev-parse', 'HEAD')
    const target = await mkdtemp(join(tmpdir(), 'podium-path-target-'))
    roots.push(target)
    execFileSync('git', ['clone', origin, target])
    const relativePath = join('.claude', 'worktrees', 'path-preserved')
    const source = await worktreeAt(origin, 'issue/1013-path-preserved', relativePath)
    const sourceHome = await home('path-source')
    const targetHome = await home('path-target')
    const resumeValue = 'claude-path-preserved'
    await seedTranscript(sourceHome, source, resumeValue)
    const exported = await exportHandoffPackage({
      sessionId: asSessionId('handoff-path-preserved'),
      cwd: source,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: sourceHome,
    })
    expect(exported.manifest.worktreeRelativePath).toBe('.claude/worktrees/path-preserved')
    const stage = join(targetHome, '.podium', 'handoff', 'handoff-path-preserved.tgz')
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    const imported = await importHandoffPackage({
      sessionId: asSessionId('handoff-path-preserved'),
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    expect(imported.worktreeRoot).toBe(join(target, relativePath))
  })

  it('reclaims the original checkout on a complete A to B to A round trip', async () => {
    const machineA = await repo('roundtrip-a')
    const base = git(machineA, 'rev-parse', 'HEAD')
    const machineB = await mkdtemp(join(tmpdir(), 'podium-roundtrip-b-'))
    roots.push(machineB)
    execFileSync('git', ['clone', machineA, machineB])
    const relativePath = join('.claude', 'worktrees', 'roundtrip')
    const sourceA = await worktreeAt(machineA, 'issue/1013-roundtrip', relativePath)
    await writeFile(join(sourceA, 'state.txt'), 'from-a\n')
    const homeA = await home('roundtrip-a')
    const homeB = await home('roundtrip-b')
    const resumeValue = 'claude-roundtrip'
    await seedTranscript(homeA, sourceA, resumeValue, '{"machine":"a"}\n')
    const outbound = await exportHandoffPackage({
      sessionId: asSessionId('handoff-roundtrip'),
      cwd: sourceA,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      issueId: '1013',
      sourceMachineId: 'a',
      homeDir: homeA,
    })
    const stageB = join(homeB, '.podium', 'handoff', 'handoff-roundtrip.tgz')
    await mkdir(dirname(stageB), { recursive: true })
    await copyFile(outbound.stagePath, stageB)
    const onB = await importHandoffPackage({
      sessionId: asSessionId('handoff-roundtrip'),
      repoPath: machineB,
      worktreeName: outbound.manifest.worktreeName,
      homeDir: homeB,
    })
    expect(onB.worktreeRoot).toBe(join(machineB, relativePath))
    await writeFile(join(onB.worktreeRoot, 'state.txt'), 'from-b\n')
    const inbound = await exportHandoffPackage({
      sessionId: asSessionId('handoff-roundtrip'),
      cwd: onB.worktreeRoot,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      issueId: '1013',
      sourceMachineId: 'b',
      homeDir: homeB,
    })
    const stageA = join(homeA, '.podium', 'handoff', 'handoff-roundtrip.tgz')
    await copyFile(inbound.stagePath, stageA)
    const backOnA = await importHandoffPackage({
      sessionId: asSessionId('handoff-roundtrip'),
      repoPath: machineA,
      worktreeName: inbound.manifest.worktreeName,
      homeDir: homeA,
    })
    expect(backOnA.worktreeRoot).toBe(sourceA)
    expect(await readFile(join(sourceA, 'state.txt'), 'utf8')).toBe('from-b\n')
  })

  it('reclaims a clean pre-fingerprint worktree by branch after an old path conversion', async () => {
    const machineA = await repo('legacy-a')
    const base = git(machineA, 'rev-parse', 'HEAD')
    const machineB = await mkdtemp(join(tmpdir(), 'podium-legacy-b-'))
    roots.push(machineB)
    execFileSync('git', ['clone', machineA, machineB])
    const branch = 'worktree-buzzing-swinging-dawn'
    const originalA = await worktreeAt(
      machineA,
      branch,
      join('.claude', 'worktrees', 'buzzing-swinging-dawn'),
    )
    const sourceB = await worktreeAt(machineB, branch, join('.worktrees', 'buzzing-swinging-dawn'))
    await writeFile(join(sourceB, 'returned.txt'), 'from-b\n')
    const homeB = await home('legacy-b')
    const homeA = await home('legacy-a')
    const resumeValue = 'claude-legacy-return'
    await seedTranscript(homeB, sourceB, resumeValue)
    const inbound = await exportHandoffPackage({
      sessionId: asSessionId('handoff-legacy-return'),
      cwd: sourceB,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'b',
      homeDir: homeB,
    })
    const stageA = join(homeA, '.podium', 'handoff', 'handoff-legacy-return.tgz')
    await mkdir(dirname(stageA), { recursive: true })
    await copyFile(inbound.stagePath, stageA)
    const imported = await importHandoffPackage({
      sessionId: asSessionId('handoff-legacy-return'),
      repoPath: machineA,
      worktreeName: inbound.manifest.worktreeName,
      homeDir: homeA,
    })
    expect(imported.worktreeRoot).toBe(originalA)
    expect(await readFile(join(originalA, 'returned.txt'), 'utf8')).toBe('from-b\n')
  })

  it('refuses to reclaim residue changed after its outbound handoff', async () => {
    const origin = await repo('changed-residue')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/1013-changed-residue')
    const sourceHome = await home('changed-residue')
    const resumeValue = 'claude-changed-residue'
    await seedTranscript(sourceHome, source, resumeValue)
    const exported = await exportHandoffPackage({
      sessionId: asSessionId('handoff-changed-residue'),
      cwd: source,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: sourceHome,
    })
    await writeFile(join(source, 'after-handoff.txt'), 'must survive\n')
    await expect(
      importHandoffPackage({
        sessionId: asSessionId('handoff-changed-residue'),
        repoPath: origin,
        worktreeName: exported.manifest.worktreeName,
        homeDir: sourceHome,
      }),
    ).rejects.toThrow(/changed after handoff/)
    expect(await readFile(join(source, 'after-handoff.txt'), 'utf8')).toBe('must survive\n')
  })

  it('refuses to reclaim a checkout occupied by another target session', async () => {
    const origin = await repo('occupied')
    const base = git(origin, 'rev-parse', 'HEAD')
    const target = await mkdtemp(join(tmpdir(), 'podium-occupied-target-'))
    roots.push(target)
    execFileSync('git', ['clone', origin, target])
    const source = await worktree(origin, 'issue/1013-occupied')
    const occupied = await worktree(target, 'issue/1013-occupied')
    const sourceHome = await home('occupied-source')
    const targetHome = await home('occupied-target')
    const resumeValue = 'claude-occupied'
    await seedTranscript(sourceHome, source, resumeValue)
    const exported = await exportHandoffPackage({
      sessionId: asSessionId('handoff-occupied'),
      cwd: source,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: sourceHome,
    })
    const stage = join(targetHome, '.podium', 'handoff', 'handoff-occupied.tgz')
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    await expect(
      importHandoffPackage({
        sessionId: asSessionId('handoff-occupied'),
        repoPath: target,
        worktreeName: exported.manifest.worktreeName,
        occupiedWorktreePaths: [occupied],
        homeDir: targetHome,
      }),
    ).rejects.toThrow(/still used by another session/)
  })

  it('exports and imports dirty state plus Claude transcript between repositories', async () => {
    const origin = await repo('source')
    const base = git(origin, 'rev-parse', 'HEAD')
    const target = await mkdtemp(join(tmpdir(), 'podium-target-'))
    roots.push(target)
    execFileSync('git', ['clone', origin, target])
    git(target, 'config', 'user.email', 'test@podium.local')
    git(target, 'config', 'user.name', 'Podium Test')
    const source = await worktree(origin, 'issue/498-handoff')
    await writeFile(join(source, 'branch.txt'), 'branch\n')
    git(source, 'add', '.')
    git(source, 'commit', '-m', 'branch')
    await writeFile(join(source, 'tracked.txt'), 'dirty survives\n')
    await writeFile(join(source, 'untracked.txt'), 'untracked survives\n')

    const sourceHome = await home('source')
    const targetHome = await home('target')
    const resumeValue = 'claude-native-id'
    await seedTranscript(sourceHome, source, resumeValue, '{"memory":"bluebird"}\n')
    const exported = await exportHandoffPackage({
      sessionId: asSessionId('handoff-roundtrip'),
      cwd: source,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: sourceHome,
    })
    const targetArchive = join(targetHome, '.podium', 'handoff', 'handoff-roundtrip.tgz')
    await mkdir(dirname(targetArchive), { recursive: true })
    await copyFile(exported.stagePath, targetArchive)
    const finalChunk = await readExportChunk({
      homeDir: sourceHome,
      stagePath: exported.stagePath,
      offset: 0,
      length: 8 * 1024 * 1024,
    })
    expect(finalChunk.eof).toBe(true)
    await expect(access(exported.stagePath)).rejects.toThrow()
    const imported = await importHandoffPackage({
      sessionId: asSessionId('handoff-roundtrip'),
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    expect(await readFile(join(imported.newCwd, 'tracked.txt'), 'utf8')).toBe('dirty survives\n')
    expect(await readFile(join(imported.newCwd, 'untracked.txt'), 'utf8')).toBe(
      'untracked survives\n',
    )
    expect(
      await readFile(
        join(
          targetHome,
          '.claude',
          'projects',
          claudeProjectSlug(imported.newCwd),
          `${resumeValue}.jsonl`,
        ),
        'utf8',
      ),
    ).toContain('bluebird')
  })
})

// POD-1153. The v1 -> v2 lift lives in the READ path, and this is where the
// compatibility promise is actually kept. The V1 fixture below is PERMANENT: it
// is a bundle header of the shape already sitting on people's disks, and the day
// it stops parsing is the day an export from last month becomes unopenable. It
// is deliberately a literal rather than something built from the current schema —
// a fixture generated from the code under test cannot notice the code changing.
describe('handoff manifest read path across file formats ([POD-1153])', () => {
  /** A v1 bundle header, verbatim. Do not regenerate; do not tidy. */
  const V1_ON_DISK = {
    format: 1,
    sessionId: 'handoff-legacy',
    agentKind: 'claude-code',
    resume: { kind: 'claude-session', value: 'uuid-legacy' },
    transcriptFilename: 'uuid-legacy.jsonl',
    repoId: 'repo-1',
    branch: 'issue/498-handoff',
    headSha: 'a'.repeat(40),
    snapshotSha: null,
    snapshotFlattened: true,
    worktreeName: 'issue-498',
    bundleBase: ['c'.repeat(40)],
    sourceMachineId: 'machine-1',
    exportedAt: '2026-07-14T12:00:00.000Z',
  }

  const V2_ON_DISK = {
    ...V1_ON_DISK,
    format: 2,
    exportedAt: undefined,
    exported: {
      at: '2026-07-30T12:00:00.000Z',
      by: { actor: { kind: 'agent', id: 'agent-7' }, onBehalfOf: 'user-mgw' },
    },
    owner: 'user-mgw',
    visibility: 'personal',
  }

  it('opens a v1 bundle and reports NO attribution rather than inventing one', () => {
    const header = readHandoffManifest(V1_ON_DISK)
    expect(header.manifest.format).toBe(1)
    expect(header.exportedAt).toBe('2026-07-14T12:00:00.000Z')
    // The whole point of the null: a v1 bundle never recorded a principal, so a
    // synthesized actor here would be fabricated provenance in a durable record.
    expect(header.attribution).toBeNull()
    expect(header.claimedOwner).toBeNull()
  })

  it('opens a v2 bundle and reports the attribution pair and the claimed owner', () => {
    const { exportedAt: _v1Key, ...v2 } = V2_ON_DISK
    const header = readHandoffManifest(v2)
    expect(header.manifest.format).toBe(2)
    // ONE spelling of the export time: it comes from inside the pair, and the
    // v1 key is not present in the input at all.
    expect(header.exportedAt).toBe('2026-07-30T12:00:00.000Z')
    expect(header.attribution).toEqual({
      at: '2026-07-30T12:00:00.000Z',
      by: { actor: { kind: 'agent', id: 'agent-7' }, onBehalfOf: 'user-mgw' },
    })
    // ADR 9 D5 A4: the OWNER is the on-behalf-of human, the ACTOR is the agent.
    expect(header.claimedOwner).toBe('user-mgw')
    expect(header.attribution?.by.actor).toEqual({ kind: 'agent', id: 'agent-7' })
  })

  it('refuses a v1 bundle relabelled as v2 instead of reading it as v1', () => {
    // The negative that a positive round-trip cannot show: "upgrade" must never
    // mean "assume the missing half was there all along".
    expect(() => readHandoffManifest({ ...V1_ON_DISK, format: 2 })).toThrow(/unreadable/)
  })

  it('refuses a format newer than this reader, and says which', () => {
    expect(() => readHandoffManifest({ ...V1_ON_DISK, format: 3 })).toThrow(
      /format 3 is not readable by this Podium \(supports 1, 2\)/,
    )
    // Unknown input fails CLOSED, and the instrument is shown able to say YES:
    // the same header at format 1 parses fine two cases above.
    expect(() => readHandoffManifest({ nonsense: true })).toThrow(/unreadable/)
    expect(() => readHandoffManifest(null)).toThrow(/unreadable/)
  })

  it('keeps the worktree containment refusal on the v2 arm', () => {
    const { exportedAt: _v1Key, ...v2 } = V2_ON_DISK
    expect(() => readHandoffManifest({ ...v2, worktreeRelativePath: '../escape' })).toThrow(
      /unreadable/,
    )
    // Counterfactual: the same bundle with a contained path opens.
    expect(
      readHandoffManifest({ ...v2, worktreeRelativePath: '.worktrees/issue-498' }).manifest.format,
    ).toBe(2)
  })

  it('imports a real v2 bundle end to end', async () => {
    // The read path proven against a bundle a NEWER PEER would send: export the
    // real thing, rewrite only its manifest.json to format 2, repack, import.
    // Nothing else about the package changes, so a failure is attributable to the
    // format and not to the fixture.
    const origin = await repo('v2-origin')
    const base = git(origin, 'rev-parse', 'HEAD')
    const target = await mkdtemp(join(tmpdir(), 'podium-v2-target-'))
    roots.push(target)
    execFileSync('git', ['clone', origin, target])
    const source = await worktree(origin, 'issue/1153-v2')
    await writeFile(join(source, 'state.txt'), 'from-v2\n')
    const sourceHome = await home('v2-source')
    const targetHome = await home('v2-target')
    const resumeValue = 'claude-v2-bundle'
    await seedTranscript(sourceHome, source, resumeValue)
    const exported = await exportHandoffPackage({
      sessionId: asSessionId('handoff-v2'),
      cwd: source,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: sourceHome,
    })
    // Today's exporter writes v1 — asserted, because the rewrite below would be
    // a no-op if it silently started writing v2, and this test would then prove
    // nothing about reading v2.
    expect(exported.manifest.format).toBe(1)

    const repack = await mkdtemp(join(tmpdir(), 'podium-v2-repack-'))
    roots.push(repack)
    execFileSync('tar', ['-xzf', exported.stagePath, '-C', repack])
    const onDisk = JSON.parse(await readFile(join(repack, 'manifest.json'), 'utf8'))
    const { exportedAt, ...rest } = onDisk
    await writeFile(
      join(repack, 'manifest.json'),
      JSON.stringify({
        ...rest,
        format: 2,
        exported: {
          at: exportedAt,
          by: { actor: { kind: 'agent', id: 'agent-7' }, onBehalfOf: 'user-mgw' },
        },
        owner: 'user-mgw',
        visibility: 'personal',
      }),
    )
    const stage = join(targetHome, '.podium', 'handoff', 'handoff-v2.tgz')
    await mkdir(dirname(stage), { recursive: true })
    execFileSync('tar', ['-czf', stage, '-C', repack, '.'])

    const imported = await importHandoffPackage({
      sessionId: asSessionId('handoff-v2'),
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    expect(imported.manifest.format).toBe(2)
    expect(git(imported.newCwd, 'branch', '--show-current')).toBe('issue/1153-v2')
    expect(await readFile(join(imported.newCwd, 'state.txt'), 'utf8')).toBe('from-v2\n')
  })
})

describe('handoff source resolution ([spec:SP-3f7a])', () => {
  const exportFrom = async (input: {
    cwd: string
    fallbackCwd?: string
    sessionId: SessionId
    homeDir: string
    baseShas: string[]
    resumeValue: string
  }) =>
    exportHandoffPackage({
      sessionId: input.sessionId,
      cwd: input.cwd,
      ...(input.fallbackCwd ? { fallbackCwd: input.fallbackCwd } : {}),
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: input.resumeValue },
      branch: 'ignored',
      baseShas: input.baseShas,
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: input.homeDir,
    })

  it('classifies main vs worktree from a subdir, where git prints relative git dirs', async () => {
    // From a subdirectory git prints `--git-dir`/`--git-common-dir` RELATIVE to
    // the cwd (`../.git`), so comparing the raw strings — or letting rev-parse
    // echo an unknown flag it does not support (it exits 0 and prints it back) —
    // reads a main checkout as a linked worktree. Both roots must be resolved.
    const origin = await repo('classify')
    await mkdir(join(origin, 'apps', 'web'), { recursive: true })
    const wt = await worktree(origin, 'issue/657-classify')
    await mkdir(join(wt, 'apps', 'web'), { recursive: true })

    await expect(resolveExportSource(join(origin, 'apps', 'web'))).rejects.toThrow(
      /only worktree sessions/,
    )
    await expect(resolveExportSource(origin)).rejects.toThrow(/only worktree sessions/)
    expect(await resolveExportSource(join(wt, 'apps', 'web'))).toEqual({
      worktreeRoot: wt,
      subpath: 'apps/web',
    })
    // Drift: cwd is the main checkout, the issue's worktree carries the work.
    expect(await resolveExportSource(origin, wt)).toEqual({ worktreeRoot: wt, subpath: '' })
    // A main checkout is never a legal fallback either.
    await expect(resolveExportSource(origin, origin)).rejects.toThrow(/only worktree sessions/)
  })

  it('never exports a main checkout — at its root or from a subdir inside it', async () => {
    // git decides (git-dir === git-common-dir), not the path shape: a cwd deep
    // inside the main checkout must not read as a worktree.
    const origin = await repo('main-guard')
    const base = git(origin, 'rev-parse', 'HEAD')
    const sourceHome = await home('main-guard')
    await mkdir(join(origin, 'apps', 'web'), { recursive: true })
    await seedTranscript(sourceHome, origin, 'claude-main-guard')
    const common = { homeDir: sourceHome, baseShas: [base], resumeValue: 'claude-main-guard' }
    await expect(exportFrom({ ...common, sessionId: asSessionId('guard-root'), cwd: origin })).rejects.toThrow(
      /only worktree sessions can be handed off/,
    )
    await expect(
      exportFrom({ ...common, sessionId: asSessionId('guard-subdir'), cwd: join(origin, 'apps', 'web') }),
    ).rejects.toThrow(/only worktree sessions can be handed off/)
  })

  it('exports the worktree CONTAINING a drifted cwd and lands the agent in the same subdir', async () => {
    const origin = await repo('subpath')
    const base = git(origin, 'rev-parse', 'HEAD')
    const target = await mkdtemp(join(tmpdir(), 'podium-target-subpath-'))
    roots.push(target)
    execFileSync('git', ['clone', origin, target])
    const source = await worktree(origin, 'issue/657-subpath')
    await mkdir(join(source, 'apps', 'web'), { recursive: true })
    await writeFile(join(source, 'apps', 'web', 'app.ts'), 'export const x = 1\n')
    const agentCwd = join(source, 'apps', 'web')

    const sourceHome = await home('subpath')
    const targetHome = await home('subpath-target')
    const resumeValue = 'claude-subpath'
    await seedTranscript(sourceHome, agentCwd, resumeValue, '{"memory":"subdir"}\n')
    const exported = await exportFrom({
      sessionId: asSessionId('handoff-subpath'),
      cwd: agentCwd,
      homeDir: sourceHome,
      baseShas: [base],
      resumeValue,
    })
    expect(exported.manifest.cwdSubpath).toBe('apps/web')
    expect(exported.manifest.worktreeName).toBe(basename(source))
    expect(exported.manifest.branch).toBe('issue/657-subpath')

    const stage = join(targetHome, '.podium', 'handoff', 'handoff-subpath.tgz')
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    const imported = await importHandoffPackage({
      sessionId: asSessionId('handoff-subpath'),
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    expect(imported.newCwd).toBe(
      join(target, '.worktrees', exported.manifest.worktreeName, 'apps', 'web'),
    )
    // The transcript follows the landing cwd — Claude buckets by cwd, so the
    // resumed agent only finds its conversation in the subdir's bucket.
    expect(
      await readFile(
        join(
          targetHome,
          '.claude',
          'projects',
          claudeProjectSlug(imported.newCwd),
          `${resumeValue}.jsonl`,
        ),
        'utf8',
      ),
    ).toContain('subdir')
  })

  it('lands at the worktree root when the subdir does not exist on the target', async () => {
    // An empty scratch dir is never committed, so the imported tree has no such
    // path — the handoff must still land, at the root.
    const origin = await repo('subpath-missing')
    const base = git(origin, 'rev-parse', 'HEAD')
    const target = await mkdtemp(join(tmpdir(), 'podium-target-missing-'))
    roots.push(target)
    execFileSync('git', ['clone', origin, target])
    const source = await worktree(origin, 'issue/657-missing')
    const agentCwd = join(source, 'scratch')
    await mkdir(agentCwd, { recursive: true })

    const sourceHome = await home('missing')
    const targetHome = await home('missing-target')
    const resumeValue = 'claude-missing'
    await seedTranscript(sourceHome, agentCwd, resumeValue)
    const exported = await exportFrom({
      sessionId: asSessionId('handoff-missing'),
      cwd: agentCwd,
      homeDir: sourceHome,
      baseShas: [base],
      resumeValue,
    })
    expect(exported.manifest.cwdSubpath).toBe('scratch')
    const stage = join(targetHome, '.podium', 'handoff', 'handoff-missing.tgz')
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    const imported = await importHandoffPackage({
      sessionId: asSessionId('handoff-missing'),
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    expect(imported.newCwd).toBe(join(target, '.worktrees', exported.manifest.worktreeName))
  })

  it('falls back to the issue worktree when the cwd drifted onto the main checkout', async () => {
    // The live shape this issue is about: the agent ran a command against the
    // main checkout and got restamped there. Its issue worktree is still its
    // home — that is what moves, and main is never touched.
    const origin = await repo('anchored')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/657-anchored')
    await writeFile(join(source, 'work.txt'), 'in progress\n')
    const sourceHome = await home('anchored')
    const resumeValue = 'claude-anchored'
    await seedTranscript(sourceHome, source, resumeValue)

    const exported = await exportFrom({
      sessionId: asSessionId('handoff-anchored'),
      cwd: origin, // drifted: stamped at the repo root
      fallbackCwd: source,
      homeDir: sourceHome,
      baseShas: [base],
      resumeValue,
    })
    expect(exported.manifest.branch).toBe('issue/657-anchored')
    expect(exported.manifest.worktreeName).toBe(basename(source))
    expect(exported.manifest.cwdSubpath).toBeUndefined()
  })

  it('ignores the fallback when the cwd is in a worktree of its own', async () => {
    const origin = await repo('prefer-cwd')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/657-actual')
    const other = await worktree(origin, 'issue/658-other')
    const sourceHome = await home('prefer-cwd')
    const resumeValue = 'claude-prefer-cwd'
    await seedTranscript(sourceHome, source, resumeValue)
    const exported = await exportFrom({
      sessionId: asSessionId('handoff-prefer-cwd'),
      cwd: source,
      fallbackCwd: other,
      homeDir: sourceHome,
      baseShas: [base],
      resumeValue,
    })
    expect(exported.manifest.branch).toBe('issue/657-actual')
  })
})

describe('abandoned stage files ([POD-742])', () => {
  it('sweeps packages past the TTL and keeps fresh ones', async () => {
    const sourceHome = await home('sweep')
    const abandoned = await stageFile(sourceHome, 'dead-handoff.tgz', 2 * STAGE_TTL_MS)
    // A transfer still pulling this one keeps it well inside the TTL: chunk RPCs
    // time out at 30s, so an in-flight package is never an hour untouched.
    const inFlight = await stageFile(sourceHome, 'in-flight-fetch.tgz', 60_000)
    expect(await sweepHandoffStage({ homeDir: sourceHome })).toEqual([abandoned])
    expect(await exists(abandoned)).toBe(false)
    expect(await exists(inFlight)).toBe(true)
  })

  it('never touches an in-flight export packageDir, however long the export runs', async () => {
    // Both exports mkdtemp a packageDir INSIDE the stage dir and remove it in
    // their own finally. Files only, .tgz only — so the sweep cannot race it.
    const sourceHome = await home('sweep-dirs')
    const packageDir = join(sourceHome, '.podium', 'handoff', 'session-abc-Xk29fp')
    await mkdir(packageDir, { recursive: true })
    const aged = new Date(Date.now() - 2 * STAGE_TTL_MS)
    await utimes(packageDir, aged, aged)
    const notAPackage = await stageFile(sourceHome, 'scratch.txt', 2 * STAGE_TTL_MS)
    expect(await sweepHandoffStage({ homeDir: sourceHome })).toEqual([])
    expect(await exists(packageDir)).toBe(true)
    expect(await exists(notAPackage)).toBe(true)
  })

  it('tolerates a stage dir that does not exist yet', async () => {
    expect(await sweepHandoffStage({ homeDir: await home('sweep-empty') })).toEqual([])
  })

  it('sweeps residue from an earlier failed handoff on the next export', async () => {
    const origin = await repo('sweep-export')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/742-sweep')
    const sourceHome = await home('sweep-export')
    const resumeValue = 'claude-sweep-export'
    await seedTranscript(sourceHome, source, resumeValue)
    const abandoned = await stageFile(sourceHome, 'dead-handoff.tgz', 2 * STAGE_TTL_MS)
    const recentFetch = await stageFile(sourceHome, 'recent-fetch.tgz', 5 * 60_000)
    const exported = await exportHandoffPackage({
      sessionId: asSessionId('handoff-sweep-export'),
      cwd: source,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: sourceHome,
    })
    expect(await exists(abandoned)).toBe(false)
    // A workspace fetch (POD-658) stages beside us — a live one must survive.
    expect(await exists(recentFetch)).toBe(true)
    expect(await exists(exported.stagePath)).toBe(true)
  })

  it('frees the target stage file when the import FAILS', async () => {
    // The package only ever died with a WON import; a loss at bundle verify, a
    // diverged branch, or an id mismatch left it staged forever. Nothing resumes
    // a half-done import — the next attempt re-exports and re-transfers.
    const origin = await repo('import-fail')
    const base = git(origin, 'rev-parse', 'HEAD')
    const target = await mkdtemp(join(tmpdir(), 'podium-target-import-fail-'))
    roots.push(target)
    execFileSync('git', ['clone', origin, target])
    const source = await worktree(origin, 'issue/742-import-fail')
    await writeFile(join(source, 'work.txt'), 'in progress\n')
    const sourceHome = await home('import-fail')
    const targetHome = await home('import-fail-target')
    const resumeValue = 'claude-import-fail'
    await seedTranscript(sourceHome, source, resumeValue)
    const exported = await exportHandoffPackage({
      sessionId: asSessionId('handoff-import-fail'),
      cwd: source,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: resumeValue },
      branch: 'ignored',
      baseShas: [base],
      repoId: 'repo',
      sourceMachineId: 'source',
      homeDir: sourceHome,
    })
    const stage = join(targetHome, '.podium', 'handoff', 'wrong-session.tgz')
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    await expect(
      importHandoffPackage({
        sessionId: asSessionId('wrong-session'),
        repoPath: target,
        worktreeName: exported.manifest.worktreeName,
        homeDir: targetHome,
      }),
    ).rejects.toThrow(/package session id mismatch/)
    expect(await exists(stage)).toBe(false)
  })
})
