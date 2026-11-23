/**
 * THE CLOUD SERVICE (POD-314) — the home for the ~150 lines of `moveSession`
 * logic that used to sit inline in `router.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG WITH IT BEING IN THE ROUTER
 * ---------------------------------------------------------------------------
 *
 * Not its length. `cloud.moveSession` resolved a session, decided whether the
 * agent kind could go to cloud, enforced two hibernation preconditions, inferred
 * a GitHub repo from the session's cwd by walking the repo registry, provisioned
 * a runtime and then parked the local session — six decisions, none of them
 * transport concerns, in a procedure body no test could reach without standing up
 * a tRPC caller. `router.ts` was the only place that knew the ORDER those
 * decisions run in, and the order is load-bearing (see `moveSession` below).
 *
 * Everything here was MOVED, not rewritten: the same checks in the same sequence
 * with the same TRPCError codes and messages. The migration's claim is that
 * nothing changed except where the logic lives, and a method that improved its
 * behaviour on the way past would make that claim unverifiable.
 *
 * ---------------------------------------------------------------------------
 * THE TENANT IS THE BOUND WORKSPACE (ADR 13, POD-7310)
 * ---------------------------------------------------------------------------
 *
 * The one change since the move. The provider's tenant is the workspace the edge
 * bound the request to, never a client field, and the provider holds ONE
 * credential for every tenant, so it cannot tell workspaces apart for us. Hence:
 * provisioning sends the bound workspace as `tenantId`; a runtime id is looked
 * up and must belong to the bound workspace before stop or wake reaches the
 * provider; a runtime read of another workspace answers null like an unknown id;
 * and a provider answer naming another tenant is refused.
 *
 * ---------------------------------------------------------------------------
 * THE PROVIDER IS INJECTED, AND ITS ABSENCE IS A VALUE RATHER THAN A NULL
 * ---------------------------------------------------------------------------
 *
 * `ctx.cloud` is optional — most deployments have no cloud provider — and the
 * shipped router substituted `disabledCloudRuntimeProvider` at every call site.
 * That substitution happens once, at construction, so no method here has to
 * remember it. The disabled provider throws `CloudRuntimeUnavailableError`, which
 * `cloudError` maps to PRECONDITION_FAILED: the surface stays present and
 * refuses honestly rather than 404-ing, which is what makes the contract's
 * "unauthorized stays distinguishable from unreachable" true.
 */

import { isAgentKind, type SessionId, type WorkspaceId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import {
  type CloudAgentKind,
  type CloudAgentRequest,
  type CloudMachineRequest,
  type CloudRepoRequest,
  type CloudRuntime,
  type CloudRuntimeProvider,
  CloudRuntimeUnavailableError,
  disabledCloudRuntimeProvider,
  toCloudAgentSourceSession,
} from '../../cloud-runtime'
import { harnessSupportsCloud } from '../../harness-manifest'
import type { RegistryModules, SessionRegistry } from '../../relay'
import { canonicalizeRepoOrigin } from '../../repo-id'
import type { RepoRegistry } from '../../repo-registry'

export interface CloudServiceDeps {
  /** Absent on deployments with no cloud provider; the disabled provider is
   *  substituted once here rather than at every call site. */
  readonly provider: CloudRuntimeProvider | undefined
  /**
   * The workspace the edge bound this request to: the provider's TENANT for
   * every call (ADR 13, POD-7310). No input names a tenant. Absent only for a
   * caller that is not a request, and then every command and runtime read
   * refuses rather than guess one.
   */
  readonly workspace: WorkspaceId | undefined
  readonly sessions: RegistryModules['sessions']
  readonly repos: RepoRegistry
  readonly store: SessionRegistry['sessionStore']
  /**
   * Park the local session once its runtime exists, as the caller: a
   * `records.session` edit (`desired: hibernated`) on the sync write entry point
   * (ADR 12 D5 E1, POD-6417). The session controller acts after that commit.
   */
  readonly hibernateLocal: (sessionId: SessionId) => Promise<{ ok: boolean; reason?: string }>
}

/** A provisioning request as a command builds it: everything but the tenant,
 *  which the service adds from the bound workspace. */
export type CloudMachineInput = Omit<CloudMachineRequest, 'tenantId'>
export type CloudAgentInput = Omit<CloudAgentRequest, 'tenantId'>

/** The shipped mapping, moved verbatim: an unconfigured provider is a
 *  PRECONDITION, not an internal error. */
function cloudError(error: unknown): never {
  if (error instanceof CloudRuntimeUnavailableError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message })
  }
  throw error
}

/** An unknown runtime id and another workspace's fail alike (the contract's
 *  D20.2 note), so the id space cannot be iterated. */
const runtimeNotFound = () =>
  new TRPCError({ code: 'NOT_FOUND', message: 'cloud runtime not found' })

export class CloudService {
  private readonly provider: CloudRuntimeProvider

  constructor(private readonly deps: CloudServiceDeps) {
    this.provider = deps.provider ?? disabledCloudRuntimeProvider
  }

  async capabilities() {
    return await this.provider.capabilities()
  }

  /** A runtime of the bound workspace, or null: another workspace's runtime
   *  reads as absent, exactly like an unknown id. */
  async getRuntime(id: string): Promise<CloudRuntime | null> {
    if (this.provider === disabledCloudRuntimeProvider) return null
    const tenantId = this.tenant()
    const runtime = await this.provider.getRuntime(id)
    return runtime !== null && runtime.tenantId === tenantId ? runtime : null
  }

  async createCloudMachine(input: CloudMachineInput) {
    try {
      const tenantId = this.tenantOfConfiguredProvider()
      return this.owned(await this.provider.createCloudMachine({ ...input, tenantId }), tenantId)
    } catch (error) {
      cloudError(error)
    }
  }

  async createCloudAgent(input: CloudAgentInput) {
    try {
      const tenantId = this.tenantOfConfiguredProvider()
      return this.owned(await this.provider.createCloudAgent({ ...input, tenantId }), tenantId)
    } catch (error) {
      cloudError(error)
    }
  }

  async stopRuntime(id: string) {
    try {
      const tenantId = await this.ownRuntimeId(id)
      return this.owned(await this.provider.stopRuntime(id), tenantId)
    } catch (error) {
      cloudError(error)
    }
  }

  async wakeRuntime(id: string) {
    try {
      const tenantId = await this.ownRuntimeId(id)
      return this.owned(await this.provider.wakeRuntime(id), tenantId)
    } catch (error) {
      cloudError(error)
    }
  }

  /** The bound workspace, as the provider's tenant. */
  private tenant(): WorkspaceId {
    if (this.deps.workspace === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'cloud commands need a request bound to a workspace',
      })
    }
    return this.deps.workspace
  }

  /** The tenant for an act on the provider. An unconfigured provider refuses as
   *  unconfigured first, as it did before the tenant came from the binding: with
   *  no provider there is no runtime to protect, and "not configured" is the
   *  actionable answer. */
  private tenantOfConfiguredProvider(): WorkspaceId {
    if (this.provider === disabledCloudRuntimeProvider) throw new CloudRuntimeUnavailableError()
    return this.tenant()
  }

  /**
   * Check that `id` names a runtime of the bound workspace BEFORE the provider
   * is asked to act on it. The provider's one credential serves every tenant, so
   * this check, not the provider, is what keeps a member of one workspace off
   * another's runtime.
   */
  private async ownRuntimeId(id: string): Promise<WorkspaceId> {
    const tenantId = this.tenantOfConfiguredProvider()
    const runtime = await this.provider.getRuntime(id)
    if (runtime === null || runtime.tenantId !== tenantId) throw runtimeNotFound()
    return tenantId
  }

  /** A runtime the provider answered with must be the bound workspace's; any
   *  other answer is refused rather than shown to this workspace. */
  private owned(runtime: CloudRuntime, tenantId: WorkspaceId): CloudRuntime {
    if (runtime.tenantId !== tenantId) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'cloud provider answered with a runtime of another workspace',
      })
    }
    return runtime
  }

  /**
   * Lift a local session onto a cloud runtime.
   *
   * THE ORDER IS THE BEHAVIOUR and is preserved exactly:
   *
   *  1. resolve the session, or NOT_FOUND;
   *  2. check the manifest says the agent kind can go to cloud (#158);
   *  3. require a resume ref — a session with no resume cannot be reconstituted
   *     anywhere, so moving it would silently lose it;
   *  4. if hibernating, check the LOCAL session can be parked BEFORE provisioning
   *     anything: it must be live, and its agent must not be mid-turn;
   *  5. provision the runtime;
   *  6. only then hibernate the local session.
   *
   * Steps 4 and 6 are deliberately not merged. Checking early means a session
   * that cannot be parked never causes a billed runtime to be created; parking
   * late means a provisioning failure never leaves the user with a hibernated
   * session and nowhere for it to have gone. Both halves are needed and the
   * router had them in exactly this arrangement.
   */
  async moveSession(input: {
    sessionId: SessionId
    size?: 'small' | 'medium' | 'large' | undefined
    repo?: CloudRepoRequest | undefined
    hibernateLocal?: boolean | undefined
  }) {
    const session = await this.deps.sessions.sessionById(input.sessionId as SessionId)
    if (!session) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'session not found' })
    }
    const agent = this.cloudAgentKind(session.agentKind)
    if (!session.resume?.value) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'session has no resume ref' })
    }
    if (input.hibernateLocal) {
      if (session.status !== 'live') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'local session cannot be hibernated: not running',
        })
      }
      const phase = session.agentState?.phase
      if (phase === 'working' || phase === 'compacting') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'local session cannot be hibernated: agent is working',
        })
      }
    }

    try {
      const tenantId = this.tenantOfConfiguredProvider()
      const runtime = this.owned(
        await this.provider.createCloudAgent({
          tenantId,
          displayName: session.name?.trim() || session.title || `${agent} session`,
          ...(input.size ? { size: input.size } : {}),
          repo: input.repo ?? (await this.inferCloudRepoForSession(session)),
          ...(session.issueId ? { issueId: session.issueId } : {}),
          purpose: 'move-session',
          sourceSession: toCloudAgentSourceSession({
            sessionId: session.sessionId,
            agent,
            resume: session.resume,
            cwd: session.cwd,
            ...(session.machineId ? { machineId: session.machineId } : {}),
          }),
        }),
        tenantId,
      )

      if (input.hibernateLocal) {
        const parked = await this.deps.hibernateLocal(session.sessionId)
        if (!parked.ok) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `local session could not be hibernated: ${parked.reason ?? 'unknown reason'}`,
          })
        }
      }

      return runtime
    } catch (error) {
      cloudError(error)
    }
  }

  /** Capability lookup (#158): cloud-movable kinds are declared in their
   *  per-CLI manifests (claude-code, codex today), never hardcoded here. */
  private cloudAgentKind(agentKind: string): CloudAgentKind {
    if (isAgentKind(agentKind) && harnessSupportsCloud(agentKind))
      return agentKind as CloudAgentKind
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `agent kind ${agentKind} cannot be moved to cloud yet`,
    })
  }

  /**
   * Infer the GitHub repo a session's cwd belongs to. Two refusals, both
   * PRECONDITION_FAILED and both naming the fix ("pass repo explicitly"), moved
   * verbatim: the cwd may not be inside a registered repo at all, or the repo may
   * be registered without a GitHub origin — a cloud runtime clones from a forge,
   * so a local-only repo genuinely cannot be moved.
   */
  private async inferCloudRepoForSession(
    // The session row's OWN type, read off the service rather than restated as a
    // structural shape. The first draft wrote `{ cwd?: string }` and tsgo caught
    // it: `inferFromPath` takes a required path, so a looser local shape would
    // have been a second, wrong declaration of what a session is.
    session: Awaited<ReturnType<RegistryModules['sessions']['listSessions']>>[number],
  ): Promise<CloudRepoRequest> {
    const repoPath = await this.deps.repos.inferFromPath(session.cwd, session.machineId)
    if (!repoPath) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'session cwd is not inside a registered repo; pass repo explicitly',
      })
    }

    const repoRow =
      (await this.deps.store.repos.listRepos(session.machineId)).find(
        (row) => row.path === repoPath,
      ) ?? (await this.deps.store.repos.listRepos()).find((row) => row.path === repoPath)
    const repo = githubRepoFromOrigin(repoRow?.originUrl)
    if (!repo) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'registered repo has no GitHub origin; pass repo explicitly',
      })
    }
    return repo
  }
}

/** origin URL → `{ provider, owner, name }`, or null when it is not a GitHub
 *  remote. Moved verbatim from `router.ts`. */
function githubRepoFromOrigin(originUrl: string | null | undefined): CloudRepoRequest | null {
  const normalized = canonicalizeRepoOrigin(originUrl)
  const match = normalized?.match(/^github\.com\/([^/]+)\/([^/]+)$/)
  const owner = match?.[1]
  const name = match?.[2]
  if (!owner || !name) return null
  return { provider: 'github', owner, name }
}
