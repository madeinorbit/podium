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
 * Everything here is MOVED, not rewritten: the same checks in the same sequence
 * with the same TRPCError codes and messages. The migration's claim is that
 * nothing changed except where the logic lives, and a method that improved its
 * behaviour on the way past would make that claim unverifiable.
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

import { isAgentKind } from '@podium/model'
import { agentSupportsCloud } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import {
  type CloudAgentKind,
  type CloudRepoRequest,
  type CloudRuntimeProvider,
  CloudRuntimeUnavailableError,
  disabledCloudRuntimeProvider,
  toCloudAgentSourceSession,
} from '../../cloud-runtime'
import type { RegistryModules, SessionRegistry } from '../../relay'
import { normalizeOriginUrl } from '../../repo-id'
import type { RepoRegistry } from '../../repo-registry'

export interface CloudServiceDeps {
  /** Absent on deployments with no cloud provider; the disabled provider is
   *  substituted once here rather than at every call site. */
  readonly provider: CloudRuntimeProvider | undefined
  readonly sessions: RegistryModules['sessions']
  readonly repos: RepoRegistry
  readonly store: SessionRegistry['sessionStore']
}

/** The shipped mapping, moved verbatim: an unconfigured provider is a
 *  PRECONDITION, not an internal error. */
function cloudError(error: unknown): never {
  if (error instanceof CloudRuntimeUnavailableError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message })
  }
  throw error
}

export class CloudService {
  private readonly provider: CloudRuntimeProvider

  constructor(private readonly deps: CloudServiceDeps) {
    this.provider = deps.provider ?? disabledCloudRuntimeProvider
  }

  capabilities() {
    return this.provider.capabilities()
  }

  getRuntime(id: string) {
    return this.provider.getRuntime(id)
  }

  async createCloudMachine(input: Parameters<CloudRuntimeProvider['createCloudMachine']>[0]) {
    try {
      return await this.provider.createCloudMachine(input)
    } catch (error) {
      cloudError(error)
    }
  }

  async createCloudAgent(input: Parameters<CloudRuntimeProvider['createCloudAgent']>[0]) {
    try {
      return await this.provider.createCloudAgent(input)
    } catch (error) {
      cloudError(error)
    }
  }

  async stopRuntime(id: string) {
    try {
      return await this.provider.stopRuntime(id)
    } catch (error) {
      cloudError(error)
    }
  }

  async wakeRuntime(id: string) {
    try {
      return await this.provider.wakeRuntime(id)
    } catch (error) {
      cloudError(error)
    }
  }

  /**
   * Lift a local session onto a cloud runtime.
   *
   * THE ORDER IS THE BEHAVIOUR and is preserved exactly:
   *
   *  1. resolve the session, or NOT_FOUND;
   *  2. check the agent kind can go to cloud (capability table, #158);
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
    sessionId: string
    tenantId: string
    size?: 'small' | 'medium' | 'large' | undefined
    repo?: CloudRepoRequest | undefined
    hibernateLocal?: boolean | undefined
  }) {
    const session = this.deps.sessions.listSessions().find((s) => s.sessionId === input.sessionId)
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
      const runtime = await this.provider.createCloudAgent({
        tenantId: input.tenantId,
        displayName: session.name?.trim() || session.title || `${agent} session`,
        ...(input.size ? { size: input.size } : {}),
        repo: input.repo ?? this.inferCloudRepoForSession(session),
        ...(session.issueId ? { issueId: session.issueId } : {}),
        purpose: 'move-session',
        sourceSession: toCloudAgentSourceSession({
          sessionId: session.sessionId,
          agent,
          resume: session.resume,
          cwd: session.cwd,
          ...(session.machineId ? { machineId: session.machineId } : {}),
        }),
      })

      if (input.hibernateLocal) {
        const parked = this.deps.sessions.hibernateSession({ sessionId: session.sessionId })
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

  /** Capability lookup (#158): cloud-movable kinds are declared in the protocol
   *  capability table (claude-code, codex today), never hardcoded here. */
  private cloudAgentKind(agentKind: string): CloudAgentKind {
    if (isAgentKind(agentKind) && agentSupportsCloud(agentKind)) return agentKind as CloudAgentKind
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
  private inferCloudRepoForSession(
    // The session row's OWN type, read off the service rather than restated as a
    // structural shape. The first draft wrote `{ cwd?: string }` and tsgo caught
    // it: `inferFromPath` takes a required path, so a looser local shape would
    // have been a second, wrong declaration of what a session is.
    session: ReturnType<RegistryModules['sessions']['listSessions']>[number],
  ): CloudRepoRequest {
    const repoPath = this.deps.repos.inferFromPath(session.cwd, session.machineId)
    if (!repoPath) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'session cwd is not inside a registered repo; pass repo explicitly',
      })
    }

    const repoRow =
      this.deps.store.repos.listRepos(session.machineId).find((row) => row.path === repoPath) ??
      this.deps.store.repos.listRepos().find((row) => row.path === repoPath)
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
  const normalized = normalizeOriginUrl(originUrl)
  const match = normalized?.match(/^github\.com\/([^/]+)\/([^/]+)$/)
  const owner = match?.[1]
  const name = match?.[2]
  if (!owner || !name) return null
  return { provider: 'github', owner, name }
}
