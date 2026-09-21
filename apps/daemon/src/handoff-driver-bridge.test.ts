import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DriverRefusalError, type SessionArchive } from '@podium/harness/driver/host'
import { claudeProjectSlug, codexTranscriptPlacement } from '@podium/harness'
import {
  asMachineId,
  asRepoId,
  asSessionId,
  asUserId,
  type ResumeRef,
  type SessionId,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { DaemonContext } from './control/context'
import { handoffHandlers } from './control/handoff'
import {
  archivePathParts,
  exportConversationViaDriver,
  refuseUnsupportedHandoffHarness,
  validateConversationArchive,
} from './handoff-driver-bridge'
import { exportHandoffPackage, importHandoffPackage } from './handoff-package'

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
function configureGitIdentity(path: string): void {
  git(path, 'config', 'user.email', 'test@podium.local')
  git(path, 'config', 'user.name', 'Podium Test')
}
async function repo(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `podium-${name}-`))
  roots.push(path)
  git(path, 'init', '-b', 'main')
  configureGitIdentity(path)
  await writeFile(join(path, 'tracked.txt'), 'base\n')
  git(path, 'add', '.')
  git(path, 'commit', '-m', 'base')
  return path
}
async function cloneRepo(origin: string, prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  roots.push(path)
  execFileSync('git', ['clone', origin, path])
  configureGitIdentity(path)
  return path
}
async function worktree(repoPath: string, branch: string): Promise<string> {
  const path = join(repoPath, '.worktrees', branch.replace(/[^a-zA-Z0-9]/gu, '-'))
  await mkdir(dirname(path), { recursive: true })
  git(repoPath, 'worktree', 'add', '-b', branch, path)
  return path
}
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

const exportIdentity = {
  exportedBy: {
    actor: { kind: 'user' as const, id: asUserId('user:alice') },
    onBehalfOf: asUserId('user:alice'),
  },
  owner: asUserId('user:alice'),
  visibility: 'personal' as const,
}

function driverArchive(input: {
  sessionId: SessionId
  agentKind: 'claude-code' | 'codex'
  resume: ResumeRef
  path: string
  bytes: string
  workdir?: string
}): SessionArchive {
  return {
    harness: input.agentKind,
    formatVersion: 1,
    resume: input.resume,
    files: [{ path: input.path, bytes: new TextEncoder().encode(input.bytes) }],
    binding: {
      sessionId: input.sessionId,
      driver: 'generic-pty',
      family: 'terminal',
      harness: input.agentKind,
      workdir: input.workdir ?? '/tmp/work',
      resume: input.resume,
    },
  }
}

function driverContext(archive?: SessionArchive | Error, sessionId?: SessionId): DaemonContext {
  const handle =
    archive === undefined
      ? undefined
      : {
          export: async () => {
            if (archive instanceof Error) throw archive
            return archive
          },
        }
  return {
    agentRuntime: {
      handleFor: (id: SessionId) => (sessionId && id === sessionId ? handle : undefined),
    },
  } as unknown as DaemonContext
}

describe('handoff driver bridge (POD-4306 F16)', () => {
  it('uses live driver bytes for the package, not the stale file', async () => {
    const origin = await repo('bridge-live')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/4306-live')
    const sourceHome = await home('bridge-live')
    const sessionId = asSessionId('handoff-bridge-live')
    const resume = { kind: 'claude-session', value: 'claude-live-witness' } as const
    // Stale file the bypass would have read.
    await seedTranscript(sourceHome, source, resume.value, '{"stale":"file"}\n')
    const witness = 'podium-witness-live-driver-bytes'
    const conversation = driverArchive({
      sessionId,
      agentKind: 'claude-code',
      resume,
      path: `${resume.value}.jsonl`,
      bytes: `{"live":"${witness}"}\n`,
      workdir: source,
    })
    const exported = await exportHandoffPackage({
      sessionId,
      cwd: source,
      agentKind: 'claude-code',
      resume,
      branch: 'ignored',
      baseShas: [base],
      repoId: asRepoId('repo'),
      sourceMachineId: asMachineId('source'),
      homeDir: sourceHome,
      ...exportIdentity,
      conversation,
    })
    expect(exported.manifest.transcriptFilename).toBe(`${resume.value}.jsonl`)
    // The package must carry the DRIVER bytes; deleting this branch and
    // reading the file instead leaves the stale payload and reds this.
    const target = await cloneRepo(origin, 'podium-bridge-live-target-')
    const targetHome = await home('bridge-live-target')
    const stage = join(targetHome, '.podium', 'handoff', `${sessionId}.tgz`)
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    const imported = await importHandoffPackage({
      sessionId,
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    const landed = await readFile(imported.nativeArtifactPath, 'utf8')
    expect(landed).toContain(witness)
    expect(landed).not.toContain('stale')
  })

  it('preserves Codex relativeDir from the driver archive path', async () => {
    const origin = await repo('bridge-codex')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/4306-codex')
    const sourceHome = await home('bridge-codex')
    const sessionId = asSessionId('handoff-bridge-codex')
    const resume = { kind: 'codex-thread', value: 'thread-codex-1' } as const
    const conversation = driverArchive({
      sessionId,
      agentKind: 'codex',
      resume,
      path: '2026/07/30/rollout.jsonl',
      bytes: '{"codex":"witness"}\n',
      workdir: source,
    })
    const exported = await exportHandoffPackage({
      sessionId,
      cwd: source,
      agentKind: 'codex',
      resume,
      branch: 'ignored',
      baseShas: [base],
      repoId: asRepoId('repo'),
      sourceMachineId: asMachineId('source'),
      homeDir: sourceHome,
      ...exportIdentity,
      conversation,
    })
    // Path rebasing: archive-relative dir survives as manifest relativeDir.
    expect(exported.manifest.transcriptFilename).toBe('rollout.jsonl')
    expect(exported.manifest.transcriptRelativeDir).toBe('2026/07/30')
    const target = await cloneRepo(origin, 'podium-bridge-codex-target-')
    const targetHome = await home('bridge-codex-target')
    const stage = join(targetHome, '.podium', 'handoff', `${sessionId}.tgz`)
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    const imported = await importHandoffPackage({
      sessionId,
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    expect(imported.nativeArtifactPath).toBe(
      codexTranscriptPlacement(targetHome, '2026/07/30', 'rollout.jsonl'),
    )
    expect(await readFile(imported.nativeArtifactPath, 'utf8')).toContain('witness')
  })

  it('refuses harness, resume and session mismatches (native identity)', async () => {
    const sessionId = asSessionId('handoff-bridge-identity')
    const resume = { kind: 'claude-session', value: 'uuid-identity' } as const
    const base = driverArchive({
      sessionId,
      agentKind: 'claude-code',
      resume,
      path: `${resume.value}.jsonl`,
      bytes: '{}\n',
    })
    // Harness mismatch.
    expect(() =>
      validateConversationArchive(
        { ...base, harness: 'codex', binding: { ...base.binding, harness: 'codex' } },
        { sessionId, agentKind: 'claude-code', resume },
      ),
    ).toThrow(/conversation harness mismatch/)
    // Resume mismatch.
    expect(() =>
      validateConversationArchive(
        {
          ...base,
          resume: { kind: 'claude-session', value: 'other' },
          binding: { ...base.binding, resume: { kind: 'claude-session', value: 'other' } },
        },
        { sessionId, agentKind: 'claude-code', resume },
      ),
    ).toThrow(/conversation identity mismatch/)
    // Session mismatch — a second active incarnation under another id.
    expect(() =>
      validateConversationArchive(
        {
          ...base,
          binding: { ...base.binding, sessionId: asSessionId('other-session') },
        },
        { sessionId, agentKind: 'claude-code', resume },
      ),
    ).toThrow(/conversation session mismatch/)
  })

  it('refuses empty archives, empty bytes and escaping paths', async () => {
    const sessionId = asSessionId('handoff-bridge-empty')
    const resume = { kind: 'claude-session', value: 'uuid-empty' } as const
    const base = driverArchive({
      sessionId,
      agentKind: 'claude-code',
      resume,
      path: `${resume.value}.jsonl`,
      bytes: '{}\n',
    })
    expect(() =>
      validateConversationArchive({ ...base, files: [] }, { sessionId, agentKind: 'claude-code', resume }),
    ).toThrow(/conversation archive is empty/)
    expect(() =>
      validateConversationArchive(
        {
          ...base,
          files: [{ path: `${resume.value}.jsonl`, bytes: new Uint8Array() }],
        },
        { sessionId, agentKind: 'claude-code', resume },
      ),
    ).toThrow(/conversation archive is empty/)
    for (const bad of ['/abs/path.jsonl', '..\\escape.jsonl', 'a/../b.jsonl', 'a//b.jsonl']) {
      expect(() =>
        validateConversationArchive(
          {
            ...base,
            files: [{ path: bad, bytes: new TextEncoder().encode('{}\n') }],
          },
          { sessionId, agentKind: 'claude-code', resume },
        ),
      ).toThrow(/escapes the archive root/)
      expect(() => archivePathParts(bad)).toThrow(/escapes|empty/)
    }
  })

  it('refuses an archive carrying per-machine process identity', async () => {
    const sessionId = asSessionId('handoff-bridge-process')
    const resume = { kind: 'claude-session', value: 'uuid-process' } as const
    const base = driverArchive({
      sessionId,
      agentKind: 'claude-code',
      resume,
      path: `${resume.value}.jsonl`,
      bytes: '{}\n',
    })
    const leaked = {
      ...base,
      binding: { ...base.binding, process: { key: 'abduco:session' }, bindingVersion: 3 },
    } as unknown as SessionArchive
    expect(() =>
      validateConversationArchive(leaked, { sessionId, agentKind: 'claude-code', resume }),
    ).toThrow(/carries process identity/)
  })

  it('maps driver unsupported and missing resume to handoff refusals, and keeps parked support', async () => {
    const sessionId = asSessionId('handoff-bridge-refusal')
    const resume = { kind: 'claude-session', value: 'uuid-refusal' } as const
    await expect(
      exportConversationViaDriver(
        driverContext(new DriverRefusalError({ reason: 'unsupported' }, 'export'), sessionId),
        sessionId,
        { agentKind: 'claude-code', resume },
      ),
    ).rejects.toThrow(/declares handoff unsupported/)
    await expect(
      exportConversationViaDriver(
        driverContext(new DriverRefusalError({ reason: 'no_resume_ref' }, 'export'), sessionId),
        sessionId,
        { agentKind: 'claude-code', resume },
      ),
    ).rejects.toThrow(/no resume reference/)
    // Parked: no live handle, so the file fallback owns it — undefined, not a throw.
    await expect(
      exportConversationViaDriver(driverContext(undefined, sessionId), sessionId, {
        agentKind: 'claude-code',
        resume,
      }),
    ).resolves.toBeUndefined()
  })

  it('exports a live conversation via the driver and falls back when parked', async () => {
    const origin = await repo('bridge-fallback')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/4306-fallback')
    const sourceHome = await home('bridge-fallback')
    const sessionId = asSessionId('handoff-bridge-fallback')
    const resume = { kind: 'claude-session', value: 'uuid-fallback' } as const
    await seedTranscript(sourceHome, source, resume.value, '{"parked":"yes"}\n')
    const conversation = driverArchive({
      sessionId,
      agentKind: 'claude-code',
      resume,
      path: `${resume.value}.jsonl`,
      bytes: '{"live":"yes"}\n',
      workdir: source,
    })
    // Live: driver bytes win.
    const viaDriver = await exportConversationViaDriver(
      driverContext(conversation, sessionId),
      sessionId,
      { agentKind: 'claude-code', resume },
    )
    expect(viaDriver?.files[0]?.path).toBe(`${resume.value}.jsonl`)
    // A mismatched driver archive is refused BEFORE the workspace snapshot —
    // no residue, no stage file, source untouched.
    const mismatched = driverArchive({
      sessionId: asSessionId('other-session'),
      agentKind: 'claude-code',
      resume,
      path: `${resume.value}.jsonl`,
      bytes: '{}\n',
    })
    await expect(
      exportConversationViaDriver(driverContext(mismatched, sessionId), sessionId, {
        agentKind: 'claude-code',
        resume,
      }),
    ).rejects.toThrow(/conversation session mismatch/)
    // Parked export still packages the file.
    const parked = await exportHandoffPackage({
      sessionId,
      cwd: source,
      agentKind: 'claude-code',
      resume,
      branch: 'ignored',
      baseShas: [base],
      repoId: asRepoId('repo'),
      sourceMachineId: asMachineId('source'),
      homeDir: sourceHome,
      ...exportIdentity,
    })
    expect(parked.manifest.transcriptFilename).toBe(`${resume.value}.jsonl`)
  })

  it('refuses unsupported harnesses before package materialization on import', async () => {
    expect(() => refuseUnsupportedHandoffHarness('grok')).toThrow(
      /declares handoff unsupported/,
    )
    expect(() => refuseUnsupportedHandoffHarness('claude-code')).not.toThrow()
    // Through the handler: repoPath must not be read for an unsupported family.
    const sent: DaemonMessage[] = []
    const sessionId = asSessionId('import-grok-unsupported')
    const ctx = {
      machineId: 'target-machine',
      send: (message: DaemonMessage) => sent.push(message),
    } as unknown as DaemonContext
    handoffHandlers.handoffImportRequest(ctx, {
      type: 'handoffImportRequest',
      requestId: 'request-grok',
      sessionId,
      repoPath: '/must-not-be-read',
      worktreeName: 'must-not-be-read',
      binding: {
        transitionId: 'adopt:grok',
        machineAccess: 'allowed',
        transfer: {
          transferId: 'transfer-grok',
          sessionId,
          agentKind: 'grok',
          fromMachineId: asMachineId('source-machine'),
          toMachineId: asMachineId('target-machine'),
          observationGeneration: 1,
          delegation: {
            actor: { kind: 'user', id: 'user:alice' } as never,
            onBehalfOf: asUserId('user:alice'),
            grantedScope: { kind: 'all' as const },
            parentBindingId: null,
          },
        },
      },
    })
    await Promise.resolve()
    expect(sent).toEqual([
      {
        type: 'handoffImportResult',
        requestId: 'request-grok',
        ok: false,
        error: expect.stringMatching(/declares handoff unsupported/),
      },
    ])
  })

  it('refuses an empty landed transcript before the binding claim', async () => {
    const origin = await repo('bridge-empty-landed')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/4306-empty')
    const sourceHome = await home('bridge-empty-source')
    const targetHome = await home('bridge-empty-target')
    const sessionId = asSessionId('handoff-bridge-empty-landed')
    const resume = { kind: 'claude-session', value: 'uuid-empty-landed' } as const
    await seedTranscript(sourceHome, source, resume.value, '{}\n')
    const target = await cloneRepo(origin, 'podium-bridge-empty-target-')
    const exported = await exportHandoffPackage({
      sessionId,
      cwd: source,
      agentKind: 'claude-code',
      resume,
      branch: 'ignored',
      baseShas: [base],
      repoId: asRepoId('repo'),
      sourceMachineId: asMachineId('source'),
      homeDir: sourceHome,
      ...exportIdentity,
    })
    // Empty the transcript inside a copy of the package: export never writes
    // one, so this crafts the failure the import gate must catch. Removing the
    // `landed transcript is empty` check lets this import succeed with zero
    // bytes — the target would claim it can resume a conversation it cannot.
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const runFile = promisify(execFile)
    const scratch = await mkdtemp(join(tmpdir(), 'podium-empty-craft-'))
    roots.push(scratch)
    await runFile('tar', ['-xzf', exported.stagePath, '-C', scratch])
    await writeFile(join(scratch, 'transcript.jsonl'), '')
    const stage = join(targetHome, '.podium', 'handoff', `${sessionId}.tgz`)
    await mkdir(dirname(stage), { recursive: true })
    await runFile('tar', ['-czf', stage, '-C', scratch, '.'])
    await expect(
      importHandoffPackage({
        sessionId,
        repoPath: target,
        worktreeName: exported.manifest.worktreeName,
        homeDir: targetHome,
      }),
    ).rejects.toThrow(/landed transcript is empty/)
    // Staged archive freed so a retry starts clean.
    const { access } = await import('node:fs/promises')
    await expect(access(stage)).rejects.toThrow()
  })

  it('unwinds a created worktree and frees the staged archive on import failure', async () => {
    const origin = await repo('bridge-unwind')
    const base = git(origin, 'rev-parse', 'HEAD')
    const source = await worktree(origin, 'issue/4306-unwind')
    const sourceHome = await home('bridge-unwind-source')
    const targetHome = await home('bridge-unwind-target')
    const sessionId = asSessionId('handoff-bridge-unwind')
    const resume = { kind: 'claude-session', value: 'uuid-unwind' } as const
    await seedTranscript(sourceHome, source, resume.value)
    const target = await cloneRepo(origin, 'podium-bridge-unwind-target-')
    const exported = await exportHandoffPackage({
      sessionId,
      cwd: source,
      agentKind: 'claude-code',
      resume,
      branch: 'ignored',
      baseShas: [base],
      repoId: asRepoId('repo'),
      sourceMachineId: asMachineId('source'),
      homeDir: sourceHome,
      ...exportIdentity,
    })
    const stage = join(targetHome, '.podium', 'handoff', `${sessionId}.tgz`)
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    // Occupy the desired checkout with another live session: the import must
    // refuse BEFORE resetting it, and the staged archive must die with the
    // attempt so the next retry (re-export + transfer from offset 0) starts
    // clean. This is the interrupted-transfer / target-failure acceptance.
    const occupied = await worktree(target, exported.manifest.branch)
    await expect(
      importHandoffPackage({
        sessionId,
        repoPath: target,
        worktreeName: exported.manifest.worktreeName,
        occupiedWorktreePaths: [occupied],
        homeDir: targetHome,
      }),
    ).rejects.toThrow(/still used by another session/)
    // The staged archive dies with the attempt so the next retry starts clean.
    const { access } = await import('node:fs/promises')
    await expect(access(stage)).rejects.toThrow()
    // The occupied checkout itself survives the refused import (no data loss).
    expect(git(occupied, 'branch', '--show-current')).toBe(exported.manifest.branch)
  })

  it('lands a moved workspace: relative path preserved, missing subdir falls back to root', async () => {
    const origin = await repo('bridge-moved')
    const base = git(origin, 'rev-parse', 'HEAD')
    const relativePath = join('.worktrees', 'moved')
    const { mkdir: mk } = await import('node:fs/promises')
    const source = join(origin, relativePath)
    await mk(dirname(source), { recursive: true })
    git(origin, 'worktree', 'add', '-b', 'issue/4306-moved', source)
    const subdir = join(source, 'packages', 'model')
    await mk(subdir, { recursive: true })
    await writeFile(join(subdir, 'note.txt'), 'here\n')
    const sourceHome = await home('bridge-moved-source')
    const targetHome = await home('bridge-moved-target')
    const sessionId = asSessionId('handoff-bridge-moved')
    const resume = { kind: 'claude-session', value: 'uuid-moved' } as const
    await seedTranscript(sourceHome, subdir, resume.value, '{"moved":"yes"}\n')
    const target = await cloneRepo(origin, 'podium-bridge-moved-target-')
    const exported = await exportHandoffPackage({
      // Drifted into a subdir: the export must carry the subpath.
      sessionId,
      cwd: subdir,
      agentKind: 'claude-code',
      resume,
      branch: 'ignored',
      baseShas: [base],
      repoId: asRepoId('repo'),
      sourceMachineId: asMachineId('source'),
      homeDir: sourceHome,
      ...exportIdentity,
    })
    expect(exported.manifest.cwdSubpath).toBe(join('packages', 'model'))
    expect(exported.manifest.worktreeRelativePath).toBe('.worktrees/moved')
    const stage = join(targetHome, '.podium', 'handoff', `${sessionId}.tgz`)
    await mkdir(dirname(stage), { recursive: true })
    await copyFile(exported.stagePath, stage)
    const imported = await importHandoffPackage({
      sessionId,
      repoPath: target,
      worktreeName: exported.manifest.worktreeName,
      homeDir: targetHome,
    })
    // Same repository-relative checkout on a different absolute root.
    expect(imported.worktreeRoot).toBe(join(target, '.worktrees', 'moved'))
    expect(imported.newCwd).toBe(join(imported.worktreeRoot, 'packages', 'model'))
    expect(basename(imported.nativeArtifactPath)).toBe(`${resume.value}.jsonl`)
  })
})

describe('handoff export control bridge (live handle vs parked)', () => {
  async function controlExport(input: {
    source: string
    sourceHome: string
    sessionId: SessionId
    resume: ResumeRef
    liveArchive?: SessionArchive | Error
    agentKind?: 'claude-code' | 'codex'
    baseShas?: string[]
  }): Promise<{ sent: DaemonMessage[]; ctx: DaemonContext }> {
    const sent: DaemonMessage[] = []
    const agentKind = input.agentKind ?? 'claude-code'
    const handle =
      input.liveArchive === undefined
        ? undefined
        : {
            export: async () => {
              if (input.liveArchive instanceof Error) throw input.liveArchive
              return input.liveArchive as SessionArchive
            },
          }
    const ctx = {
      machineId: asMachineId('source'),
      homeDir: input.sourceHome,
      send: (message: DaemonMessage) => sent.push(message),
      sessionCwdTracker: { rawCwd: () => undefined },
      agentRuntime: {
        handleFor: (id: SessionId) => (id === input.sessionId ? handle : undefined),
      },
      sessionBinding: {
        transition: async () => ({
          status: 'applied' as const,
          binding: { agentKind },
        }),
        adoptTransfer: () => ({ agentKind }),
      },
    } as unknown as DaemonContext
    handoffHandlers.handoffExportRequest(ctx, {
      type: 'handoffExportRequest',
      requestId: `req-${String(input.sessionId)}`,
      sessionId: input.sessionId,
      cwd: input.source,
      agentKind,
      resume: input.resume,
      branch: 'ignored',
      baseShas: input.baseShas ?? ['ignored'],
      repoId: asRepoId('repo'),
      sourceMachineId: asMachineId('source'),
      binding: {
        transitionId: `adopt:${String(input.sessionId)}:source-claim`,
        transferId: `transfer-${String(input.sessionId)}`,
        targetMachineId: asMachineId('target'),
        machineAccess: 'allowed' as const,
        exportedBy: exportIdentity.exportedBy,
        owner: exportIdentity.owner,
        visibility: exportIdentity.visibility,
      },
    })
    // The handler is `void` async: poll for the correlated result.
    for (let i = 0; i < 200 && sent.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return { sent, ctx }
  }

  it('packages live driver bytes through the control handler, not the stale file', async () => {
    const origin = await repo('bridge-control-live')
    const base = git(origin, 'rev-parse', 'HEAD')
    void base
    const source = await worktree(origin, 'issue/4306-control-live')
    const sourceHome = await home('bridge-control-live')
    const sessionId = asSessionId('handoff-bridge-control-live')
    const resume = { kind: 'claude-session', value: 'uuid-control-live' } as const
    await seedTranscript(sourceHome, source, resume.value, '{"stale":"file"}\n')
    // Real base for the export: read it after the worktree exists.
    const realBase = git(origin, 'rev-parse', 'HEAD')
    void realBase
    const witness = 'podium-witness-control-live'
    const liveArchive = driverArchive({
      sessionId,
      agentKind: 'claude-code',
      resume,
      path: `${resume.value}.jsonl`,
      bytes: `{"live":"${witness}"}\n`,
      workdir: source,
    })
    // Patch baseShas via controlExport's ignored placeholder is replaced here:
    // use the real base by exporting through the same helper with correct base.
    // For this test the helper uses 'ignored' and would fail bundle bases, so
    // drive the package directly through the handler with the real base below.
    const sent: DaemonMessage[] = []
    const handle = { export: async () => liveArchive }
    const ctx = {
      machineId: asMachineId('source'),
      homeDir: sourceHome,
      send: (message: DaemonMessage) => sent.push(message),
      sessionCwdTracker: { rawCwd: () => undefined },
      agentRuntime: { handleFor: (id: SessionId) => (id === sessionId ? handle : undefined) },
      sessionBinding: {
        transition: async () => ({ status: 'applied' as const, binding: { agentKind: 'claude-code' } }),
        adoptTransfer: () => ({ agentKind: 'claude-code' }),
      },
    } as unknown as DaemonContext
    // Need the real base: recompute from the worktree's repo.
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const runFile = promisify(execFile)
    void runFile
    const originBase = git(origin, 'rev-parse', 'HEAD')
    handoffHandlers.handoffExportRequest(ctx, {
      type: 'handoffExportRequest',
      requestId: 'req-control-live',
      sessionId,
      cwd: source,
      agentKind: 'claude-code',
      resume,
      branch: 'ignored',
      baseShas: [originBase],
      repoId: asRepoId('repo'),
      sourceMachineId: asMachineId('source'),
      binding: {
        transitionId: 'adopt:control-live:source-claim',
        transferId: 'transfer-control-live',
        targetMachineId: asMachineId('target'),
        machineAccess: 'allowed' as const,
        exportedBy: exportIdentity.exportedBy,
        owner: exportIdentity.owner,
        visibility: exportIdentity.visibility,
      },
    })
    for (let i = 0; i < 200 && sent.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(sent[0]).toMatchObject({ type: 'handoffExportResult', ok: true })
    const result = sent[0] as { stagePath: string }
    const scratch = await mkdtemp(join(tmpdir(), 'podium-control-live-'))
    roots.push(scratch)
    const { execFileSync: sync } = await import('node:child_process')
    sync('tar', ['-xzf', result.stagePath, '-C', scratch])
    const packaged = await readFile(join(scratch, 'transcript.jsonl'), 'utf8')
    // Deleting the `conversation` pass-through in control/handoff.ts leaves
    // the stale file payload here and reds this.
    expect(packaged).toContain(witness)
    expect(packaged).not.toContain('stale')
  })

  it('falls back to the file when parked and refuses driver failures without residue', async () => {
    const origin = await repo('bridge-control-parked')
    const source = await worktree(origin, 'issue/4306-control-parked')
    const sourceHome = await home('bridge-control-parked')
    const sessionId = asSessionId('handoff-bridge-control-parked')
    const resume = { kind: 'claude-session', value: 'uuid-control-parked' } as const
    await seedTranscript(sourceHome, source, resume.value, '{"parked":"yes"}\n')
    const originBase = git(origin, 'rev-parse', 'HEAD')
    // Parked: no live handle, the file owns the bytes end to end.
    const parked = await controlExport({
      source,
      sourceHome,
      sessionId,
      resume,
      baseShas: [originBase],
    })
    expect(parked.sent[0]).toMatchObject({ type: 'handoffExportResult', ok: true })
    const parkedStage = (parked.sent[0] as { stagePath: string }).stagePath
    const parkedScratch = await mkdtemp(join(tmpdir(), 'podium-control-parked-'))
    roots.push(parkedScratch)
    const { execFileSync: syncParked } = await import('node:child_process')
    syncParked('tar', ['-xzf', parkedStage, '-C', parkedScratch])
    expect(await readFile(join(parkedScratch, 'transcript.jsonl'), 'utf8')).toContain('parked')
    // Driver failure aborts before residue/stage: no data loss, retry clean.
    const failing = await controlExport({
      source,
      sourceHome,
      sessionId: asSessionId('handoff-bridge-control-fail'),
      resume,
      liveArchive: new DriverRefusalError({ reason: 'no_resume_ref' }, 'export'),
    })
    expect(failing.sent[0]).toMatchObject({ type: 'handoffExportResult', ok: false })
    expect(JSON.stringify(failing.sent[0])).toMatch(/no resume reference/)
  })
})
