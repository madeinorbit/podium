import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { AgentKind, type SessionId, type UserId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import type { MachineUseResolver, MachinesService } from '../machines/service'
import type { DaemonRpcService } from '../machines/rpc'
import type { IssueService } from '../issues/service'
import type { SessionStore } from '../../store'
import { repoNameFromOrigin } from '@podium/model'
import {
  transferHandoffPackage,
  verifiedBundleBases,
  verifiedCommonBundleBases,
} from './handoff-transfer'
import type { Session } from './session'

type SessionLookup = (sessionId: SessionId) => Session | undefined

export interface SessionWorkspacePorts {
  store: SessionStore
  rpc: DaemonRpcService
  machines: MachinesService
  issues(): IssueService
  getSession: SessionLookup
  settingsViewer(): UserId
  onWorktreesChanged(repoPath: string, machineId?: string): void
}

/** Machine-scoped repository and worktree operations used by lifecycle and handoff. */
export class SessionWorkspace {
  constructor(private readonly ports: SessionWorkspacePorts) {}

  async prepareTarget(input: {
    agentKind?: AgentKind
    cwd: string
    machineId?: string
    use?: MachineUseResolver
  }): Promise<{ cwd: string; machineId?: string }> {
    if (!input.machineId) return { cwd: input.cwd }
    const parsed = AgentKind.safeParse(input.agentKind)
    const agentKind = parsed.success
      ? parsed.data
      : resolveRole(
          this.ports.store.settings.getSettingsFor(this.ports.settingsViewer()),
          'coding',
        ).harness
    this.ports.machines.resolveMachineForAgent(
      input.machineId,
      input.cwd,
      agentKind,
      input.use,
    )
    const sourceRepo = this.ports.store.repos
      .listRepos()
      .filter((repo) => input.cwd === repo.path || input.cwd.startsWith(`${repo.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!sourceRepo || sourceRepo.machineId === input.machineId) {
      return { cwd: input.cwd, machineId: input.machineId }
    }
    const targetRepo = await this.ensureTargetRepo(sourceRepo, input.machineId)
    const suffix = input.cwd.slice(sourceRepo.path.length).replace(/^\/+/, '')
    return {
      cwd: suffix ? join(targetRepo.path, suffix) : targetRepo.path,
      machineId: input.machineId,
    }
  }

  async ensureTargetRepo(
    sourceRepo: {
      machineId: string
      path: string
      originUrl: string | null
      repoId: string | null
      prefix: string | null
    },
    targetMachineId: string,
  ): Promise<{
    machineId: string
    path: string
    originUrl: string | null
    repoId: string | null
    prefix: string | null
  }> {
    const existing = this.ports.store.repos
      .listRepos(targetMachineId)
      .find((repo) => repo.repoId === sourceRepo.repoId)
    if (existing) return existing
    if (!sourceRepo.originUrl || !sourceRepo.repoId) {
      throw new Error('target machine lacks this repository and the source has no clone URL')
    }
    const home = await this.ports.rpc.browseDirs(undefined, {}, targetMachineId)
    if (!home.listing) {
      throw new Error(home.error ?? 'target machine did not report its home directory')
    }
    const repoName =
      repoNameFromOrigin(sourceRepo.originUrl)?.replace(/[^a-zA-Z0-9._-]+/gu, '-') || 'repository'
    const suffix = sourceRepo.repoId.replace(/[^a-zA-Z0-9]+/gu, '').slice(-8) || 'checkout'
    const targetPath = join(home.listing.homePath, 'podium-repos', `${repoName}-${suffix}`)
    const cloned = await this.ports.rpc.repoOp(
      'clone',
      home.listing.homePath,
      { originUrl: sourceRepo.originUrl, path: targetPath },
      targetMachineId,
    )
    if (!cloned.ok) throw new Error(`could not clone repository on target: ${cloned.output}`)
    this.ports.store.repos.addRepo(
      targetPath,
      targetMachineId,
      sourceRepo.originUrl,
      sourceRepo.prefix ?? undefined,
    )
    const registered = this.ports.store.repos
      .listRepos(targetMachineId)
      .find((repo) => repo.path === targetPath)
    if (!registered || registered.repoId !== sourceRepo.repoId) {
      throw new Error('cloned repository identity does not match the handoff source')
    }
    this.ports.onWorktreesChanged(targetPath, targetMachineId)
    return registered
  }

  async fetch(input: { sourceSessionId: SessionId; callerSessionId: SessionId }): Promise<{
    path: string
    sameMachine: boolean
    sourceMachine: string
    branch: string
    headSha: string
    dirty: boolean
  }> {
    const source = this.ports.getSession(input.sourceSessionId)
    if (!source) throw new Error('unknown source session')
    const caller = this.ports.getSession(input.callerSessionId)
    if (!caller) throw new Error('unknown calling session')
    const sourceMachine = this.ports.machines
      .listMachines()
      .find((machine) => machine.id === source.machineId)
    if (source.machineId === caller.machineId) {
      return {
        path: source.cwd,
        sameMachine: true,
        sourceMachine: sourceMachine?.name ?? source.machineId,
        branch: '',
        headSha: '',
        dirty: false,
      }
    }
    if (!sourceMachine?.online) throw new Error('source machine is offline')

    const repos = this.ports.store.repos.listRepos()
    const sourceRepo = repos
      .filter(
        (repo) =>
          repo.machineId === source.machineId &&
          (source.cwd === repo.path || source.cwd.startsWith(`${repo.path}/`)),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!sourceRepo?.repoId) throw new Error('source repository is not registered')
    const fetcherRepo = repos.find(
      (repo) => repo.machineId === caller.machineId && repo.repoId === sourceRepo.repoId,
    )
    if (!fetcherRepo) throw new Error('this machine does not have the source repository')

    const issue = source.issueId ? this.ports.issues().getMeta(source.issueId) : undefined
    const branch = issue?.branch ?? basename(source.cwd)
    const candidates = [
      ...new Set(
        [issue?.parentBranch, 'main', 'origin/main', branch].filter((ref): ref is string =>
          Boolean(ref),
        ),
      ),
    ]
    const sourceVerified = await Promise.all(
      candidates.map((ref) =>
        this.ports.rpc.repoOp('revParseVerify', sourceRepo.path, { ref }, source.machineId),
      ),
    )
    const sourceBaseShas = verifiedBundleBases(sourceVerified)
    const fetcherVerified = await Promise.all(
      sourceBaseShas.map((ref) =>
        this.ports.rpc.repoOp('revParseVerify', fetcherRepo.path, { ref }, caller.machineId),
      ),
    )
    const baseShas = verifiedCommonBundleBases(sourceVerified, fetcherVerified)
    if (baseShas.length === 0) {
      throw new Error('no verified common bundle base with the source repository')
    }

    const fetchId = `ws-${randomUUID().slice(0, 13)}`
    const exported = await this.ports.rpc.workspaceExport(
      {
        fetchId,
        cwd: source.cwd,
        baseShas,
        repoId: sourceRepo.repoId,
        sourceMachineId: source.machineId,
      },
      source.machineId,
    )
    if (
      !exported.ok ||
      !exported.stagePath ||
      exported.sizeBytes === undefined ||
      !exported.manifest
    ) {
      throw new Error(exported.error ?? 'source failed to export its workspace')
    }
    await transferHandoffPackage({
      rpc: this.ports.rpc,
      sessionId: fetchId as `ws-${string}`,
      sourceMachineId: source.machineId,
      targetMachineId: caller.machineId,
      sourceStagePath: exported.stagePath,
      sizeBytes: exported.sizeBytes,
    })
    const imported = await this.ports.rpc.workspaceImport(
      fetchId,
      fetcherRepo.path,
      caller.machineId,
    )
    if (!imported.ok || !imported.path) {
      throw new Error(imported.error ?? 'failed to materialize the fetched workspace')
    }
    return {
      path: imported.path,
      sameMachine: false,
      sourceMachine: sourceMachine.name,
      branch: exported.manifest.branch,
      headSha: exported.manifest.headSha,
      dirty: exported.manifest.snapshotSha !== null,
    }
  }

  async cleanPeeks(input: { callerSessionId: SessionId }): Promise<{ removed: string[] }> {
    const caller = this.ports.getSession(input.callerSessionId)
    if (!caller) throw new Error('unknown calling session')
    const repo = this.ports.store.repos
      .listRepos()
      .filter(
        (candidate) =>
          candidate.machineId === caller.machineId &&
          (caller.cwd === candidate.path || caller.cwd.startsWith(`${candidate.path}/`)),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!repo) throw new Error('calling session is not inside a registered repository')
    const result = await this.ports.rpc.workspaceClean(repo.path, caller.machineId)
    if (!result.ok) throw new Error(result.error ?? 'workspace clean failed')
    return { removed: result.removed ?? [] }
  }

  ensureSessionWorktree(
    session: Session,
  ):
    | { ok: boolean; reason?: string; cwd?: string }
    | Promise<{ ok: boolean; reason?: string; cwd?: string }> {
    const issues = this.ports.issues()
    const issueId = session.issueId ?? issues.issueForCwd(session.cwd)
    if (!issueId) return { ok: true, cwd: session.cwd }
    const issue = issues.getMeta(issueId)
    if (!issue) return { ok: true, cwd: session.cwd }
    if (issue.worktreePath) return { ok: true, cwd: issue.worktreePath }
    if (!session.stopReason || !issue.branch) return { ok: true, cwd: session.cwd }
    return issues.ensureWorktree(issueId).then((recreated) => {
      if (!recreated.ok || !recreated.worktreePath) {
        return {
          ok: false,
          reason: recreated.output || 'failed to recreate worktree from branch',
        }
      }
      return { ok: true, cwd: recreated.worktreePath }
    })
  }
}
