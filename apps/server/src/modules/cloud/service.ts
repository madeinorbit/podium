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

import { createLogger } from '@podium/logger'
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
  CloudRuntimeUserError,
  disabledCloudRuntimeProvider,
  toCloudAgentSourceSession,
} from '../../cloud-runtime'
import { harnessSupportsCloud } from '../../harness-manifest'
import type { RegistryModules, SessionRegistry } from '../../relay'
import { canonicalizeRepoOrigin } from '../../repo-id'
import type { RepoRegistry } from '../../repo-registry'
import { SESSION_NOT_FOUND, SessionGateRefusal } from '../sessions/session-access'

const log = createLogger('server:cloud')

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
  /**
   * The session `sessionId` names, read ONLY once the caller may command it: its
   * owner, through the session commands' own target gate (POD-7606). `undefined`
   * for a session that does not exist and for one that is not the caller's
   * alike, so the move is no existence oracle. A refusal past the owner check
   * (an agent's issue scope, machine `use` on the session's host) throws.
   */
  readonly commandableSession: (
    sessionId: SessionId,
    proc: CloudSessionProc,
  ) => Promise<CloudSourceSession | undefined>
  readonly repos: RepoRegistry
  readonly store: SessionRegistry['sessionStore']
  /**
   * Park the local session once its runtime exists, as the caller: a
   * `records.session` edit (`desired: hibernated`) on the sync write entry point
   * (ADR 12 D5 E1, POD-6417). The session controller acts after that commit.
   */
  readonly hibernateLocal: (sessionId: SessionId) => Promise<{ ok: boolean; reason?: string }>
}

/** The commands that read a session through the gate, named to its scope check. */
export type CloudSessionProc = 'cloud.moveSession' | 'cloud.createAgent'

/** The session row a move reads: the sessions service's own by-id type. */
export type CloudSourceSession = NonNullable<
  Awaited<ReturnType<RegistryModules['sessions']['sessionById']>>
>

/** A provisioning request as a command builds it: everything but the tenant,
 *  which the service adds from the bound workspace. */
export type CloudMachineInput = Omit<CloudMachineRequest, 'tenantId'>
export type CloudAgentInput = Omit<CloudAgentRequest, 'tenantId'>

/** What a caller may say about the session a new agent is seeded from. Only the
 *  id picks the session; the rest must agree with its row (see `sourceOf`). */
type StatedSourceSession = NonNullable<CloudAgentInput['sourceSession']>

/** Refusals written here or explicitly authored for users by a provider may
 * cross the cloud boundary. An arbitrary provider TRPCError remains a fault. */
class CloudRefusal extends TRPCError {}

export const CLOUD_REQUEST_FAILED = 'cloud request failed; try again'
export const CLOUD_HIBERNATE_FAILED =
  'cloud runtime created; hibernate the local session separately'

/** The one answer a failed read beneath the session gate gives the caller. */
export const CLOUD_SESSION_READ_FAILED = 'could not read the session; try again'

/** Keep the full error (including its causes) in the server log only. The
 * reference joins a caller's report to that log without exposing the cause
 * through tRPC's `data.causeChain`. */
function cloudFailure(
  error: unknown,
  operation: string,
  message = CLOUD_REQUEST_FAILED,
  code: 'INTERNAL_SERVER_ERROR' | 'PRECONDITION_FAILED' = 'INTERNAL_SERVER_ERROR',
): never {
  const correlationId = crypto.randomUUID()
  log.error('cloud operation failed', { operation, correlationId, err: error })
  throw new CloudRefusal({
    code,
    message: `${message} (reference: ${correlationId})`,
  })
}

function cloudError(error: unknown, operation: string): never {
  if (error instanceof CloudRefusal) throw error
  if (error instanceof CloudRuntimeUserError) {
    throw new CloudRefusal({ code: error.code, message: error.message })
  }
  cloudFailure(error, operation)
}

/** An unknown runtime id and another workspace's fail alike (the contract's
 *  D20.2 note), so the id space cannot be iterated. */
const runtimeNotFound = () =>
  new CloudRefusal({ code: 'NOT_FOUND', message: 'cloud runtime not found' })

export class CloudService {
  private readonly provider: CloudRuntimeProvider

  constructor(private readonly deps: CloudServiceDeps) {
    this.provider = deps.provider ?? disabledCloudRuntimeProvider
  }

  async capabilities() {
    try {
      return await this.provider.capabilities()
    } catch (error) {
      cloudError(error, 'cloud.capabilities')
    }
  }

  /** A runtime of the bound workspace, or null: another workspace's runtime
   *  reads as absent, exactly like an unknown id. */
  async getRuntime(id: string): Promise<CloudRuntime | null> {
    if (this.provider === disabledCloudRuntimeProvider) return null
    try {
      const tenantId = this.tenant()
      const runtime = await this.provider.getRuntime(id)
      return runtime !== null && runtime.tenantId === tenantId ? runtime : null
    } catch (error) {
      cloudError(error, 'cloud.runtime')
    }
  }

  async createCloudMachine(input: CloudMachineInput) {
    try {
      const tenantId = this.tenantOfConfiguredProvider()
      return this.owned(await this.provider.createCloudMachine({ ...input, tenantId }), tenantId)
    } catch (error) {
      cloudError(error, 'cloud.createMachine')
    }
  }

  /**
   * Provision a cloud agent. A `sourceSession` is gated FIRST, before anything
   * is read, forwarded or provisioned (POD-7612): it must be a session the
   * caller may command, which is its owner's alone, admin or not, exactly as
   * for `moveSession`. A session that is someone else's answers as one that
   * does not exist. What is forwarded is then built from the session's own row,
   * never from the caller's copy of it.
   */
  async createCloudAgent(input: CloudAgentInput) {
    const { sourceSession: stated, ...rest } = input
    const sourceSession = stated === undefined ? undefined : await this.sourceOf(stated)
    try {
      const tenantId = this.tenantOfConfiguredProvider()
      return this.owned(
        await this.provider.createCloudAgent({
          ...rest,
          ...(sourceSession ? { sourceSession } : {}),
          tenantId,
        }),
        tenantId,
      )
    } catch (error) {
      cloudError(error, 'cloud.createAgent')
    }
  }

  async stopRuntime(id: string) {
    try {
      const tenantId = await this.ownRuntimeId(id)
      return this.owned(await this.provider.stopRuntime(id), tenantId)
    } catch (error) {
      cloudError(error, 'cloud.stop')
    }
  }

  async wakeRuntime(id: string) {
    try {
      const tenantId = await this.ownRuntimeId(id)
      return this.owned(await this.provider.wakeRuntime(id), tenantId)
    } catch (error) {
      cloudError(error, 'cloud.wake')
    }
  }

  /** The bound workspace, as the provider's tenant. */
  private tenant(): WorkspaceId {
    if (this.deps.workspace === undefined) {
      throw new Error('cloud commands need a request bound to a workspace')
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
      throw new Error('cloud provider answered with a runtime of another workspace')
    }
    return runtime
  }

  /**
   * Lift a local session onto a cloud runtime.
   *
   * THE ORDER IS THE BEHAVIOUR and is preserved exactly:
   *
   *  1. resolve the session the caller may command, or NOT_FOUND: its owner
   *     only, and one answer for a session that is missing and one that is
   *     someone else's (POD-7606);
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
    const session = await this.commandable(input.sessionId, 'cloud.moveSession')
    if (!session) {
      throw new CloudRefusal({ code: 'NOT_FOUND', message: SESSION_NOT_FOUND })
    }
    const agent = this.cloudAgentKind(session.agentKind)
    if (!session.resume?.value) {
      throw new CloudRefusal({ code: 'PRECONDITION_FAILED', message: 'session has no resume ref' })
    }
    if (input.hibernateLocal) {
      if (session.status !== 'live') {
        throw new CloudRefusal({
          code: 'PRECONDITION_FAILED',
          message: 'local session cannot be hibernated: not running',
        })
      }
      const phase = session.agentState?.phase
      if (phase === 'working' || phase === 'compacting') {
        throw new CloudRefusal({
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
        await this.hibernateAfterProvision(session.sessionId, runtime.id)
      }

      return runtime
    } catch (error) {
      cloudError(error, 'cloud.moveSession')
    }
  }

  /** Provisioning already succeeded. A failed park must name that runtime and
   * direct the caller to park locally, not repeat a move and create another. */
  private async hibernateAfterProvision(sessionId: SessionId, runtimeId: string): Promise<void> {
    const message = `${CLOUD_HIBERNATE_FAILED} (runtime: ${runtimeId})`
    let parked: Awaited<ReturnType<CloudServiceDeps['hibernateLocal']>>
    try {
      parked = await this.deps.hibernateLocal(sessionId)
    } catch (error) {
      cloudFailure(error, 'cloud.moveSession', message)
    }
    if (!parked.ok) {
      cloudFailure(
        new Error(parked.reason ?? 'local session could not be hibernated'),
        'cloud.moveSession',
        message,
        'PRECONDITION_FAILED',
      )
    }
  }

  /**
   * The session a new agent is seeded from, as the provider should see it: the
   * caller's own session, or NOT_FOUND (one answer for missing and foreign
   * alike), then built from its row as `moveSession` builds it. A field the
   * caller stated must agree with the row: the session is the caller's own by
   * now, so the refusal hides nothing, and it keeps a caller from pairing their
   * session's id with another machine or resume ref.
   */
  private async sourceOf(stated: StatedSourceSession) {
    const session = await this.commandable(stated.sessionId, 'cloud.createAgent')
    if (!session) {
      throw new CloudRefusal({ code: 'NOT_FOUND', message: SESSION_NOT_FOUND })
    }
    const source = toCloudAgentSourceSession({
      sessionId: session.sessionId,
      agent: this.cloudAgentKind(session.agentKind),
      resume: session.resume,
      cwd: session.cwd,
      ...(session.machineId ? { machineId: session.machineId } : {}),
    })
    for (const field of ['agent', 'resumeRef', 'cwd', 'machineId'] as const) {
      if (stated[field] !== undefined && stated[field] !== source[field]) {
        throw new CloudRefusal({
          code: 'BAD_REQUEST',
          message: `sourceSession.${field} does not match the session`,
        })
      }
    }
    return source
  }

  /**
   * The gate's own refusals past the owner check (an agent's scope, machine
   * `use`) as the FORBIDDEN they are, and its not-found, should the owner check
   * throw rather than answer, as the one not-found every refusal gives. Anything
   * else is a failed read beneath the gate (a store or driver error): its detail
   * goes to the server log, and the caller gets a generic internal error rather
   * than a permission refusal carrying the driver's text (POD-7612).
   */
  private async commandable(
    sessionId: SessionId,
    proc: CloudSessionProc,
  ): Promise<CloudSourceSession | undefined> {
    try {
      return await this.deps.commandableSession(sessionId, proc)
    } catch (error) {
      // The gate's typed refusals are written for the caller. Rebuild them so
      // even a refusal cannot carry a driver's cause into the formatter.
      if (error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR') {
        throw new CloudRefusal({ code: error.code, message: error.message })
      }
      if (error instanceof SessionGateRefusal) {
        if (error.message === SESSION_NOT_FOUND) return undefined
        throw new CloudRefusal({ code: 'FORBIDDEN', message: error.message })
      }
      cloudFailure(error, proc, CLOUD_SESSION_READ_FAILED)
    }
  }

  /** Capability lookup (#158): cloud-movable kinds are declared in their
   *  per-CLI manifests (claude-code, codex today), never hardcoded here. */
  private cloudAgentKind(agentKind: string): CloudAgentKind {
    if (isAgentKind(agentKind) && harnessSupportsCloud(agentKind))
      return agentKind as CloudAgentKind
    throw new CloudRefusal({
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
    session: CloudSourceSession,
  ): Promise<CloudRepoRequest> {
    const repoPath = await this.deps.repos.inferFromPath(session.cwd, session.machineId)
    if (!repoPath) {
      throw new CloudRefusal({
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
      throw new CloudRefusal({
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
