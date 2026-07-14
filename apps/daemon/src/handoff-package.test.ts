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

  it('exports and imports dirty state plus Claude transcript between repositories', async () => {
    const source = await repo('source')
    const base = git(source, 'rev-parse', 'HEAD')
    const target = await mkdtemp(join(tmpdir(), 'podium-target-'))
    roots.push(target)
    execFileSync('git', ['clone', source, target])
    git(target, 'config', 'user.email', 'test@podium.local')
    git(target, 'config', 'user.name', 'Podium Test')
    git(source, 'checkout', '-b', 'issue/498-handoff')
    await writeFile(join(source, 'branch.txt'), 'branch\n')
    git(source, 'add', '.')
    git(source, 'commit', '-m', 'branch')
    await writeFile(join(source, 'tracked.txt'), 'dirty survives\n')
    await writeFile(join(source, 'untracked.txt'), 'untracked survives\n')

    const sourceHome = await mkdtemp(join(tmpdir(), 'podium-home-source-'))
    roots.push(sourceHome)
    const targetHome = await mkdtemp(join(tmpdir(), 'podium-home-target-'))
    roots.push(targetHome)
    const resumeValue = 'claude-native-id'
    const transcript = join(
      sourceHome,
      '.claude',
      'projects',
      claudeProjectSlug(source),
      `${resumeValue}.jsonl`,
    )
    await mkdir(dirname(transcript), { recursive: true })
    await writeFile(transcript, '{"memory":"bluebird"}\n')
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
      worktreeName: basename(source),
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
