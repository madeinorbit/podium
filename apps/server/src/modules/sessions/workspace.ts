import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { AgentKind, repoNameFromOrigin, type SessionId, type UserId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import type { SessionStore } from '../../store'
import type { DurableIssueAccessIndex } from '../issues/access-index'
import type { DaemonRpcService } from '../machines/rpc'
import type { MachinesService, MachineUseResolver } from '../machines/service'
import {
  transferHandoffPackage,
  verifiedBundleBases,
  verifiedCommonBundleBases,
} from './handoff-transfer'
import type { Session } from './session'
import type { SessionIssueWorkflowPort } from './issue-workflow-port'

type SessionLookup = (sessionId: SessionId) => Session | undefined

export interface SessionWorkspacePorts {
  store: SessionStore
  rpc: DaemonRpcService
  machines: MachinesService
  issueAccess: DurableIssueAccessIndex
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
      : resolveRole(this.ports.store.settings.getSettingsFor(this.ports.settingsViewer()), 'coding')
          .harness
    this.ports.machines.resolveMachineForAgent(input.machineId, input.cwd, agentKind, input.use)
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

  /**
   * The repository at `sourceRepoPath`, as `targetMachineId` has it — cloned there
   * if it has none. Returns the TARGET's checkout path (POD-1386).
   *
   * This is `prepareTarget`'s first half, exposed for callers that place a
   * REPOSITORY rather than a session cwd — `issues.start` with a machine pin.
   * Sharing it is the point: handoff resolves the target repo by `repoId` and
   * clones on absence, while issue start used to compare the source path
   * literally against the target's registered paths and refuse. Two machines have
   * two layouts, so that predicate refused on every correctly-configured second
   * machine. One resolver, not two.
   *
   * Same machine in and out is a no-op returning the source path, so a caller does
   * not have to ask whether a move is needed.
   */
  async resolveRepoOnMachine(sourceRepoPath: string, targetMachineId: string): Promise<string> {
    const sourceRepo = this.ports.store.repos
      .listRepos()
      .filter((repo) => sourceRepoPath === repo.path || sourceRepoPath.startsWith(`${repo.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!sourceRepo) throw new Error(`no registered repository contains ${sourceRepoPath}`)
    if (sourceRepo.machineId === targetMachineId) return sourceRepo.path
    const target = await this.ensureTargetRepo(sourceRepo, targetMachineId)
    return target.path
  }

  /**
   * MAKE `ref` RESOLVABLE ON `targetMachineId` (POD-1405) — the second of the two
   * faults behind POD-1386.
   *
   * A machine-pinned start hands `worktree add <path> <startPoint>` to the target,
   * and a start point it cannot resolve fails. `resolveRepoOnMachine` already puts
   * the right REPOSITORY there; this puts the right COMMITS in it.
   *
   * CLONE-PLUS-FETCH IS NOT SUFFICIENT, and that is the whole reason this exists:
   * our integration branches never reach origin, so no amount of fetching from a
   * shared remote can produce them. The objects have to move machine-to-machine.
   *
   * ONE MECHANISM, NOT A SECOND TRANSFER. Every step here already existed:
   * `revParseVerify` asks what the target has, `verifiedCommonBundleBases` takes
   * the intersection the source can actually bundle from, and
   * `transferHandoffPackage` is the same chunked source->server->target pipe
   * handoff and workspace-fetch use — this is its third caller. Only the two
   * bundle verbs are new, and they are transport primitives rather than a policy.
   *
   * IT VERIFIES RATHER THAN ASSUMES. The ref is re-checked on the target AFTER the
   * fetch, so a bundle that transferred but did not apply is a failure here rather
   * than a confusing `worktree add` error later. An early return when the target
   * already has the ref makes the common case free.
   */
  async ensureRefOnMachine(input: {
    targetMachineId: string
    targetRepoPath: string
    /** The start point a worktree will be created from — a branch name or sha. */
    ref: string
    /** Refs the target plausibly shares, cheapest first. Intersected, never trusted. */
    baseCandidates?: string[]
  }): Promise<void> {
    const { rpc } = this.ports
    // WHICH MACHINE HAS THE COMMITS. Found here rather than passed in, because by
    // the time an issue start calls this its own `repoPath` has already been
    // rehomed onto the target — so a caller threading "the source" through would
    // be threading the value this just overwrote. The source is whichever OTHER
    // machine holds a checkout of the same repository.
    const targetRepo = this.ports.store.repos
      .listRepos(input.targetMachineId)
      .find((repo) => repo.path === input.targetRepoPath)
    const source = targetRepo?.repoId
      ? this.ports.store.repos
          .listRepos()
          .find(
            (repo) => repo.repoId === targetRepo.repoId && repo.machineId !== input.targetMachineId,
          )
      : undefined
    if (!source) return
    const sourceRepoPath = source.path
    const sourceMachineId = source.machineId
    if (sourceMachineId === input.targetMachineId) return
    const already = await rpc.repoOp(
      'revParseVerify',
      input.targetRepoPath,
      { ref: input.ref },
      input.targetMachineId,
    )
    if (already.ok) return

    // What the target can prove it holds, intersected with what the source can
    // bundle FROM. `git bundle create ^<sha>` aborts on a base the source does
    // not know, so the intersection is a correctness requirement, not a saving.
    const candidates = [...new Set([...(input.baseCandidates ?? []), 'main', 'origin/main'])]
    const sourceVerified = await Promise.all(
      candidates.map((ref) =>
        rpc.repoOp('revParseVerify', sourceRepoPath, { ref }, sourceMachineId),
      ),
    )
    const targetVerified = await Promise.all(
      verifiedBundleBases(sourceVerified).map((ref) =>
        rpc.repoOp('revParseVerify', input.targetRepoPath, { ref }, input.targetMachineId),
      ),
    )
    const bases = verifiedCommonBundleBases(sourceVerified, targetVerified)

    // A NAME, NOT A PATH. The daemons derive the location from this token inside
    // their own stage dirs, so neither end takes a filesystem path from here.
    const token = `ref-${randomUUID().slice(0, 13)}` as const
    const created = await rpc.repoOp(
      'bundleCreate',
      sourceRepoPath,
      { token, ref: input.ref, bases: bases.join(',') },
      sourceMachineId,
    )
    if (!created.ok) throw new Error(`could not bundle ${input.ref} on the source: ${created.output}`)
    // "<sizeBytes>\t<stagePath>" — the path is the SOURCE daemon's own, echoed
    // back exactly as the handoff export echoes its `stagePath`. Only that daemon
    // knows its home directory; a path computed here would be a guess about a
    // filesystem this process cannot see.
    const [rawSize, sourceStagePath] = created.output.split('\t')
    const sizeBytes = Number(rawSize)
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !sourceStagePath) {
      throw new Error(`source reported an unusable bundle for ${input.ref}: ${created.output}`)
    }

    await transferHandoffPackage({
      rpc,
      sessionId: token,
      sourceMachineId,
      targetMachineId: input.targetMachineId,
      sourceStagePath,
      sizeBytes,
    })

    const fetched = await rpc.repoOp(
      'bundleFetch',
      input.targetRepoPath,
      { token, ref: input.ref },
      input.targetMachineId,
    )
    if (!fetched.ok) {
      throw new Error(`target could not apply the bundle for ${input.ref}: ${fetched.output}`)
    }
    const settled = await rpc.repoOp(
      'revParseVerify',
      input.targetRepoPath,
      { ref: input.ref },
      input.targetMachineId,
    )
    if (!settled.ok) {
      throw new Error(
        `${input.ref} is still unresolvable on the target after its bundle was applied`,
      )
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

    const issue = source.issueId ? this.ports.issueAccess.getMeta(source.issueId) : undefined
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
    issues: SessionIssueWorkflowPort,
  ):
    | { ok: boolean; reason?: string; cwd?: string }
    | Promise<{ ok: boolean; reason?: string; cwd?: string }> {
    const issueId = session.issueId ?? this.ports.issueAccess.issueForCwd(session.cwd)
    if (!issueId) return { ok: true, cwd: session.cwd }
    const issue = this.ports.issueAccess.getMeta(issueId)
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
