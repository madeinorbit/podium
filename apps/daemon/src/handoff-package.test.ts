import { execFileSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { claudeProjectSlug } from '@podium/agent-bridge'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSnapshotCommit,
  codexTranscriptPlacement,
  exportHandoffPackage,
  importHandoffPackage,
  readExportChunk,
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
async function worktree(repoPath: string, branch: string): Promise<string> {
  const path = join(repoPath, '.worktrees', branch.replace(/[^a-zA-Z0-9]/gu, '-'))
  git(repoPath, 'worktree', 'add', '-b', branch, path)
  return path
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
      sessionId: 's',
      repoId: 'r',
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
      sessionId: 'handoff-intersect',
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
        sessionId: 'handoff-intersect-none',
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
      sessionId: 'handoff-dirty-only',
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
      sessionId: 'handoff-dirty-only',
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
    const second = await importHandoffPackage({
      sessionId: 'handoff-dirty-only',
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    expect(second.newCwd).toBe(first.newCwd)
    expect(await readFile(join(second.newCwd, 'untracked.txt'), 'utf8')).toBe('v1\n')
    await expect(access(join(second.newCwd, 'residue.txt'))).rejects.toThrow()
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
      sessionId: 'handoff-roundtrip',
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
      sessionId: 'handoff-roundtrip',
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

describe('handoff source resolution ([spec:SP-3f7a])', () => {
  const exportFrom = async (input: {
    cwd: string
    fallbackCwd?: string
    sessionId: string
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

  it('never exports a main checkout — at its root or from a subdir inside it', async () => {
    // git decides (git-dir === git-common-dir), not the path shape: a cwd deep
    // inside the main checkout must not read as a worktree.
    const origin = await repo('main-guard')
    const base = git(origin, 'rev-parse', 'HEAD')
    const sourceHome = await home('main-guard')
    await mkdir(join(origin, 'apps', 'web'), { recursive: true })
    await seedTranscript(sourceHome, origin, 'claude-main-guard')
    const common = { homeDir: sourceHome, baseShas: [base], resumeValue: 'claude-main-guard' }
    await expect(exportFrom({ ...common, sessionId: 'guard-root', cwd: origin })).rejects.toThrow(
      /only worktree sessions can be handed off/,
    )
    await expect(
      exportFrom({ ...common, sessionId: 'guard-subdir', cwd: join(origin, 'apps', 'web') }),
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
      sessionId: 'handoff-subpath',
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
      sessionId: 'handoff-subpath',
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
      sessionId: 'handoff-missing',
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
      sessionId: 'handoff-missing',
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
      sessionId: 'handoff-anchored',
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
      sessionId: 'handoff-prefer-cwd',
      cwd: source,
      fallbackCwd: other,
      homeDir: sourceHome,
      baseShas: [base],
      resumeValue,
    })
    expect(exported.manifest.branch).toBe('issue/657-actual')
  })
})
